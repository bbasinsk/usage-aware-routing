import { describe, expect, test } from "bun:test";
import { contextVersion, normalizeT3Usage, routingContext } from "../t3/routing-hook.ts";

const NOW = Date.UTC(2026, 10, 23, 12);
const HOUR = 60 * 60 * 1000;
const WEEK_MINS = 7 * 24 * 60;
const iso = (ms: number) => new Date(ms).toISOString();
const balanced = { version: 1 as const, mode: "balanced" as const, updatedAt: NOW };

// Shaped like the `usageLimits` sections in ~/.t3/caches/<instance>.json.
const meters = {
  claudeAgent: {
    checkedAt: iso(NOW - 60_000),
    windows: [
      { id: "seven_day", kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS, usedPercent: 60, resetsAt: iso(NOW + 84 * HOUR) },
      { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", windowDurationMins: WEEK_MINS, usedPercent: 0, resetsAt: iso(NOW + 84 * HOUR) },
    ],
  },
  codex: {
    checkedAt: iso(NOW - 60_000),
    windows: [{ id: "primary", kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS, usedPercent: 10, resetsAt: iso(NOW + 84 * HOUR) }],
    resetCredits: { availableCount: 2 },
  },
  antigravity: {
    checkedAt: iso(NOW - 72 * HOUR),
    windows: [
      { id: "3p-weekly", kind: "weekly", label: "Claude & GPT (shared) · Weekly", usedPercent: 0, windowDurationMins: WEEK_MINS },
      { id: "gemini-weekly", kind: "weekly", label: "Gemini · Weekly", usedPercent: 0, windowDurationMins: WEEK_MINS },
    ],
  },
  opencode: { checkedAt: iso(NOW), windows: [], unavailable: { reason: "unsupported" } },
};

describe("T3 routing hook", () => {
  const snapshot = normalizeT3Usage(meters, NOW);

  test("reads T3 meters per provider instance", () => {
    expect(snapshot.windows.map(window => window.id)).toEqual([
      "antigravity:3p-weekly",
      "antigravity:gemini-weekly",
      "claudeAgent:seven_day",
      "claudeAgent:seven_day_fable",
      "codex:primary",
    ]);
    expect(snapshot.resetCredits).toEqual({ codex: 2 });
    expect(snapshot.windows.find(window => window.id === "claudeAgent:seven_day")!.remainingFraction).toBeCloseTo(0.4);
  });

  test("ranks model-family routes, with Antigravity billed apart from the Claude plan", () => {
    const context = routingContext(snapshot, balanced, NOW)!;
    const order = context.split("\n").find(line => line.startsWith("Balanced route order"))!;

    // Codex is ahead of pace; Claude is 10% behind; Antigravity has no reset time, so its pace is unknown.
    expect(order.indexOf("codex (gpt) [codex/primary")).toBeLessThan(order.indexOf("claudeAgent (opus, sonnet, haiku) [claudeAgent/seven_day:"));
    expect(order).toContain("claudeAgent (fable) [claudeAgent/seven_day+seven_day_fable: 10.0% deficit");
    expect(order).toContain("antigravity (gemini) [antigravity/gemini-weekly: pace unknown, 100.0% left]");
    expect(order).toContain("antigravity (claude, gpt-oss) [antigravity/3p-weekly: pace unknown, 100.0% left]");
    // No Spark meter exists, so the Spark route is left out instead of guessed.
    expect(order).not.toContain("codex (spark)");

    const antigravityRow = context.split("\n").find(line => line.startsWith("- antigravity [gemini-weekly]"))!;
    expect(antigravityRow).toContain("measured 3d0h ago, stale");
    expect(context).not.toContain("omp usage");
    expect(context).not.toContain("rejected before spawning");
  });

  test("translates a targeted OMP provider to its T3 instance", () => {
    const targeted = { version: 1 as const, mode: "targeted" as const, provider: "anthropic", updatedAt: NOW };
    const context = routingContext(snapshot, targeted, NOW)!;
    expect(context).toContain("Active strategy: targeted (claudeAgent)");
    expect(context.split("\n").find(line => line.startsWith("Targeted claudeAgent route order"))!)
      .toMatch(/^[^>]*claudeAgent/);
  });

  test("quality mode omits quota data, and no meters add nothing", () => {
    const quality = { version: 1 as const, mode: "quality" as const, updatedAt: NOW };
    expect(routingContext(snapshot, quality, NOW)).toContain("Active strategy: quality");
    expect(routingContext(normalizeT3Usage({}, NOW), balanced, NOW)).toBeUndefined();
  });

  test("context version changes when a meter moves or goes stale, not when time passes", () => {
    const later = normalizeT3Usage(meters, NOW + 60_000);
    expect(contextVersion(later, balanced, NOW + 60_000)).toBe(contextVersion(snapshot, balanced, NOW));

    const moved = normalizeT3Usage({ ...meters, codex: { ...meters.codex, windows: [{ ...meters.codex.windows[0], usedPercent: 11 }] } }, NOW);
    expect(contextVersion(moved, balanced, NOW)).not.toBe(contextVersion(snapshot, balanced, NOW));

    const muchLater = NOW + 31 * 60_000;
    expect(contextVersion(normalizeT3Usage(meters, muchLater), balanced, muchLater)).not.toBe(contextVersion(snapshot, balanced, NOW));
  });
});
