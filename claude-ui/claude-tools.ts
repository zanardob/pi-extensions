import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLanguageFromPath, highlightCode, keyHint, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { claudeState } from "./claude-shared/state.ts";
import {
  C,
  CTX_NUM_FG,
  DIFF_INDENT,
  ERROR_FG,
  LinesComponent,
  MUTED,
  type Row,
  bold,
  diffPalette,
  dotFor,
  link,
  paintOn,
  relativePath,
  renderStreamedOutput,
  row,
  startTiming,
  textOutput,
  trimTrailingEmpty,
} from "./claude-shared/style.ts";

// ============================================================================
// Claude-Code-style rendering for the built-in tools (read/bash/write/edit
// plus grep/find/ls). Shared primitives live in ./claude-shared/style.ts;
// claude-uniform.ts applies the same look to every other tool.
//
// Rendering only: `registerToolRenderer` replaces how a call is drawn, never
// the tool itself, so schemas, execution, permissions, hooks and command
// rewriting (e.g. RTK) are untouched.
// No file I/O happens in any renderer, so streaming and expansion stay smooth.
//
// Style rules:
//   - Plain (lowercase) tool names: bash(), read(), write(), edit().
//   - Status dots: gray ● while running, green when done, red on error.
//   - Only edit shows a diff — bash/read/write never do.
//   - the app.tools.expand key gives every tool a meaningful expanded state:
//     bash 20 → 500 line cap, read shows the file content, edit shows the
//     untrimmed diff. Collapsed views stay Claude-Code-style.
// ============================================================================

/** Bash call header shows the full command up to this many lines; longer
 *  commands collapse to the first line + hint (the expand key reveals everything). */
const BASH_CALL_MAX_LINES = 5;

// ============================================================================
// Claude-Code-style edit diff rendering.
// Port of CC native-ts/color-diff: full-row line backgrounds that follow the
// theme's appearance, syntax-highlighted line text (decoration colour where
// untokenised), and a stronger background on the words that changed.
// ============================================================================

const tokenizeWords = (s: string): string[] => s.match(/\w+|\s+|[^\w\s]/g) ?? [];

/** LCS word diff: k=0 same, k=1 removed, k=2 added. */
function diffTokens(a: string[], b: string[]): { t: string; k: 0 | 1 | 2 }[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: { t: string; k: 0 | 1 | 2 }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: a[i], k: 0 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: a[i], k: 1 });
      i++;
    } else {
      out.push({ t: b[j], k: 2 });
      j++;
    }
  }
  while (i < n) out.push({ t: a[i++], k: 1 });
  while (j < m) out.push({ t: b[j++], k: 2 });
  return out;
}

/** Character span, [start, end), on one side of a word diff. */
type Span = { start: number; end: number };

/** Raw char offsets of changed tokens on one side of the diff. */
function spansFor(tokens: { t: string; k: 0 | 1 | 2 }[], kind: 1 | 2): Span[] {
  const spans: Span[] = [];
  let text = "";
  let pos = 0;
  let start = -1;
  for (const p of tokens) {
    if (p.k === kind) {
      if (start < 0) start = pos;
    } else if (start >= 0) {
      spans.push({ start, end: pos });
      start = -1;
    }
    if (p.k === 0 || p.k === kind) {
      text += p.t;
      pos += p.t.length;
    }
  }
  if (start >= 0) spans.push({ start, end: pos });
  return mergeSpanGaps(spans, text);
}

/** Merge spans separated only by whitespace, so a changed run reads as one mark. */
function mergeSpanGaps(spans: Span[], text: string): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && text.slice(last.end, span.start).trim() === "") last.end = span.end;
    else out.push({ ...span });
  }
  return out;
}

/**
 * Pairs each removed line with the line that replaced it: a run of `-` lines is
 * matched line by line with the `+` run right after it, so a multi-line rewrite
 * still gets word-level marks. Pairs that share too little text are dropped —
 * highlighting unrelated lines is all noise.
 */
