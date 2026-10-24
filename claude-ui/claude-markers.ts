import { AssistantMessageComponent, UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { C } from "./claude-shared/style.ts";

// ============================================================================
// Transcript markers: ● on assistant text, ❯ on the prompt.
//
// pi 1.3 has no hook for assistant or user rows — MessageRenderer and
// EntryRenderer cover custom messages and custom entries only — so the markers
// wrap the two built-in components' rendering instead of being spliced into the
// markdown. Drawing them after the fact:
//   - survives a message that opens with a fence, heading, list or table,
//   - can carry ANSI, so the prompt arrow is dimmed and the reply dot is not
//     forced into the paragraph's colour,
//   - leaves the stored message clean, so a copied transcript has no markers.
//
// Both classes come from the extension module alias, so they are the objects pi
// instantiates. If a pi upgrade reshapes them, the patch is skipped and the
// marker disappears rather than breaking the transcript; the skipped patch is
// reported once on session_start.
// ============================================================================

const REPLY = "●";
const PROMPT = "❯";
/** Columns taken from every rendered line and given back as the marker gutter. */
const GUTTER = 2;
/** Narrower than this the markdown itself no longer fits beside the gutter (its
 *  own padding plus a column of text), so the marker is dropped rather than
 *  pushing the row past the terminal. */
const MIN_WIDTH = GUTTER + 3;
const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";
/** Zero-width sequences: OSC 133 shell-integration zones, which pi puts at the
 *  start of a row, and its styling. */
const ZONE = /^((?:\x1b\][^\x07]*\x07)*)/;
const SGR_RUN = /^((?:\x1b\[[0-9;]*m)*)/;
const ANSI = /\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g;
/** Terminal image protocols own the whole line; a prefix would corrupt them. */
const IMAGE = /^\x1b(_G|]1337;)/;
const patched = Symbol.for("claude-ui.markers");

type Prefix = (line: string, first: boolean) => string;

/** Index of the first line with visible text; skips spacers, padding and image rows. */
function firstTextLine(lines: string[]): number {
  return lines.findIndex((line) => !IMAGE.test(line) && line.replace(ANSI, "").trim() !== "");
}

/**
 * Prepend a two-column gutter to every line, after any leading OSC zone so the
 * zone still starts the row. `prefix` gets the line so it can match the styling
 * the line already carries.
 */
function addGutter(lines: string[], prefix: Prefix): string[] {
  const first = firstTextLine(lines);
  if (first < 0) return lines;
  return lines.map((line, i) => {
    if (IMAGE.test(line)) return line;
    const zone = ZONE.exec(line)?.[1] ?? "";
    const body = line.slice(zone.length);
    return zone + prefix(body, i === first) + body;
  });
}

/**
 * `mark` on the first line with text, two blank columns on the rest. The marker
 * sits where a tool row puts its status dot: one column in when the row carries
 * pi's padding, at the very start when it does not.
 */
function markerGutter(mark: string, line: string, first: boolean): string {
  if (!first) return "  ";
  const carried = SGR_RUN.exec(line)?.[1] ?? "";
  return line.charAt(carried.length) === " " ? ` ${mark}` : `${mark} `;
}

const replyPrefix: Prefix = (line, first) => markerGutter(REPLY, line, first);

/**
 * The prompt arrow sits inside the message's background band, so it re-emits the
 * styling the row already opens with and closes it before the row resumes its
 * own. Nothing here has to know which colour the band is.
 */
const promptPrefix: Prefix = (line, first) => {
  const carried = SGR_RUN.exec(line)?.[1];
  const mark = markerGutter(`${DIM}${PROMPT}${UNDIM}`, line, first);
  return carried ? carried + mark + C.reset : mark;
};

/** Wrap one component's render: two columns narrower, then the gutter goes back on. */
function wrapRender(component: { render(width: number): string[] }, prefix: Prefix): void {
  const instance = component as { render: (width: number) => string[]; [patched]?: boolean };
  if (instance[patched]) return;
  const render = instance.render.bind(component);
  instance.render = (width: number) => (width >= MIN_WIDTH ? addGutter(render(width - GUTTER), prefix) : render(width));
  instance[patched] = true;
}

function patchMethod(target: any, method: string, name: string, wrap: (original: (...args: any[]) => any) => (...args: any[]) => any, problems: string[]): void {
  const original = target?.[method];
  if (typeof original !== "function") {
    problems.push(`${name}.${method} is gone`);
    return;
  }
  if (original[patched]) return;
  const replacement: any = wrap(original);
  replacement[patched] = true;
  target[method] = replacement;
}

/** Marks each markdown text block of an assistant message; thinking blocks arrive as MouseRegion. */
function patchAssistant(problems: string[]): void {
  patchMethod(AssistantMessageComponent.prototype, "updateContent", "AssistantMessageComponent", (original) => {
    return function (this: any, ...args: any[]) {
      const result = original.apply(this, args);
      const children = this.contentContainer?.children;
      if (!Array.isArray(children)) {
        problems.push("AssistantMessageComponent.contentContainer is gone");
        return result;
      }
      for (const child of children) if (child instanceof Markdown) wrapRender(child, replyPrefix);
      return result;
    };
  }, problems);
}

function patchUser(problems: string[]): void {
  patchMethod(UserMessageComponent.prototype, "render", "UserMessageComponent", (original) => {
    return function (this: any, width: number) {
      if (width < MIN_WIDTH) return original.call(this, width);
      return addGutter(original.call(this, width - GUTTER), promptPrefix);
    };
  }, problems);
}

export default function (pi: ExtensionAPI) {
  const problems: string[] = [];
  try {
    patchAssistant(problems);
    patchUser(problems);
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (problems.length === 0) return;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify(`claude-ui: message markers off — ${problems.join("; ")}`, "warning");
  });
}
