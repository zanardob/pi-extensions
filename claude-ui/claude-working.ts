import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { C } from "./claude-shared/style.ts";

// ============================================================================
// Working line above the editor: what the run is doing now, how long it has
// taken, and how many output tokens it has produced.
//
// pi draws the row itself — the status container between the transcript and the
// editor — and its message there is the constant "Working". setWorkingMessage
// replaces the text, setWorkingIndicator the spinner, and both have to be
// re-applied because the text only changes when something sets it.
//
// pi renders that message through theme.fg("muted", …), so the phase word
// carries its own colour and the stats stay dim. Custom indicator frames render
// verbatim, which is what lets the spinner keep Claude Code's orange instead of
// following the theme's accent.
// ============================================================================

const ORANGE = "\x1b[38;2;217;119;87m";
const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";
/** Claude Code's asterisk cycle. ✱ rather than ✳, which some terminals draw as an emoji. */
const FRAMES = ["·", "✢", "✱", "✶", "✻", "✽", "✻", "✶", "✱", "✢"].map((frame) => `${ORANGE}${frame}${C.reset}`);
const FRAME_MS = 120;
const TICK_MS = 1000;
/** Tokens per character of streamed text, for the live estimate. */
const CHARS_PER_TOKEN = 4;
/** Longer phases wrap the row onto a second line, which shifts the editor. */
const PHASE_MAX = 40;
/** Claude Code's spinner verbs (`constants/spinnerVerbs.ts`), minus the ones branded
 *  after Claude itself. One is picked per run, the way Claude Code picks it per mount. */
const VERBS = [
  "Accomplishing", "Actioning", "Actualizing", "Architecting",
  "Baking", "Beaming", "Beboppin'", "Befuddling",
  "Billowing", "Blanching", "Bloviating", "Boogieing",
  "Boondoggling", "Booping", "Bootstrapping", "Brewing",
  "Bunning", "Burrowing", "Calculating", "Canoodling",
  "Caramelizing", "Cascading", "Catapulting", "Cerebrating",
  "Channeling", "Channelling", "Choreographing", "Churning",
  "Coalescing", "Cogitating", "Combobulating", "Composing",
  "Computing", "Concocting", "Considering", "Contemplating",
  "Cooking", "Crafting", "Creating", "Crunching",
  "Crystallizing", "Cultivating", "Deciphering", "Deliberating",
  "Determining", "Dilly-dallying", "Discombobulating", "Doing",
  "Doodling", "Drizzling", "Ebbing", "Effecting",
  "Elucidating", "Embellishing", "Enchanting", "Envisioning",
  "Evaporating", "Fermenting", "Fiddle-faddling", "Finagling",
  "Flambéing", "Flibbertigibbeting", "Flowing", "Flummoxing",
  "Fluttering", "Forging", "Forming", "Frolicking",
  "Frosting", "Gallivanting", "Galloping", "Garnishing",
  "Generating", "Gesticulating", "Germinating", "Gitifying",
  "Grooving", "Gusting", "Harmonizing", "Hashing",
  "Hatching", "Herding", "Honking", "Hullaballooing",
  "Hyperspacing", "Ideating", "Imagining", "Improvising",
  "Incubating", "Inferring", "Infusing", "Ionizing",
  "Jitterbugging", "Julienning", "Kneading", "Leavening",
  "Levitating", "Lollygagging", "Manifesting", "Marinating",
  "Meandering", "Metamorphosing", "Misting", "Moonwalking",
  "Moseying", "Mulling", "Mustering", "Musing",
  "Nebulizing", "Nesting", "Newspapering", "Noodling",
  "Nucleating", "Orbiting", "Orchestrating", "Osmosing",
  "Perambulating", "Percolating", "Perusing", "Philosophising",
  "Photosynthesizing", "Pollinating", "Pondering", "Pontificating",
  "Pouncing", "Precipitating", "Prestidigitating", "Processing",
  "Proofing", "Propagating", "Puttering", "Puzzling",
  "Quantumizing", "Razzle-dazzling", "Razzmatazzing", "Recombobulating",
  "Reticulating", "Roosting", "Ruminating", "Sautéing",
  "Scampering", "Schlepping", "Scurrying", "Seasoning",
  "Shenaniganing", "Shimmying", "Simmering", "Skedaddling",
  "Sketching", "Slithering", "Smooshing", "Sock-hopping",
  "Spelunking", "Spinning", "Sprouting", "Stewing",
  "Sublimating", "Swirling", "Swooping", "Symbioting",
  "Synthesizing", "Tempering", "Thinking", "Thundering",
  "Tinkering", "Tomfoolering", "Topsy-turvying", "Transfiguring",
  "Transmuting", "Twisting", "Undulating", "Unfurling",
  "Unravelling", "Vibing", "Waddling", "Wandering",
  "Warping", "Whatchamacalliting", "Whirlpooling", "Whirring",
  "Whisking", "Wibbling", "Working", "Wrangling",
  "Zesting", "Zigzagging",
];