function pairWordDiffs(entries: DiffEntry[]): Map<DiffEntry, { before: Span[]; after: Span[] }> {
  const pairs = new Map<DiffEntry, { before: Span[]; after: Span[] }>();
  for (let i = 0; i < entries.length; ) {
    if (entries[i].sign !== "-") {
      i++;
      continue;
    }
    let removedEnd = i;
    while (removedEnd < entries.length && entries[removedEnd].sign === "-") removedEnd++;
    let addedEnd = removedEnd;
    while (addedEnd < entries.length && entries[addedEnd].sign === "+") addedEnd++;
    for (let k = 0; k < Math.min(removedEnd - i, addedEnd - removedEnd); k++) {
      const before = entries[i + k];
      const after = entries[removedEnd + k];
      const spans = wordDiff(tabs(before.content), tabs(after.content));
      if (!spans) continue;
      pairs.set(before, { before: spans.removed, after: spans.added });
      pairs.set(after, { before: spans.removed, after: spans.added });
    }
    i = addedEnd;
  }
  return pairs;
}

/** Changes below this share of the longer line are not worth marking. */
const WORD_DIFF_MIN_SHARED = 0.3;
/** Above this length the O(n·m) word diff costs more than it is worth. */
const WORD_DIFF_MAX_CHARS = 2000;

/** Changed words on both sides of a replaced line, or undefined when the pair is too unlike. */
function wordDiff(before: string, after: string): { removed: Span[]; added: Span[] } | undefined {
  if (before.length > WORD_DIFF_MAX_CHARS || after.length > WORD_DIFF_MAX_CHARS) return undefined;
  const tokens = diffTokens(tokenizeWords(before), tokenizeWords(after));
  let shared = 0;
  for (const t of tokens) if (t.k === 0) shared += t.t.trim().length;
  if (shared < WORD_DIFF_MIN_SHARED * Math.max(before.trim().length, after.trim().length)) return undefined;
  return { removed: spansFor(tokens, 1), added: spansFor(tokens, 2) };
}

