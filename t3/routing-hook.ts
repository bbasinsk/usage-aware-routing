// T3 Code hook: adds live quota context to Claude Code and Codex sessions.
//
// T3 runs each thread through the provider's own CLI, so user-level
// SessionStart and UserPromptSubmit hooks fire inside T3. Register this script
// for both events in ~/.claude/settings.json and ~/.codex/hooks.json.
//
// Quota comes from the usage meters T3 keeps for each provider instance in
// ~/.t3/caches/<instance>.json. T3 refreshes them; this hook only reads them.
//
// SessionStart (startup, resume, clear, compact) always adds the context.
// UserPromptSubmit adds it again only after a meter or the strategy changes,
// so a long session does not repeat the same block on every prompt.
//
// The hook only advises. It never blocks a session or a tool call, so the
// targeted strategy is advisory here.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type QuotaRoute,
  type QuotaStrategy,
  type RoutingStrategy,
  type RoutingSurface,
  type UsageSnapshot,
  type UsageWindow,
  QUALITY_INSTRUCTION,
  REFRESH_MS,
  buildRouteOrder,
  buildRoutingInstruction,
  readStrategy,
  writeJsonAtomically,
} from "../lib/usage-routing.ts";

const T3_CACHES_DIR = process.env.USAGE_ROUTING_T3_CACHES ?? join(homedir(), ".t3", "caches");
const SESSIONS_PATH = process.env.OMP_USAGE_ROUTING_T3_SESSIONS
  ?? join(homedir(), ".omp", "cache", "usage-routing-t3-sessions.json");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type RouteFamily = { name: string; billedBy: (windowId: string) => boolean };

/**
 * How each T3 provider instance bills its model families. An instance missing
 * here gets one route that every one of its meters bills.
 */
const ROUTE_FAMILIES: Readonly<Record<string, readonly RouteFamily[]>> = {
  claudeAgent: [
    { name: "claudeAgent (opus, sonnet, haiku)", billedBy: id => !id.includes("fable") },
    { name: "claudeAgent (fable)", billedBy: () => true },
  ],
  codex: [
    { name: "codex (gpt)", billedBy: id => !id.includes("spark") },
    { name: "codex (spark)", billedBy: id => id.includes("spark") },
  ],
  antigravity: [
    { name: "antigravity (gemini)", billedBy: id => id.includes("gemini") },
    { name: "antigravity (claude, gpt-oss)", billedBy: id => id.startsWith("3p") },
  ],
};

/** OMP provider ids, as a strategy set through OMP names them, to T3 provider instances. */
const T3_INSTANCE_FOR_OMP_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: "claudeAgent",
  "openai-codex": "codex",
  "google-antigravity": "antigravity",
};

export const T3_SURFACE: RoutingSurface = {
  sourceLine: () => "Usage comes from T3's own provider meters, which T3 refreshes. A row measured more than 30 minutes ago is marked stale. Do not read T3's cache files yourself.",
  routeSource: "Each route name starts with the T3 provider instance that delegate_task takes, followed by the model family it bills.",
  scopeNote: "Scope: each route lists the meters that bill it, joined with +. Antigravity bills its Gemini models and its Claude and GPT-OSS models to its own meters, apart from the Claude and Codex plans. Missing meters are unknown; never invent them.",
  guardsTargeted: false,
  guidance: [
    "In T3, choose a route when you start a subagent: the Agent tool's model for claudeAgent models, or delegate_task's provider and model for every other route.",
    "This quota context is the user's standing request to weigh quota when choosing a subagent model. A model the user or the project instructions name still wins.",
  ],
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "string" ? finite(Date.parse(value)) : undefined;
}

/** Converts T3's per-instance `usageLimits` into a snapshot. Instances without meters are skipped. */
export function normalizeT3Usage(meters: Record<string, unknown>, now = Date.now()): UsageSnapshot {
  const windows: UsageWindow[] = [];
  const resetCredits: Record<string, number> = {};
  for (const [instance, rawLimits] of Object.entries(meters)) {
    const limits = record(rawLimits);
    if (!limits || !Array.isArray(limits.windows)) continue;
    const fetchedAt = timestamp(limits.checkedAt);
    if (fetchedAt === undefined) continue;
    const credits = finite(record(limits.resetCredits)?.availableCount);
    if (credits !== undefined && credits > 0) resetCredits[instance] = Math.floor(credits);

    for (const rawWindow of limits.windows) {
      const window = record(rawWindow);
      const usedPercent = finite(window?.usedPercent);
      if (!window || typeof window.id !== "string" || usedPercent === undefined) continue;
      const usedFraction = Math.max(0, Math.min(1, usedPercent / 100));
      const durationMins = finite(window.windowDurationMins);
      windows.push({
        provider: instance,
        id: `${instance}:${window.id}`,
        label: typeof window.label === "string" ? window.label : window.id,
        scope: window.id,
        windowId: window.id,
        durationMs: durationMins === undefined ? undefined : durationMins * 60_000,
        resetsAt: timestamp(window.resetsAt),
        remainingFraction: 1 - usedFraction,
        usedFraction,
        status: usedFraction >= 1 ? "exhausted" : "ok",
        fetchedAt,
      });
    }
  }
  windows.sort((a, b) => a.provider.localeCompare(b.provider) || a.scope.localeCompare(b.scope));
  return { version: 5, refreshedAt: now, sourceGeneratedAt: now, windows, resetCredits };
}

