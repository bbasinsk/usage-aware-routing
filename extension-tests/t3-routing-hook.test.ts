import { describe, expect, test } from "bun:test";
import { normalizeUsage } from "../lib/usage-routing.ts";
import { contextVersion, routingContext } from "../t3/routing-hook.ts";

const NOW = Date.UTC(2026, 10, 23, 12);
const HOUR = 60 * 60 * 1000;
const balanced = { version: 1 as const, mode: "balanced" as const, updatedAt: NOW };

const snapshot = normalizeUsage({
  reports: [
    {
      provider: "anthropic",
      limits: [
        {
          id: "anthropic:7d",
          label: "Claude 7 Day",
          scope: { provider: "anthropic" },
          window: { durationMs: 100 * HOUR, resetsAt: NOW + 60 * HOUR },
          amount: { usedFraction: 0.6, remainingFraction: 0.4 },
          status: "ok",
        },
        {
          id: "anthropic:7d:fable",
          label: "Claude 7 Day (Fable)",
          scope: { provider: "anthropic", tier: "fable" },
          window: { durationMs: 100 * HOUR, resetsAt: NOW + 60 * HOUR },
          amount: { usedFraction: 0, remainingFraction: 1 },
          status: "ok",
        },
      ],
    },
    {
      provider: "openai-codex",
      limits: [{
        id: "openai-codex:primary",
        label: "7 days",
        scope: { provider: "openai-codex" },
        window: { durationMs: 100 * HOUR, resetsAt: NOW + 60 * HOUR },
        amount: { usedFraction: 0.1, remainingFraction: 0.9 },
        status: "ok",
      }],
    },
  ],
}, NOW);

describe("T3 routing hook", () => {
  test("ranks T3 provider routes and keeps balanced advice advisory", () => {
    const context = routingContext(snapshot, balanced, NOW)!;
    const order = context.split("\n").find(line => line.startsWith("Balanced route order"))!;

    // Codex is ahead of pace; Claude is 20% behind. Fable also bills the shared Claude window.
    expect(order.indexOf("codex (gpt) [openai-codex/Chat")).toBeLessThan(order.indexOf("claude (opus, sonnet, haiku) [anthropic/shared"));
    expect(order).toContain("claude-fable [anthropic/shared+tier=fable: 20.0% deficit");
    // No Spark window exists, so the Spark route is left out instead of guessed.
    expect(order).not.toContain("codex-spark");

    expect(context).toContain("delegate_task");
    expect(context).toContain("advisory");
    expect(context).not.toContain("rejected before spawning");
  });

  test("states targeted mode without claiming a guard T3 does not run", () => {
    const targeted = { version: 1 as const, mode: "targeted" as const, provider: "anthropic", updatedAt: NOW };
    const context = routingContext(snapshot, targeted, NOW)!;
    expect(context).toContain("Active strategy: targeted (anthropic)");
    expect(context).not.toContain("rejected before spawning");
  });

  test("quality mode omits quota data, and no snapshot adds nothing", () => {
    const quality = { version: 1 as const, mode: "quality" as const, updatedAt: NOW };
    expect(routingContext(undefined, quality, NOW)).toContain("Active strategy: quality");
    expect(routingContext(undefined, balanced, NOW)).toBeUndefined();
  });

  test("context version changes only on refresh or strategy change", () => {
    const refreshed = { ...snapshot, refreshedAt: NOW + HOUR };
    expect(contextVersion(snapshot, balanced)).toBe(contextVersion({ ...snapshot }, balanced));
    expect(contextVersion(refreshed, balanced)).not.toBe(contextVersion(snapshot, balanced));
    expect(contextVersion(snapshot, { ...balanced, updatedAt: NOW + 1 })).not.toBe(contextVersion(snapshot, balanced));
  });
});