/** Add an extra background over `spans` inside an already-styled string. */
function injectWordBg(styled: string, spans: { start: number; end: number }[], wordBg: string, lineBg: string): string {
  if (!spans.length) return styled;
  let out = "";
  let raw = 0;
  let si = 0;
  let inSpan = false;
  let i = 0;
  while (i < styled.length) {
    const ch = styled[i];
    if (ch === "\x1b") {
      const m = styled.slice(i).match(/^\x1b\[[0-9;?]*[@-~]/);
      out += m ? m[0] : ch;
      i += m ? m[0].length : 1;
      continue;
    }
    for (;;) {
      if (inSpan && si < spans.length && raw === spans[si].end) {
        out += lineBg;
        inSpan = false;
        si++;
        continue;
      }
      if (!inSpan && si < spans.length && raw === spans[si].start) {
        out += wordBg;
        inSpan = true;
        continue;
      }
      break;
    }
    out += ch;
    raw++;
    i++;
  }
  if (inSpan) out += lineBg;
  return out;
}

/**
 * Syntax-highlight every diff body as one snippet, so multi-line strings, block
 * comments and docstrings keep their scope across lines. Returns one entry per
 * input line, or undefined when the highlighter does not line up.
 */
function highlightBodies(bodies: string[], lang: string | undefined): string[] | undefined {
  try {
    const highlighted = highlightCode(bodies.join("\n"), lang);
    return highlighted.length === bodies.length ? highlighted : undefined;
  } catch {
    return undefined;
  }
}

type DiffEntry = { sign: "+" | "-" | " "; num: string; content: string; sep?: boolean };

/** Tabs are expanded before measuring, highlighting and word-diffing a line. */
const tabs = (s: string) => s.replace(/\t/g, "   ");

const parseDiffLine = (line: string): DiffEntry | null => {
  const m = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
  if (!m) return null;
  return { sign: m[1] as "+" | "-" | " ", num: m[2].trim(), content: m[3] };
};

/** Context lines shown around each change; pi's diff carries 4, we trim to 3. */
const CONTEXT_LINES = 3;
/** Diff lines shown before the preview is cut; the expand key shows the rest. */
const DIFF_PREVIEW_LINES = 16;

/**
 * Edit result rendering, Claude-Code-style: a single
 * `⎿  Added X lines, removed Y lines` header, then the diff below it — changed
 * lines with tinted numbers and bands, and (collapsed only) up to 3 context
 * lines around each change with `...` between distant hunks. The caller caps
 * the preview; expanded shows the diff untrimmed.
 */
function renderUpdateResult(diffText: string, lang: string | undefined, expanded: boolean, theme: any): Row[] {
  const entries: DiffEntry[] = [];
  for (const line of diffText.split("\n")) {
    const parsed = parseDiffLine(line);
    if (!parsed) {
      entries.push({ sign: " ", num: "", content: line });
      continue;
    }
    // pi emits ` ` + blank number + ` ...` between distant hunks.
    if (parsed.sign === " " && parsed.num === "" && parsed.content.trim() === "...") {
      entries.push({ sign: " ", num: "", content: "...", sep: true });
      continue;
    }
    entries.push(parsed);
  }
  if (!entries.some((e) => e.sign !== " ")) return [];

  // Trim context runs to CONTEXT_LINES around changes, keeping the lines
  // adjacent to each change. A run between two changes that had lines dropped
  // gets a `...` separator so the hunks stay visually apart.
  const isChange = (e: DiffEntry) => e.sign !== " ";
  const prevIsChange = (idx: number) => {
    for (let k = idx - 1; k >= 0; k--) {
      if (entries[k].sep) continue;
      return isChange(entries[k]);
    }
    return false;
  };
  const nextIsChange = (idx: number) => {
    for (let k = idx + 1; k < entries.length; k++) {
      if (entries[k].sep) continue;
      return isChange(entries[k]);
    }
    return false;
  };
  const shown: DiffEntry[] = expanded
    ? entries
    : (() => {
        // Trim context runs to CONTEXT_LINES around changes, keeping the lines
        // adjacent to each change. A run between two changes that had lines
        // dropped gets a `...` separator so the hunks stay visually apart.
        const out: DiffEntry[] = [];
        let i = 0;
        while (i < entries.length) {
          const e = entries[i];
          if (e.sep || isChange(e)) {
            out.push(e);
            i++;
            continue;
          }
          let j = i;
          while (j < entries.length && !entries[j].sep && !isChange(entries[j])) j++;
          const run = entries.slice(i, j);
          const afterChange = prevIsChange(i);
          const beforeChange = nextIsChange(j - 1);
          if (afterChange && beforeChange) {
            if (run.length <= CONTEXT_LINES * 2) {
              out.push(...run);
            } else {
              out.push(...run.slice(0, CONTEXT_LINES));
              out.push({ sign: " ", num: "", content: "...", sep: true });
              out.push(...run.slice(run.length - CONTEXT_LINES));
            }
          } else if (afterChange) {
            out.push(...run.slice(0, CONTEXT_LINES));
          } else if (beforeChange) {
            out.push(...run.slice(Math.max(0, run.length - CONTEXT_LINES)));
          }
          i = j;
        }
        return out;
      })();

  let adds = 0;
  let dels = 0;
  for (const e of entries) {
    if (e.sign === "+") adds++;
    else if (e.sign === "-") dels++;
  }
  const parts: string[] = [];
  if (adds > 0) parts.push(`Added ${bold(String(adds))} ${adds === 1 ? "line" : "lines"}`);
  if (dels > 0) parts.push(`Removed ${bold(String(dels))} ${dels === 1 ? "line" : "lines"}`);
  // CC wording: "Added 8 lines, removed 2 lines" — lowercase after the first part.
  const summary = parts.map((p, i2) => (i2 === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1))).join(", ");
  const rows: Row[] = [row(`${MUTED}⎿${C.reset}  ${summary}`)];

  const numWidth = Math.max(1, ...entries.filter((e) => !e.sep).map((e) => e.num.length));
  const pad = " ".repeat(DIFF_INDENT);
  const palette = diffPalette(theme);
  // Highlight the rendered lines together, not one at a time.
  const flat = shown.filter((e) => !e.sep);
  const highlighted = highlightBodies(flat.map((e) => tabs(e.content)), lang);
  const wordSpans = pairWordDiffs(entries);
  let bodyIndex = 0;
  for (let k = 0; k < shown.length; k++) {
    const e = shown[k];
    if (e.sep) {
      rows.push(row(pad + MUTED + " ".repeat(numWidth + 4) + "..." + C.reset));
      continue;
    }
    const num = e.num.padStart(numWidth);
    const bodyIndexHere = bodyIndex++;
    if (e.sign === " ") {
      // 4 spaces after the number = num + space + sign + 2 spaces on change
      // rows, so +/- doesn't shift content relative to context lines.
      rows.push(row(pad + CTX_NUM_FG + num + "    " + theme.fg("toolDiffContext", tabs(e.content)) + C.reset));
      continue;
    }
    const isDel = e.sign === "-";
    const lineBg = isDel ? palette.delLineBg : palette.addLineBg;
    const content = tabs(e.content);
    let body = highlighted?.[bodyIndexHere] ?? content;
    // A highlighter reset would end the band early; re-emit it after each one.
    if (lineBg) body = paintOn(body, lineBg);
    const spans = wordSpans.get(e);
    if (spans) {
      body = injectWordBg(body, isDel ? spans.before : spans.after, isDel ? palette.delWordBg : palette.addWordBg, lineBg);
    }
    // The gutter carries the add/remove color; the body keeps the syntax colors
    // of the active theme.
    const gutter = paintOn(theme.fg(isDel ? "toolDiffRemoved" : "toolDiffAdded", pad + `${num} ${e.sign}  `), lineBg);
    rows.push({ text: lineBg + gutter + body + C.reset, bg: lineBg });
  }
  return rows;
}