/** Builds one route per model family, with the meters that bill it. */
export function t3Routes(snapshot: UsageSnapshot): QuotaRoute[] {
  const instances = [...new Set(snapshot.windows.map(window => window.provider))];
  return instances.flatMap(instance => {
    const meters = snapshot.windows.filter(window => window.provider === instance);
    const families = ROUTE_FAMILIES[instance] ?? [{ name: instance, billedBy: () => true }];
    return families.map(family => {
      const windows = meters.filter(window => family.billedBy(window.scope));
      return { name: family.name, provider: instance, scope: windows.map(window => window.scope).join("+"), windows };
    });
  });
}

/** A strategy set in OMP names OMP providers; translate it to T3 provider instances. */
function forT3(strategy: QuotaStrategy): QuotaStrategy {
  return strategy.mode === "targeted"
    ? { ...strategy, provider: T3_INSTANCE_FOR_OMP_PROVIDER[strategy.provider] ?? strategy.provider }
    : strategy;
}

export function routingContext(
  snapshot: UsageSnapshot,
  strategy: RoutingStrategy,
  now = Date.now(),
): string | undefined {
  if (strategy.mode === "quality") return QUALITY_INSTRUCTION;
  if (!snapshot.windows.length) return undefined;
  const t3Strategy = forT3(strategy);
  const routeOrder = buildRouteOrder(snapshot, t3Routes(snapshot), now, t3Strategy);
  return buildRoutingInstruction(snapshot, T3_SURFACE, t3Strategy, routeOrder, now);
}

/** Changes when the context says something new: a meter moved or went stale, or the strategy changed. */
export function contextVersion(snapshot: UsageSnapshot, strategy: RoutingStrategy, now = Date.now()): string {
  const strategyKey = strategy.mode === "targeted"
    ? `targeted:${strategy.provider}:${strategy.updatedAt}`
    : `${strategy.mode}:${strategy.updatedAt}`;
  if (strategy.mode === "quality") return strategyKey;
  const meters = snapshot.windows.map(window =>
    `${window.id}=${window.usedFraction.toFixed(3)}:${window.status}:${now - window.fetchedAt >= REFRESH_MS ? "stale" : "fresh"}`
  );
  return `${strategyKey}|${meters.join(",")}`;
}

async function readT3Meters(): Promise<Record<string, unknown>> {
  const meters: Record<string, unknown> = {};
  for (const file of await readdir(T3_CACHES_DIR).catch(() => [] as string[])) {
    if (!file.endsWith(".json")) continue;
    try {
      const cache = record(JSON.parse(await readFile(join(T3_CACHES_DIR, file), "utf8")));
      if (cache?.usageLimits) meters[basename(file, ".json")] = cache.usageLimits;
    } catch {
      // A cache T3 is rewriting, or one with another shape, adds no meters.
    }
  }
  return meters;
}

type SessionLedger = { version: 1; sessions: Record<string, { contextVersion: string; seenAt: number }> };

async function readLedger(): Promise<SessionLedger> {
  try {
    const parsed = JSON.parse(await readFile(SESSIONS_PATH, "utf8")) as SessionLedger;
    return parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object"
      ? parsed
      : { version: 1, sessions: {} };
  } catch {
    return { version: 1, sessions: {} };
  }
}

/** Records the version shown to a session. Returns whether that session already had it. */
async function markShown(sessionId: string, version: string, now: number): Promise<boolean> {
  const ledger = await readLedger();
  const alreadyShown = ledger.sessions[sessionId]?.contextVersion === version;
  for (const [id, entry] of Object.entries(ledger.sessions)) {
    if (now - entry.seenAt > SESSION_TTL_MS) delete ledger.sessions[id];
  }
  ledger.sessions[sessionId] = { contextVersion: version, seenAt: now };
  await writeJsonAtomically(SESSIONS_PATH, ledger);
  return alreadyShown;
}

function warn(message: string, details?: Record<string, unknown>) {
  process.stderr.write(`${message} ${details ? JSON.stringify(details) : ""}\n`);
}

type HookInput = { hook_event_name?: unknown; session_id?: unknown };

async function main(): Promise<void> {
  const input = JSON.parse(await new Response(Bun.stdin.stream()).text() || "{}") as HookInput;
  const event = input.hook_event_name;
  if (event !== "SessionStart" && event !== "UserPromptSubmit") return;

  const now = Date.now();
  const strategy = await readStrategy();
  const snapshot = normalizeT3Usage(await readT3Meters(), now);
  const context = routingContext(snapshot, strategy, now);
  if (!context) return;

  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  if (sessionId) {
    const alreadyShown = await markShown(sessionId, contextVersion(snapshot, strategy, now), now);
    if (event === "UserPromptSubmit" && alreadyShown) return;
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  }));
}

if (import.meta.main) {
  // A quota hint must never break a session: report the failure and exit cleanly.
  await main().catch(error => warn("usage-aware routing hook failed", {
    error: error instanceof Error ? error.message : String(error),
  }));
}
