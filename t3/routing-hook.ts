// T3 Code hook: adds live quota context to Claude Code and Codex sessions.
//
// T3 runs each thread through the provider's own CLI, so user-level
// SessionStart and UserPromptSubmit hooks fire inside T3. Register this script
// for both events in ~/.claude/settings.json and ~/.codex/hooks.json.
//
// SessionStart (startup, resume, clear, compact) always adds the context.
// UserPromptSubmit adds it again only after the snapshot refreshes or the
// strategy changes, so a long session does not repeat the same block on every
// prompt.
//
// The hook only advises. It never blocks a session or a tool call, so the
// targeted strategy is advisory here.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentRoute,
  type Exec,
  type ResolvedModel,
  type RoutingStrategy,
  type RoutingSurface,
  type UsageSnapshot,
  QUALITY_INSTRUCTION,
  buildAgentQuotaOrder,
  buildRoutingInstruction,
  readStrategy,
  sharedUsage,
  writeJsonAtomically,
} from "../lib/usage-routing.ts";

const SESSIONS_PATH = process.env.OMP_USAGE_ROUTING_T3_SESSIONS
  ?? join(homedir(), ".omp", "cache", "usage-routing-t3-sessions.json");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OMP_USAGE_TIMEOUT_MS = 20_000;

/**
 * Routes a T3 agent can take, written as "<quota provider>/<model id prefix>".
 * Claude's Agent tool runs Claude models only; delegate_task reaches the other
 * providers.
 */
export const T3_ROUTES: readonly AgentRoute[] = [
  { name: "claude (opus, sonnet, haiku)", modelSelectors: ["anthropic/claude"] },
  { name: "claude-fable", modelSelectors: ["anthropic/claude-fable"] },
  { name: "codex (gpt)", modelSelectors: ["openai-codex/gpt"] },
  { name: "codex-spark", modelSelectors: ["openai-codex/gpt-spark"] },
];

export const T3_SURFACE: RoutingSurface = {
  routeSource: "The route order lists T3 provider routes, each mapped to the quota windows that bill it.",
  guardsTargeted: false,
  guidance: [
    "In T3, choose a route when you start a subagent: the Agent tool's model for Claude models, or delegate_task's provider and model for Codex and other providers.",
    "This quota context is the user's standing request to weigh quota when choosing a subagent model. A model the user or the project instructions name still wins.",
  ],
};

function resolveRoute(spec: string): ResolvedModel | undefined {
  const slash = spec.indexOf("/");
  return slash > 0 ? { provider: spec.slice(0, slash), id: spec.slice(slash + 1) } : undefined;
}

export function routingContext(
  snapshot: UsageSnapshot | undefined,
  strategy: RoutingStrategy,
  now = Date.now(),
): string | undefined {
  if (strategy.mode === "quality") return QUALITY_INSTRUCTION;
  if (!snapshot?.windows.length) return undefined;
  const routeOrder = buildAgentQuotaOrder(snapshot, [...T3_ROUTES], resolveRoute, now, strategy);
  return buildRoutingInstruction(snapshot, T3_SURFACE, strategy, routeOrder, now);
}

/** Changes when the context says something new: a refreshed snapshot or a changed strategy. */
export function contextVersion(snapshot: UsageSnapshot | undefined, strategy: RoutingStrategy): string {
  const strategyKey = strategy.mode === "targeted"
    ? `targeted:${strategy.provider}:${strategy.updatedAt}`
    : `${strategy.mode}:${strategy.updatedAt}`;
  return strategy.mode === "quality" ? strategyKey : `${strategyKey}@${snapshot?.refreshedAt ?? "none"}`;
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

const execOmp: Exec = (command, args) => new Promise(resolve => {
  execFile(command, args, { timeout: OMP_USAGE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
    resolve({ code, stdout, stderr, killed: error?.killed });
  });
});

const logger = {
  warn(message: string, details?: Record<string, unknown>) {
    process.stderr.write(`${message} ${details ? JSON.stringify(details) : ""}\n`);
  },
};

type HookInput = { hook_event_name?: unknown; session_id?: unknown };

async function main(): Promise<void> {
  const input = JSON.parse(await new Response(Bun.stdin.stream()).text() || "{}") as HookInput;
  const event = input.hook_event_name;
  if (event !== "SessionStart" && event !== "UserPromptSubmit") return;

  const strategy = await readStrategy();
  const snapshot = strategy.mode === "quality" ? undefined : await sharedUsage(execOmp, logger);
  const context = routingContext(snapshot, strategy);
  if (!context) return;

  const now = Date.now();
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  if (sessionId) {
    const alreadyShown = await markShown(sessionId, contextVersion(snapshot, strategy), now);
    if (event === "UserPromptSubmit" && alreadyShown) return;
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  }));
}

if (import.meta.main) {
  // A quota hint must never break a session: report the failure and exit cleanly.
  await main().catch(error => logger.warn("usage-aware routing hook failed", {
    error: error instanceof Error ? error.message : String(error),
  }));
}
