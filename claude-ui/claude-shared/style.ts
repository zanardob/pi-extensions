// Shared Claude-Code-style rendering primitives.
//
// Used by claude-tools.ts (bespoke renderers for the built-in file/shell tools)
// and claude-uniform.ts (generic renderer applied to every other tool).
//
// Lives in a subdirectory (not extensions/*.ts) so pi's auto-discovery doesn't
// try to load it as an extension — only top-level *.ts and */index.ts files are
// treated as extension entry points.
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ============================================================================
// Palette (truecolor, matching Claude Code's light diff theme)
// ============================================================================

export const C = {
  addLineBg: "\x1b[48;2;220;255;220m",
  addWordBg: "\x1b[48;2;178;255;178m",
  addFg: "\x1b[38;2;36;138;61m",
  delLineBg: "\x1b[48;2;255;220;220m",
  delWordBg: "\x1b[48;2;255;199;199m",
  delFg: "\x1b[38;2;207;34;46m",
  ctxFg: "\x1b[38;2;51;51;51m",
  reset: "\x1b[0m",
};

export const DOT = {
  pending: "\x1b[38;2;153;153;153m", // gray — pending / running
  success: "\x1b[38;2;46;160;67m", // green — done
  error: "\x1b[38;2;229;83;75m", // red — error
};

export const MUTED = "\x1b[38;2;136;136;136m";
export const ERROR_FG = "\x1b[38;2;229;83;75m";
export const CTX_NUM_FG = "\x1b[38;2;160;160;160m";
export const BOLD = "\x1b[1m";
// SGR 4:4 — dashed underline; reads as a link affordance for file paths.
export const DASHED_UNDERLINE = "\x1b[4:4m";

export const bold = (s: string) => BOLD + s + C.reset;
export const link = (s: string) => DASHED_UNDERLINE + s + C.reset;

/** Bash/listing body lines shown per tool row when collapsed. */
export const COLLAPSED_BASH_LINES = 20;
/** …and when expanded with ctrl+o. */
export const EXPANDED_BASH_LINES = 500;
/** Indent of result body lines under the `⎿` header. */
export const DIFF_INDENT = 4;
export const BODY_INDENT = " ".repeat(DIFF_INDENT);

// ============================================================================
// Rows / component
// ============================================================================

export type Row = { text: string; bg: string | null; wrapIndent?: number };

export const row = (text: string): Row => ({ text, bg: null });

/**
 * A body row that word-wraps instead of truncating when it is wider than the
 * terminal. `indent` is prepended to every wrapped line so output stays
 * aligned under its own gutter. Truncating would hide long lines that pi's
 * native renderers (and therefore third-party tools) used to wrap.
 */
export const wrapRow = (content: string, indent: number): Row => ({
  text: " ".repeat(indent) + content,
  bg: null,
  wrapIndent: indent,
});

function renderRow(text: string, width: number, bg: string | null): string {
  // Always truncate to the terminal width — Pi throws on overwide lines.
  const clipped = truncateToWidth(text, Math.max(1, width - 1));
  const line = " " + clipped;
  if (!bg) return line;
  const vis = visibleWidth(line);
  if (vis >= width) return line;
  return line + bg + " ".repeat(width - vis) + C.reset;
}

/** Component that renders pre-styled rows, padding bg rows to full width. */
export class LinesComponent {
  rows: Row[];
  constructor(rows: Row[]) {
    this.rows = rows;
  }
  render(width: number): string[] {
    // 1-column gutter keeps rows aligned with assistant text (outputPad=1)
    // since renderShell "self" bypasses the default padded Box.
    const out: string[] = [];
    for (const r of this.rows) {
      if (r.wrapIndent === undefined) {
        out.push(renderRow(r.text, width, r.bg));
        continue;
      }
      // Wrap the content without its indent and re-add the indent to every
      // line: wrapping the indented text gives continuation lines the full
      // width, which then overflows once the indent is re-applied.
      // width - 2 leaves one column for the leading gutter and one so a
      // wrapped line plus its gutter still fits what renderRow allows.
      const indent = r.wrapIndent;
      const pieces = wrapTextWithAnsi(r.text.slice(indent), Math.max(1, width - 2 - indent));
      for (const piece of pieces) {
        out.push(renderRow(" ".repeat(indent) + piece, width, r.bg));
      }
    }
    return out;
  }
  invalidate() {}
}

// ============================================================================
// Small helpers
// ============================================================================

/** Status dot for a tool call line, derived from the render context. */
export function dotFor(context: { isError: boolean; executionStarted: boolean; isPartial: boolean }): string {
  if (context.isError) return DOT.error + "●" + C.reset;
  if (context.executionStarted && !context.isPartial) return DOT.success + "●" + C.reset;
  return DOT.pending + "●" + C.reset;
}

