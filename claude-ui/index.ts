/**
 * claude-ui — Claude-style editor, footer, tool rendering, and themes for Pi.
 *
 * Single extension entry point that composes the feature modules:
 *   claude-editor  — bordered editor with the ❯ gutter inside the input box
 *   claude-footer  — footer with session, model, context, cost, cwd, git and statuses
 *   claude-tools   — Claude-style rendering for the built-in tools
 *   claude-uniform — uniform tool-call rows for every other tool
 *   claude-markers — ● and ❯ on the transcript rows pi does not expose a hook for
 *   claude-working — phase, elapsed time and output tokens in the row above the editor
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import editor from "./claude-editor.ts";
import footer from "./claude-footer.ts";
import tools from "./claude-tools.ts";
import uniform from "./claude-uniform.ts";
import markers from "./claude-markers.ts";
import working from "./claude-working.ts";

export default function (pi: ExtensionAPI) {
  editor(pi);
  footer(pi);
  tools(pi);
  uniform(pi);
  markers(pi);
  working(pi);
}
