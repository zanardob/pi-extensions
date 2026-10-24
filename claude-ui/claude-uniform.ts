import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
  LinesComponent,
  bold,
  dotFor,
  formatToolArgs,
  renderStreamedOutput,
  row,
  startTiming,
} from "./claude-shared/style.ts";

// ============================================================================
// Uniform tool rendering for *every* tool.
//
// `pi.registerToolRenderer` picks renderers per tool call, so third-party tools
// (web_search, fetch_content, subagent, MCP, …) get the same frame as the
// built-ins without re-registering anything: execute(), permissions, hooks and
// on/off state stay pi's.
//
// Resolvers run in load order, so this one only sees the tools claude-tools.ts
// did not claim. Frame applied to a unified tool:
//
//   ● web_search(query: react vs vue)
//   ⎿  done in 2.3s (14 lines)
//       …result text, indented, 20 lines collapsed / 500 expanded
//
// Style rules match claude-tools.ts: plain (lowercase) names, gray/green/red
// status dot, `⎿` result line, flat (unboxed) rows.
// ============================================================================

/**
 * Tools that should keep their own custom UI instead of the uniform frame.
 *
 * Empty by default: every tool looks the same. Add a tool name here to restore
 * that tool's native renderer — e.g. "subagent" brings back pi-subagents' run
 * cards, "web_search" pi-web-access' progress/source layout.
 */
const KEEP_CUSTOM_RENDERER = new Set<string>([]);

/** `● name(key: value, …)` — the generic call header. */
function uniformRenderers(name: string): ToolRenderers {
  return {
    renderShell: "self",
    renderCall(args, _theme, context) {
      startTiming(context);
      const summary = formatToolArgs(args);
      return new LinesComponent([row(`${dotFor(context)} ${bold(name)}(${summary})`)]);
    },
    // Same body as the shell/listing tools: streaming header while running,
    // `⎿ done in 1.2s (12 lines)` once settled, capped + indented output.
    renderResult(result, options, _theme, context) {
      return renderStreamedOutput(result, options, context);
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerToolRenderer((toolName, next) => (KEEP_CUSTOM_RENDERER.has(toolName) ? next() : uniformRenderers(toolName)));
}