// ============================================================================
// Extension registration
// ============================================================================

// ============================================================================
// File-tool guidelines
// ============================================================================

// Some models default to shell heredocs and sed even with pi's own guidance.
// Preferring the file tools also means the change is drawn as a diff.
const FILE_TOOL_GUIDELINES: Record<string, string[]> = {
  read: ["Use read to view file contents instead of cat, head, tail or sed -n in bash."],
  edit: [
    "Use edit to change existing files instead of bash: never modify files with sed -i, perl -pi, python or node scripts, or shell redirection.",
  ],
  write: [
    "Use write to create new files or fully rewrite small ones instead of bash: never create files with cat <<EOF, echo or printf redirection, tee, or python scripts.",
    "write creates missing parent directories itself, so call it directly instead of combining mkdir -p with a heredoc in bash.",
  ],
};

/** Path shown by the listing tools, relative to the session cwd. */
const listingPath = (value: unknown, cwd: string | undefined, fallback: string): string => {
  const raw = typeof value === "string" && value !== "" ? value : fallback;
  return link(relativePath(raw, cwd));
};

/** Builds one tool's renderers; `fallback` is pi's own renderer for that tool. */
type Build = (fallback: ToolRenderers | undefined) => ToolRenderers;

const RENDERERS: Record<string, Build> = {
  // ---- Bash ----------------------------------------------------------------

  bash: () => ({
    // Render our own shell: skips pi's default Box (Spacer + paddingY), which
    // put two blank lines between the model's text and tool rows. One blank
    // line remains, matching Claude Code; the gutter keeps alignment.
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      startTiming(context);
      const command = typeof args?.command === "string" ? args.command : "";
      const timeoutSuffix = args?.timeout ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
      const cmdLines = command ? command.split("\n") : [theme.fg("toolOutput", "...")];
      const rows: Row[] = [row(`${dotFor(context)} ${bold("bash")}(${cmdLines[0]})${timeoutSuffix}`)];
      const extra = cmdLines.slice(1);
      if (extra.length > 0) {
        if (cmdLines.length > BASH_CALL_MAX_LINES && !context.expanded) {
          // Long command: collapsed header shows just the first line.
          rows.push(row(`       ${MUTED}… +${extra.length} lines${C.reset} (${keyHint("app.tools.expand", "to expand")})`));
        } else {
          for (const l of extra) rows.push(row("       " + l));
        }
      }
      return new LinesComponent(rows, context.outputPad);
    },
    renderResult(result: any, options: any, _theme: any, context: any) {
      // Streaming header, `done in 1.2s (12 lines)` header, body cap, and the
      // truncation footnote all live in the shared renderer (also used by the
      // listing tools and the generic uniform renderer in claude-uniform.ts).
      return renderStreamedOutput(result, options, context);
    },
  }),

  // ---- Read ----------------------------------------------------------------

  read: (fallback) => ({
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      const p = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
      const display = p ? relativePath(p, context.cwd) : theme.fg("toolOutput", "...");
      const start = args?.offset ?? 1;
      const range =
        args?.limit !== undefined
          ? theme.fg("muted", `:${start}-${start + args.limit - 1}`)
          : args?.offset !== undefined
            ? theme.fg("muted", `:${start}`)
            : "";
      return new LinesComponent([row(`${dotFor(context)} ${bold("read")}(${link(display)})${range}`)], context.outputPad);
    },
    renderResult(result: any, options: any, theme: any, context: any) {
      if (context.isError) {
        return new LinesComponent([row(`${MUTED}⎿${C.reset}  ` + ERROR_FG + textOutput(result) + C.reset)], context.outputPad);
      }
      const lines = trimTrailingEmpty(textOutput(result).split("\n"));
      // Expanded: show the full content via the built-in renderer,
      // like pi does natively. Collapsed stays a one-line summary.
      if (lines.length === 0 || options.expanded) {
        return fallback?.renderResult?.(result, options, theme, context) ?? renderStreamedOutput(result, options, context);
      }
      const suffix = result?.details?.truncation?.truncated ? " (truncated)" : "";
      return new LinesComponent([row(`${MUTED}⎿${C.reset}  Read ${lines.length} ${lines.length === 1 ? "line" : "lines"}${suffix}`)], context.outputPad);
    },
  }),

  // ---- Write ---------------------------------------------------------------

  write: () => ({
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      const p = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
      const display = p ? relativePath(p, context.cwd) : theme.fg("toolOutput", "...");
      return new LinesComponent([row(`${dotFor(context)} ${bold("write")}(${link(display)})`)], context.outputPad);
    },
    renderResult(result: any, _options: any, theme: any, context: any) {
      if (context.isError) {
        return new LinesComponent([row(`${MUTED}⎿${C.reset}  ` + ERROR_FG + textOutput(result) + C.reset)], context.outputPad);
      }
      return new LinesComponent([row(`${MUTED}⎿${C.reset}  Written`)], context.outputPad);
    },
  }),

  // ---- Update (edit) -------------------------------------------------------

  edit: (fallback) => ({
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      const p = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
      const display = p ? relativePath(p, context.cwd) : theme.fg("toolOutput", "...");
      return new LinesComponent([row(`${dotFor(context)} ${bold("edit")}(${link(display)})`)], context.outputPad);
    },
    renderResult(result: any, options: any, theme: any, context: any) {
      const diff = !context.isError ? (result?.details?.diff as string | undefined) : undefined;
      const path = context.args?.path ?? context.args?.file_path;
      const lang = typeof path === "string" ? getLanguageFromPath(path) : undefined;
      const rows = diff ? renderUpdateResult(diff, lang, options.expanded === true, theme) : [];
      if (rows.length === 0) {
        return fallback?.renderResult?.(result, options, theme, context) ?? renderStreamedOutput(result, options, context);
      }
      // rows[0] is the summary line; the rest is the diff itself.
      const over = rows.length - 1 - DIFF_PREVIEW_LINES;
      if (options.expanded || over <= 0) return new LinesComponent(rows, context.outputPad);
      const shownRows = rows.slice(0, 1 + DIFF_PREVIEW_LINES);
      shownRows.push(
        row(
          " ".repeat(DIFF_INDENT) +
            `${MUTED}… +${over} ${over === 1 ? "line" : "lines"}${C.reset} (${keyHint("app.tools.expand", "to expand")})`,
        ),
      );
      return new LinesComponent(shownRows, context.outputPad);
    },
  }),

  // ---- Grep / Find / Ls -----------------------------------------------------

  // The listing tools share the shell tools' result body (`⎿ done in 1.2s
  // (12 lines)` + indented output) so every built-in tool reads the same way.
  grep: () => ({
    renderShell: "self",
    renderCall(args: any, _theme: any, context: any) {
      startTiming(context);
      const pattern = typeof args?.pattern === "string" ? args.pattern : "";
      const glob = typeof args?.glob === "string" && args.glob ? `${MUTED} (${args.glob})${C.reset}` : "";
      const limit = args?.limit !== undefined ? `${MUTED} limit ${args.limit}${C.reset}` : "";
      const call = `${bold("grep")}(${link(`/${pattern}/`)}${MUTED} in ${C.reset}${listingPath(args?.path, context.cwd, ".")}${glob}${limit})`;
      return new LinesComponent([row(`${dotFor(context)} ${call}`)], context.outputPad);
    },
    renderResult(result: any, options: any, _theme: any, context: any) {
      return renderStreamedOutput(result, options, context);
    },
  }),

  find: () => ({
    renderShell: "self",
    renderCall(args: any, _theme: any, context: any) {
      startTiming(context);
      const pattern = typeof args?.pattern === "string" ? args.pattern : "";
      const limit = args?.limit !== undefined ? `${MUTED} (limit ${args.limit})${C.reset}` : "";
      const call = `${bold("find")}(${link(pattern)}${MUTED} in ${C.reset}${listingPath(args?.path, context.cwd, ".")}${limit})`;
      return new LinesComponent([row(`${dotFor(context)} ${call}`)], context.outputPad);
    },
    renderResult(result: any, options: any, _theme: any, context: any) {
      return renderStreamedOutput(result, options, context);
    },
  }),

  ls: () => ({
    renderShell: "self",
    renderCall(args: any, _theme: any, context: any) {
      startTiming(context);
      const limit = args?.limit !== undefined ? `${MUTED} (limit ${args.limit})${C.reset}` : "";
      const call = `${bold("ls")}(${listingPath(args?.path, context.cwd, ".")})${limit}`;
      return new LinesComponent([row(`${dotFor(context)} ${call}`)], context.outputPad);
    },
    renderResult(result: any, options: any, _theme: any, context: any) {
      return renderStreamedOutput(result, options, context);
    },
  }),
};

