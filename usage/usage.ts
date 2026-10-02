import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "unknown";
  return Math.round(value).toLocaleString();
}

function formatUsd(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "unknown";
  if (value === 0) return "$0.00";
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function addUsage(total: Usage, usage: Usage | undefined): void {
  if (!usage) return;
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  total.totalTokens += usage.totalTokens ?? 0;
  total.cost.input += usage.cost?.input ?? 0;
  total.cost.output += usage.cost?.output ?? 0;
  total.cost.cacheRead += usage.cost?.cacheRead ?? 0;
  total.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
  total.cost.total += usage.cost?.total ?? 0;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show current context usage, session token totals, and cost",
    handler: async (_args, ctx) => {
      const context = ctx.getContextUsage();
      const contextTokens = context?.tokens ?? null;
      const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow;
      const remaining =
        contextTokens !== null && contextWindow !== undefined
          ? Math.max(contextWindow - contextTokens, 0)
          : null;
      const percent = context?.percent ?? null;

      const total: Usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };

      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "message") {
          const message = entry.message as { usage?: Usage };
          addUsage(total, message.usage);
        } else if (entry.type === "compaction" || entry.type === "branch_summary") {
          addUsage(total, entry.usage);
        }
      }

      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
      const lines = [
        `Usage for ${model}`,
        contextWindow !== undefined
          ? `Context: ${formatInt(contextTokens)} / ${formatInt(contextWindow)} tokens (${percent === null ? "unknown" : `${percent.toFixed(1)}%`})`
          : `Context: ${formatInt(contextTokens)} tokens`,
        `Context remaining: ${formatInt(remaining)} tokens`,
        `Session tokens: ↑ ${formatInt(total.input)}  ↓ ${formatInt(total.output)}  R ${formatInt(total.cacheRead)}  W ${formatInt(total.cacheWrite)}  total ${formatInt(total.totalTokens)}`,
        `Session cost: ${formatUsd(total.cost.total)}`,
        "Provider account quota/plan remaining is not exposed by pi, so this command cannot show subscription/API quota left.",
      ];

      const output = lines.join("\n");
      if (ctx.hasUI) ctx.ui.notify(output, "info");
      else console.log(output);
    },
  });
}
