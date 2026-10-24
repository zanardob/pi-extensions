/**
 * claude-ui — Claude-style editor, footer, tool rendering, and themes for Pi.
 *
 * Single extension entry point that composes the feature modules:
 *   claude-editor  — bordered editor and the ❯ gutter on user messages
 *   claude-footer  — footer with session, model, context, cost, cwd, git and statuses
 *   claude-tools   — Claude-style rendering for the built-in tools
 *   claude-uniform — uniform tool-call rows for every other tool
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import editor from "./claude-editor.ts";
import footer from "./claude-footer.ts";
import tools from "./claude-tools.ts";
import uniform from "./claude-uniform.ts";

export default function (pi: ExtensionAPI) {
  editor(pi);
  footer(pi);
  tools(pi);
  uniform(pi);
}