export default function (pi: ExtensionAPI) {
  // Renderers only: pi keeps its own tool definitions, schemas, execution,
  // permissions, hooks and on/off state. `next()` is the rest of the resolver
  // chain (and finally the tool's own renderers), so a tool we do not handle
  // falls through to pi or to another extension.
  pi.registerToolRenderer((toolName, next) => RENDERERS[toolName]?.(next()) ?? next());

  // pi only lists a tool's guidelines while the tool is on.
  pi.on("before_agent_start", async (event) => {
    const guidelines = event.systemPromptOptions.toolGuidelines;
    for (const [name, rules] of Object.entries(FILE_TOOL_GUIDELINES)) {
      const existing = guidelines[name] ?? [];
      guidelines[name] = [...existing, ...rules.filter((rule) => !existing.includes(rule))];
    }
  });

  // ---- Thinking lines ------------------------------------------------------

  // The expand key collapses thinking runs to a one-line summary (styled
  // dim/italic by the built-in thinking renderer); expanded shows the text.
  // While the block is still streaming the expand hint would advertise a
  // finished block, so it waits for the message to settle.
  // Assistant and user markers are drawn by claude-markers.ts.
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== "assistant-thinking") return markdown;
    if (claudeState.thinkingExpanded) return markdown;
    if (context.isStreaming) return "· thinking…";
    return `· thinking… (${keyHint("app.tools.expand", "to expand")})`;
  });
}