/** Text output of a tool result (text blocks joined; images ignored). */
export function textOutput(result: { content: Array<{ type: string; text?: string }> } | undefined): string {
  if (!result) return "";
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

export function trimTrailingEmpty(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

export function relativePath(p: string, cwd: string | undefined): string {
  if (!cwd || !p.startsWith(cwd + "/")) return p;
  return p.slice(cwd.length + 1);
}

export function elapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

// ============================================================================
// Shared per-row timing
//
// renderCall starts the clock once execution begins; renderResult ticks a
// 1-second interval while the tool is still running so the elapsed time stays
// live, then stops when the result settles.
// ============================================================================

export function startTiming(context: any): void {
  const state = context?.state;
  if (!state) return;
  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
}

export function trackTiming(context: any, options: { isPartial?: boolean }): void {
  const state = context?.state;
  if (!state) return;
  if (state.startedAt !== undefined && options.isPartial && !state.interval) {
    state.interval = setInterval(() => {
      try {
        context.invalidate();
      } catch {
        /* render context gone — stop ticking */
        if (state.interval) clearInterval(state.interval);
        state.interval = undefined;
      }
    }, 1000);
  }
  if (!options.isPartial || context.isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }
}

/** ` in 1.2s` once the tool has settled, else "". */
export function elapsedIn(state: any): string {
  return state?.startedAt !== undefined && state?.endedAt ? ` in ${elapsed(state.endedAt - state.startedAt)}` : "";
}

// ============================================================================
// Shared streamed-output result body (bash, grep, find, ls, uniform tools)
//
// One `⎿ done in 1.2s (12 lines)` header, then the output lines indented to
// BODY_INDENT, capped at COLLAPSED_BASH_LINES (500 when expanded).
// ============================================================================

export function renderStreamedOutput(result: any, options: any, context: any): LinesComponent {
  trackTiming(context, options);
  const state = context.state;

  if (context.isError) {
    const errLines = trimTrailingEmpty(textOutput(result).split("\n"));
    const cap = options.expanded ? EXPANDED_BASH_LINES : COLLAPSED_BASH_LINES;
    const shown = errLines.slice(0, cap);
    const remaining = errLines.length - shown.length;
    const rows: Row[] = [row(`${MUTED}⎿${C.reset}  failed${elapsedIn(state)}`)];
    for (const l of shown) rows.push(wrapRow(ERROR_FG + l + C.reset, DIFF_INDENT));
    if (remaining > 0) {
      rows.push(wrapRow(`${MUTED}… +${remaining} more${C.reset}${MUTED} (ctrl+o to expand)${C.reset}`, DIFF_INDENT));
    }
    return new LinesComponent(rows);
  }

  let output = textOutput(result);
  // Replace the built-in truncation footer with our own one-liner so the
  // line count stays honest.
  const details = result?.details;
  if (details?.truncation?.truncated && details.fullOutputPath && output.endsWith("]")) {
    const footerStart = output.lastIndexOf("\n\n[");
    if (footerStart !== -1 && output.slice(footerStart).includes(details.fullOutputPath)) {
      output = output.slice(0, footerStart);
    }
  }
  const lines = trimTrailingEmpty(output.split("\n"));

  if (options.isPartial) {
    // Streaming: live header, output capped like the collapsed view.
    const dur = state.startedAt !== undefined ? ` (${elapsed(Date.now() - state.startedAt)})` : "";
    const rows: Row[] = [row(`${MUTED}⎿${C.reset}  running…${dur}`)];
    for (const l of lines.slice(0, COLLAPSED_BASH_LINES)) rows.push(wrapRow(l, DIFF_INDENT));
    const hidden = lines.length - Math.min(lines.length, COLLAPSED_BASH_LINES);
    if (hidden > 0) rows.push(wrapRow(`${MUTED}… +${hidden} more (ctrl+o to expand)${C.reset}`, DIFF_INDENT));
    return new LinesComponent(rows);
  }

  const total = lines.length;
  const cap = options.expanded ? EXPANDED_BASH_LINES : COLLAPSED_BASH_LINES;
  const shown = lines.slice(0, cap);
  const remaining = total - shown.length;

  const rows: Row[] = [
    row(`${MUTED}⎿${C.reset}  done${elapsedIn(state)} ${MUTED}(${total} ${total === 1 ? "line" : "lines"})${C.reset}`),
  ];
  for (const l of shown) rows.push(wrapRow(l, DIFF_INDENT));
  if (details?.truncation?.truncated && details.fullOutputPath) {
    rows.push(wrapRow(`${MUTED}[truncated — full output: ${details.fullOutputPath}]${C.reset}`, DIFF_INDENT));
  }
  if (remaining > 0) {
    const note = options.expanded ? "output truncated" : "ctrl+o to expand";
    rows.push(wrapRow(`${MUTED}… +${remaining} more (${note})${C.reset}`, DIFF_INDENT));
  }
  return new LinesComponent(rows);
}

// ============================================================================
// Generic call header for arbitrary tools: `● name(key: value, key: value)`
// ============================================================================

function formatArgValue(value: unknown): string | null {
  if (typeof value === "string") {
    const oneLine = value.replace(/\s+/g, " ").trim();
    if (!oneLine) return null;
    return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const scalars = value.filter((v) => typeof v === "string" || typeof v === "number");
    if (scalars.length === 0 || scalars.length !== value.length) return null;
    const joined = scalars.join(", ");
    return joined.length > 60 ? `${joined.slice(0, 57)}…` : joined;
  }
  return null;
}

/** Argument names whose values must never be echoed into the transcript. */
const SECRET_ARG = /(key|token|secret|password|passwd|credential|auth)/i;

/** Compact `key: value, …` summary of a tool call's arguments. */
export function formatToolArgs(args: unknown, maxPairs = 3): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const parts: string[] = [];
  let skipped = 0;
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") continue;
    if (parts.length === maxPairs) {
      skipped++;
      continue;
    }
    if (SECRET_ARG.test(key)) {
      parts.push(`${key}: ••••`);
      continue;
    }
    const formatted = formatArgValue(value);
    if (formatted === null) {
      skipped++;
      continue;
    }
    parts.push(`${key}: ${formatted}`);
  }
  if (parts.length === 0) return "";
  return parts.join(", ") + (skipped > 0 ? ", …" : "");
}
