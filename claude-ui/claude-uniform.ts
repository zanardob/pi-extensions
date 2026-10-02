import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
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
// pi has no "wrap the renderers of another extension's tool" hook: renderCall /
// renderResult live on the tool definition, and re-registering a tool by name
// replaces it wholesale (losing its execute() implementation). So third-party
// tools (web_search, fetch_content, subagent, …) would otherwise keep their own
// look while the built-ins render Claude-Code style.
//
// `ToolExecutionComponent` *is* part of the public API though, and the bundled
// CLI resolves `@earendil-works/pi-coding-agent` to its own module instance
// (virtual module mapping), so patching the prototype here patches the exact
// class the renderer uses. The result:
//
//   - presentation only — execute(), permissions, hooks are untouched;
//   - works for built-ins, package tools and any future tool;
//   - no files are modified, so it survives `brew upgrade pi` and package
//     updates, and deleting this file fully reverts it.
//
// Frame applied to a unified tool:
//
//   ● web_search(query: react vs vue)
//   ⎿  done in 2.3s (14 lines)
//       …result text, indented, 20 lines collapsed / 500 expanded
//
// Style rules match claude-tools.ts: plain (lowercase) names, gray/green/red
// status dot, `⎿` result line, flat (unboxed) rows.
// ============================================================================

/**
 * Tools claude-tools.ts renders itself (kept out of the generic path).
 *
 * powershell is omitted on purpose: claude-tools.ts only registers the shell
 * tools it renders (bash/read/write/edit/grep/find/ls), so a tool it does not
 * register should fall through to the uniform frame rather than keep pi's
 * native look.
 */
const BESPOKE_RENDERERS = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);

/**
 * Tools that should keep their own custom UI instead of the uniform frame.
 *
 * Empty by default: every tool looks the same. Add a tool name here to restore
 * that tool's native renderer — e.g. "subagent" brings back pi-subagents' run
 * cards, "web_search" pi-web-access' progress/source layout.
 */
const KEEP_CUSTOM_RENDERER = new Set<string>([]);

const PATCH_FLAG = "__claudeUniformPatched";

/** `● name(key: value, …)` — the generic call header. */
function uniformCallRenderer(name: string, args: unknown, context: any): LinesComponent {
  startTiming(context);
  const summary = formatToolArgs(args);
  return new LinesComponent([row(`${dotFor(context)} ${bold(name)}(${summary})`)]);
}

export default function (_pi: ExtensionAPI) {
  const proto = ToolExecutionComponent.prototype as any;

  // Idempotent: extensions are re-imported on /reload and session replacement.
  if (proto[PATCH_FLAG]) return;
  proto[PATCH_FLAG] = true;

  const originalGetCallRenderer = proto.getCallRenderer;
  const originalGetResultRenderer = proto.getResultRenderer;
  const originalGetRenderShell = proto.getRenderShell;

  const keepsOwnRenderer = (self: any): boolean => {
    const name = self?.toolName;
    return typeof name === "string" && (BESPOKE_RENDERERS.has(name) || KEEP_CUSTOM_RENDERER.has(name));
  };

  proto.getCallRenderer = function () {
    if (keepsOwnRenderer(this)) return originalGetCallRenderer.call(this);
    const name = typeof this?.toolName === "string" ? this.toolName : "tool";
    return (args: unknown, _theme: unknown, context: any) => uniformCallRenderer(name, args, context);
  };

  proto.getResultRenderer = function () {
    if (keepsOwnRenderer(this)) return originalGetResultRenderer.call(this);
    // Same body as the shell/listing tools: streaming header while running,
    // `⎿ done in 1.2s (12 lines)` once settled, capped + indented output.
    // NOTE: adapt the 4-arg renderer signature the component uses — passing
    // renderStreamedOutput directly would bind `theme` as its `context` and
    // silently drop timing and error rendering.
    return (result: any, options: any, _theme: unknown, context: any) => renderStreamedOutput(result, options, context);
  };

  proto.getRenderShell = function () {
    if (keepsOwnRenderer(this)) return originalGetRenderShell.call(this);
    // Rows built before this patch already attached pi's default Box; keep them
    // on the shell they were constructed with so nothing renders blank.
    const children = this?.children;
    if (Array.isArray(children) && this.contentBox && children.includes(this.contentBox)) {
      return originalGetRenderShell.call(this);
    }
    return "self";
  };
}
