import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { claudeState } from "./claude-shared/state.ts";

/** Strip SGR + OSC sequences (incl. the zero-width hardware-cursor marker). */
const ANSI_RE = /\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[@-~]/g;

function isBorderLine(line: string): boolean {
  return line.replace(ANSI_RE, "").startsWith("─");
}

/**
 * Default editor with a Claude-style "❯" prompt gutter inside the box:
 * the first content line gets "❯ ", every other line (wrapped or not) gets
 * two columns of padding so all text aligns under the arrow — like Claude Code.
 */
class ClaudeEditor extends CustomEditor {
  render(width: number): string[] {
    const lines = super.render(width);
    if (width < 8 || lines.length < 3) return lines;
    const paddingX = Math.max(0, Math.floor(this.getPaddingX?.() ?? 0));

    const out: string[] = [];
    let bodyDone = false; // flipped once the bottom border is reached
    let firstContent = true;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // The first border line after the top border closes the body; anything
      // below it (autocomplete dropdown, etc.) is left untouched.
      if (i > 0 && isBorderLine(line)) bodyDone = true;
      if (i === 0 || bodyDone) {
        out.push(line);
        continue;
      }
      // Content line: drop the plain left padding, then apply the gutter so
      // text always starts at column 2 ("❯ " / "  "). Claude Code renders the
      // prompt char in the default foreground color.
      let body = line;
      for (let p = 0; p < paddingX; p++) {
        if (body.startsWith(" ")) body = body.slice(1);
      }
      const prefix = firstContent ? "❯ " : "  ";
      firstContent = false;
      out.push(truncateToWidth(prefix + body, width, ""));
    }
    return out;
  }

  handleInput(data: string): void {
    const isExpand =
      typeof (this as any).keybindings?.matches === "function" &&
      (this as any).keybindings.matches(data, "app.tools.expand");
    if (isExpand) {
      // The expand key also toggles thinking blocks: flip the shared flag, let
      // pi's built-in tool-output toggle run via super, then invalidate the tree
      // so assistant components rebuild and the thinking transformer re-runs.
      claudeState.thinkingExpanded = !claudeState.thinkingExpanded;
    }
    super.handleInput(data);
    if (isExpand) {
      (this as any).tui?.invalidate?.();
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new ClaudeEditor(tui, theme, keybindings));
  });
}
