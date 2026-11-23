import {
  type AgentRoute,
  type AutocompleteItem,
  type Exec,
  type ResolvedModel,
  type RoutingSurface,
  QUALITY_INSTRUCTION,
  ROUTING_HEADER,
  buildAgentQuotaOrder,
  buildRoutingInstruction,
  completeQuotaStrategy,
  quotaStrategyViolation,
  readStrategy,
  selectAgentRoutes,
  sharedUsage,
  writeStrategy,
} from "../lib/usage-routing.ts";

const OMP_SURFACE: RoutingSurface = {
  sourceLine: age => `Automatic shared snapshot; provider usage refreshes when older than 30 minutes (age ${age}). Do not run or parse \`omp usage\` yourself.`,
  scopeNote: "Scope: shared rows apply provider-wide; model/tier/group rows apply to matching models. Codex Chat and Spark are a narrow explicit exception because upstream omits that distinction from its default scope metadata. Missing limits are unknown; never invent them.",
  routeSource: "The route order is resolved from current project/user/plugin/bundled agent definitions and their model selectors; never infer a stale allowlist.",
  guardsTargeted: true,
  guidance: [],
};

type BeforeAgentStartEvent = {
  systemPrompt: string[];
};

type BeforeAgentStartContext = {
  cwd: string;
  models: {
    resolve(spec: string): ResolvedModel | undefined;
  };
};

type ToolCallEvent = {
  toolName: string;
  input: Record<string, unknown>;
};

type ToolCallResult = {
  block?: boolean;
  reason?: string;
};

type StrategyCommandContext = {
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    select(title: string, options: string[]): Promise<string | undefined>;
  };
};

type PiApi = {
  getActiveTools(): string[];
  exec: Exec;
  logger?: { warn(message: string, details?: Record<string, unknown>): void };
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartEvent, ctx: BeforeAgentStartContext) => Promise<unknown> | unknown,
  ): void;
  on(
    event: "tool_call",
    handler: (event: ToolCallEvent, ctx: BeforeAgentStartContext) => Promise<ToolCallResult | undefined> | ToolCallResult | undefined,
  ): void;
  registerCommand(
    name: "quota-strategy",
    options: {
      description: string;
      handler: (args: string, ctx: StrategyCommandContext) => Promise<void> | void;
      getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
    },
  ): void;
  setLabel(label: string): void;
};

async function discoverAgentRoutes(cwd: string, logger: PiApi["logger"]): Promise<AgentRoute[]> {
  try {
    // Runtime-only import: the standalone OMP binary provides this module to
    // extensions, while keeping this file independently testable with Bun.
    const loaded: unknown = await import("@oh-my-pi/pi-coding-agent/task");
    if (!loaded || typeof loaded !== "object") return [];
    const taskModule = loaded as Record<string, unknown>;
    if (typeof taskModule.discoverAgents !== "function" || typeof taskModule.isReadOnlyAgent !== "function") return [];
    const discoverAgents = taskModule.discoverAgents as (cwd: string) => Promise<unknown>;
    const isReadOnlyAgent = taskModule.isReadOnlyAgent as (agent: unknown) => boolean;
    const { findScopedSettings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
    const { cfgTaskDisabledAgents } = await import("@oh-my-pi/pi-coding-agent/task/settings");
    const settings = findScopedSettings(cwd);
    if (!settings) throw new Error("Active session settings unavailable");
    const disabledAgents = cfgTaskDisabledAgents.get(settings);
    const discovered: unknown = await discoverAgents(cwd);
    if (!discovered || typeof discovered !== "object" || !(("agents" in discovered))) return [];
    const agents = discovered.agents;
    if (!Array.isArray(agents)) return [];

    return selectAgentRoutes(agents, disabledAgents, isReadOnlyAgent);
  } catch (error) {
    logger?.warn("usage-aware routing agent discovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function configureStrategy(args: string, ctx: StrategyCommandContext, pi: PiApi): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    const current = await readStrategy();
    ctx.ui.notify(
      current.mode === "targeted"
        ? `Quota strategy: targeted (${current.provider})`
        : `Quota strategy: ${current.mode}`,
      "info",
    );
    return;
  }

  if ((parts[0] === "balanced" || parts[0] === "quality") && parts.length === 1) {
    await writeStrategy({ version: 1, mode: parts[0], updatedAt: Date.now() });
    ctx.ui.notify(`Quota strategy set to ${parts[0]}.`, "info");
    return;
  }

  if (parts[0] === "targeted" && parts.length <= 2) {
    const snapshot = await sharedUsage(pi.exec, pi.logger);
    const providers = snapshot
      ? [...new Set(snapshot.windows.map(window => window.provider))].sort()
      : [];
    const requested = parts[1];
    const provider = requested
      ? providers.find(candidate => candidate.toLowerCase() === requested.toLowerCase())
      : await ctx.ui.select("Target subscription provider", providers);
    if (!provider) {
      ctx.ui.notify(
        providers.length
          ? `Choose a provider: ${providers.join(", ")}`
          : "No providers with usage data are available.",
        "warning",
      );
      return;
    }
    await writeStrategy({ version: 1, mode: "targeted", provider, updatedAt: Date.now() });
    const credits = snapshot?.resetCredits[provider] ?? 0;
    ctx.ui.notify(
      `Quota strategy set to targeted (${provider})${credits ? ` with ${credits} saved reset credit${credits === 1 ? "" : "s"}` : ""}.`,
      "info",
    );
    return;
  }

  ctx.ui.notify("Usage: /quota-strategy balanced | quality | targeted [provider]", "warning");
}

export default function usageAwareRouting(pi: PiApi) {
  pi.setLabel("Usage-aware subagent routing");
  pi.registerCommand("quota-strategy", {
    description: "Show or change balanced/quality/targeted subagent quota routing",
    getArgumentCompletions: argumentPrefix => completeQuotaStrategy(argumentPrefix),
    handler: (args, ctx) => configureStrategy(args, ctx, pi),
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!pi.getActiveTools().includes("task")) return;
    const strategy = await readStrategy();
    if (strategy.mode === "quality") {
      return {
        systemPrompt: [...event.systemPrompt.filter(part => !part.startsWith(ROUTING_HEADER)), QUALITY_INSTRUCTION],
      };
    }
    const snapshot = await sharedUsage(pi.exec, pi.logger);
    if (!snapshot?.windows.length) return;
    const now = Date.now();
    const agents = await discoverAgentRoutes(ctx.cwd, pi.logger);
    const routeOrder = buildAgentQuotaOrder(snapshot, agents, spec => ctx.models.resolve(spec), now, strategy);
    return {
      systemPrompt: [
        ...event.systemPrompt.filter(part => !part.startsWith(ROUTING_HEADER)),
        buildRoutingInstruction(snapshot, OMP_SURFACE, strategy, routeOrder, now),
      ],
    };
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "task") return;
    const strategy = await readStrategy();
    if (strategy.mode !== "targeted") return;
    const snapshot = await sharedUsage(pi.exec, pi.logger);
    if (!snapshot?.windows.length) return;
    const agents = await discoverAgentRoutes(ctx.cwd, pi.logger);
    const reason = quotaStrategyViolation(
      snapshot,
      agents,
      spec => ctx.models.resolve(spec),
      event.input,
      strategy,
    );
    return reason ? { block: true, reason } : undefined;
  });
}