const pickVerb = (): string => VERBS[Math.floor(Math.random() * VERBS.length)] ?? "Working";

/** Trims to `PHASE_MAX` once the message's trailing ellipsis is added. */
const clip = (text: string): string => (text.length > PHASE_MAX - 1 ? text.slice(0, PHASE_MAX - 1) : text);

const baseName = (value: unknown): string => (typeof value === "string" && value ? value.split("/").pop() || value : "");

const firstLine = (value: unknown): string => (typeof value === "string" ? value.split("\n")[0] : "");

/** `412`, `1.2k`, `12.3k` — enough precision to see the number move. */
const formatTokens = (tokens: number): string => (tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`);

/** What a running tool is doing, in the same vocabulary as its transcript row. */
function toolPhase(name: string, args: any): string {
  const file = baseName(args?.path ?? args?.file_path);
  switch (name) {
    case "bash": {
      const command = firstLine(args?.command);
      return command ? `Running ${command}` : "Running a shell command";
    }
    case "read":
      return file ? `Reading ${file}` : "Reading a file";
    case "write":
      return file ? `Writing ${file}` : "Writing a file";
    case "edit":
      return file ? `Editing ${file}` : "Editing a file";
    case "grep":
    case "find":
      return args?.pattern ? `Searching for ${args.pattern}` : "Searching";
    case "ls":
      return file ? `Listing ${file}` : "Listing a directory";
    default:
      return `Running ${name}`;
  }
}

export default function (pi: ExtensionAPI) {
  let startedAt = 0;
  /** Output tokens of the messages that already finished in this run. */
  let tokens = 0;
  /** Characters streamed in the message that is still open. */
  let streamed = 0;
  /** Tokens shown so far in this message: the estimate must not walk back while it streams. */
  let shown = 0;
  /** The verb for this run's thinking phases; Claude Code picks one per mount too. */
  let verb = pickVerb();
  let phase = verb;
  let timer: ReturnType<typeof setInterval> | undefined;

  const active = (ctx: { hasUI: boolean; mode: string }): boolean => ctx.hasUI && ctx.mode === "tui";

  const show = (ctx: any): void => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    shown = Math.max(shown, tokens + Math.round(streamed / CHARS_PER_TOKEN));
    ctx.ui.setWorkingMessage(`${ORANGE}${clip(phase)}${C.reset}${DIM}… (${seconds}s · ↓ ${formatTokens(shown)} tokens)${UNDIM}`);
  };

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    if (!active(ctx)) return;
    ctx.ui.setWorkingIndicator({ frames: FRAMES, intervalMs: FRAME_MS });
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!active(ctx)) return;
    startedAt = Date.now();
    tokens = 0;
    streamed = 0;
    shown = 0;
    verb = pickVerb();
    phase = verb;
    show(ctx);
    stop();
    timer = setInterval(() => show(ctx), TICK_MS);
  });

  // The phase follows the content the model is producing right now.
  pi.on("message_update", (event, ctx) => {
    if (!active(ctx) || event.message.role !== "assistant") return;
    const content = (event.message as any).content ?? [];
    const last = content[content.length - 1];
    phase = last?.type === "text" ? "Responding" : last?.type === "toolCall" ? "Preparing a tool call" : verb;
    streamed = content.reduce((sum: number, part: any) => sum + (part.text?.length ?? part.thinking?.length ?? 0), 0);
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const output = (event.message as any).usage?.output;
    if (typeof output === "number") tokens += output;
    // The real count replaces the estimate, even when the estimate had run ahead.
    shown = tokens;
    streamed = 0;
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!active(ctx)) return;
    phase = toolPhase(event.toolName, event.args);
    show(ctx);
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    if (!active(ctx)) return;
    phase = verb;
  });

  pi.on("agent_end", (_event, ctx) => {
    stop();
    if (!active(ctx)) return;
    ctx.ui.setWorkingMessage();
  });

  pi.on("session_shutdown", () => stop());
}
