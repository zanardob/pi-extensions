/**
 * Voice Dictation — live dictation for Pi with two interchangeable engines.
 *
 * Press the shortcut (default Alt+V) to start, press it again to stop and
 * finalize. Or hold Space to talk (push-to-talk): press and hold, release to
 * stop. The transcript streams into the editor while you speak.
 *
 *   provider "deepgram": Deepgram Nova-3 streaming — the same engine Claude
 *                        Code uses; keyterm boosting from project/branch.
 *   provider "apple":    on-device Apple DictationTranscriber (private, free).
 *   provider "auto":     Deepgram when an API key resolves, else Apple.
 *
 * Also registers a `transcribe_audio` tool for local audio files.
 *
 * Config: ~/.pi/agent/voice-dictation.json
 *   keybind        shortcut (default "alt+v")
 *   provider       "auto" | "deepgram" | "apple"
 *   fileProvider   same choices for the transcribe_audio tool
 *   locale         BCP-47 id like "en-GB" ("" = system locale)
 *   context        true/false: send project/branch/coding keyterms
 *   extraTerms     additional keyterms
 *   capture        { ffmpegPath, input } for Deepgram mic capture
 *   deepgram       { apiKey, apiKeyEnv, keychainService, model, language,
 *                    endpointingMs }
 */
import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import {
  BATCH_BIN,
  VOICE_BIN,
  deepgramLanguage,
  loadConfig,
  resolveDeepgramKey,
  sttLanguage,
} from "./config.ts";
import { buildLiveUrl, startDeepgramLive, transcribeWithDeepgram, type LiveBackend } from "./deepgram.ts";

const GLOBAL_TERMS = [
  "MCP", "symlink", "grep", "regex", "localhost", "codebase", "TypeScript",
  "JSON", "OAuth", "webhook", "gRPC", "dotfiles", "subagent", "worktree",
  "refactor", "rebase", "commit", "branch", "merge", "npm", "pnpm", "API", "CLI",
];
const MAX_TERMS = 50;

// Push-to-talk (hold Space). Terminals with the Kitty keyboard protocol send
// press/repeat/release events; other terminals only deliver auto-repeat
// characters, so the hold is detected from rapid repeats (like Claude Code).
const HOLD_EVENTS = 5;
const HOLD_FIRST_GAP_MS = 2500;
const HOLD_GAP_MS = 150;
const HOLD_RELEASE_MS = 650;
const HOLD_PRESS_MS = 350;

type HelperMessage = {
  type?: string;
  display?: string;
  text?: string;
  message?: string;
};

/** Split camelCase / kebab-case / snake_case / path fragments into words. */
function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[-_./\s]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && word.length <= 20);
}

export default function appleVoiceExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const keybind = (process.env.VOICE_DICTATION_KEYBIND || config.keybind) as KeyId;
  const idleHint = `voice: hold space or ${String(keybind)}`;

  let active = false;
  let stopping = false;
  let backend: LiveBackend | null = null;
  let sessionContext: ExtensionContext | null = null;
  let baseText = "";
  let startedAt = 0;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let lastError: string | null = null;

  // Push-to-talk state.
  let spaceRun = 0;
  let spaceRunLastAt = 0;
  let csiSpaceDown = false;
  let csiPendingSpaces = 0;
  let holdActive = false;
  let holdPressTimer: ReturnType<typeof setTimeout> | null = null;
  let holdReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  let strippedSpaces = 0;
  let receivedText = false;
  let terminalUnsubscribe: (() => void) | null = null;

  /**
   * Status shown in the footer via `setStatus`: works with the default footer
   * and with custom footers that render extension statuses (claude-footer).
   * Nothing is drawn above the editor.
   */
  const setIndicator = (footerText: string | undefined) => {
    const ui = sessionContext?.ui;
    if (!sessionContext?.hasUI || !ui) return;
    ui.setStatus("voice-dictation", footerText);
  };

  const applyTranscript = (display: string) => {
    if (!sessionContext?.hasUI) return;
    if (display.length > 0) receivedText = true;
    const separator = baseText && display && !/[\s\n]$/.test(baseText) ? " " : "";
    sessionContext.ui.setEditorText(baseText + separator + display);
  };

  const renderStatus = () => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const mm = Math.floor(elapsed / 60);
    const ss = String(elapsed % 60).padStart(2, "0");
    setIndicator(`● recording ${mm}:${ss}`);
  };

  const clearTimers = () => {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    if (holdPressTimer) { clearTimeout(holdPressTimer); holdPressTimer = null; }
    if (holdReleaseTimer) { clearTimeout(holdReleaseTimer); holdReleaseTimer = null; }
  };

  const endSession = (error: string | null) => {
    const ctx = sessionContext;
    if (!active) return;
    active = false;
    stopping = false;
    backend = null;
    holdActive = false;
    csiSpaceDown = false;
    spaceRun = 0;
    clearTimers();
    // A hold that produced no transcript gives back the stripped spaces.
    if (strippedSpaces > 0 && !receivedText && ctx?.hasUI) {
      ctx.ui.pasteToEditor(" ".repeat(strippedSpaces));
    }
    strippedSpaces = 0;
    receivedText = false;
    setIndicator(idleHint);
    if (error && ctx?.hasUI) ctx.ui.notify(`voice-dictation: ${error}`, "error");
  };

  async function buildTerms(ctx: ExtensionContext): Promise<string[]> {
    const terms = new Set<string>(GLOBAL_TERMS);
    if (config.context) {
      const project = basename(ctx.cwd || "");
      if (project.length > 2 && project.length <= 50) terms.add(project);
      for (const word of splitIdentifier(project)) terms.add(word);
      try {
        const { stdout, code } = await pi.exec("git", ["-C", ctx.cwd, "branch", "--show-current"]);
        if (code === 0) {
          for (const word of splitIdentifier(stdout.trim())) terms.add(word);
        }
      } catch {
        /* not a git repository */
      }
    }
    for (const term of config.extraTerms) terms.add(term);
    return [...terms].slice(0, MAX_TERMS);
  }

  const resolveKey = () => resolveDeepgramKey(config.deepgram, (command, args) => pi.exec(command, args));

  function startApple(ctx: ExtensionContext, locale: string, terms: string[]) {
    const args: string[] = [];
    if (locale) args.push("--locale", locale);
    if (terms.length > 0) args.push("--context", terms.join(","));
    if (process.env.VOICE_DICTATION_FILE) args.push("--file", process.env.VOICE_DICTATION_FILE);

    let child: ChildProcess;
    try {
      child = spawn(VOICE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      endSession(`cannot start helper (${String(error)})`);
      return;
    }

    backend = {
      stop: () => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      },
      kill: () => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      },
    };

    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      let message: HelperMessage;
      try {
        message = JSON.parse(line) as HelperMessage;
      } catch {
        return;
      }
      if (message.type === "result" && typeof message.display === "string") {
        applyTranscript(message.display);
      } else if (message.type === "done") {
        if (typeof message.text === "string" && message.text.length > 0) applyTranscript(message.text);
      } else if (message.type === "error") {
        lastError = String(message.message ?? "unknown error");
      }
    });
    child.on("error", (error) => {
      lastError = error.message;
    });
    child.on("close", (code) => {
      const error = lastError ?? (!stopping && code !== 0 ? `helper exited with code ${code}` : null);
      endSession(error);
    });
  }

  function startDeepgramBackend(locale: string, terms: string[], apiKey: string) {
    const url = buildLiveUrl({
      model: config.deepgram.model,
      language: deepgramLanguage(config, locale),
      endpointingMs: config.deepgram.endpointingMs,
      keyterms: terms,
    });
    backend = startDeepgramLive({
      apiKey,
      url,
      ffmpegPath: config.capture.ffmpegPath,
      audioInput: config.capture.input,
      onDisplay: applyTranscript,
      onReady: renderStatus,
      onExit: endSession,
    });
  }

  async function start(ctx: ExtensionContext) {
    active = true;
    stopping = false;
    sessionContext = ctx;
    baseText = ctx.ui.getEditorText();
    startedAt = Date.now();
    lastError = null;
    renderStatus();
    statusTimer = setInterval(renderStatus, 1000);

    const locale = (config.locale || sttLanguage()).trim();
    const terms = await buildTerms(ctx);

    let choice = config.provider;
    let apiKey = "";
    if (choice !== "apple") {
      apiKey = await resolveKey();
      if (!apiKey) {
        if (choice === "deepgram") {
          ctx.ui.notify("voice-dictation: no Deepgram key (set DEEPGRAM_API_KEY or deepgram.apiKey); using on-device engine", "warning");
        }
        choice = "apple";
      } else {
        choice = "deepgram";
      }
    }

    if (!active) return; // cancelled while resolving credentials
    if (choice === "deepgram") startDeepgramBackend(locale, terms, apiKey);
    else startApple(ctx, locale, terms);
  }

  const requestStop = () => {
    if (!active || stopping || !backend) return;
    stopping = true;
    setIndicator("● finalizing…");
    try { backend.stop(); } catch { /* ignore */ }
    killTimer = setTimeout(() => {
      try { backend?.kill(); } catch { /* ignore */ }
    }, 10000);
  };

  // ── Push-to-talk (hold Space) ───────────────────────────────────────────
  const armHoldRelease = () => {
    if (holdReleaseTimer) clearTimeout(holdReleaseTimer);
    holdReleaseTimer = setTimeout(() => endHold(), HOLD_RELEASE_MS);
  };

  const activateHold = (strip: number): boolean => {
    const ctx = sessionContext;
    if (!ctx?.hasUI || active) return false;
    if (strip > 0) {
      const text = ctx.ui.getEditorText();
      // Only strip when the typed spaces sit at the end of the editor text;
      // otherwise the cursor was mid-text and this was normal typing.
      if (!text.endsWith(" ".repeat(strip))) return false;
      ctx.ui.setEditorText(text.slice(0, text.length - strip));
      strippedSpaces = strip;
    }
    holdActive = true;
    armHoldRelease();
    void start(ctx);
    return true;
  };

  const endHold = () => {
    if (holdReleaseTimer) { clearTimeout(holdReleaseTimer); holdReleaseTimer = null; }
    if (holdPressTimer) { clearTimeout(holdPressTimer); holdPressTimer = null; }
    spaceRun = 0;
    csiSpaceDown = false;
    csiPendingSpaces = 0;
    if (holdActive) {
      holdActive = false;
      requestStop();
    }
  };

  const handleTerminalInput = (data: string): { consume?: boolean } | undefined => {
    const ctx = sessionContext;
    if (!ctx?.hasUI || data.length === 0) return undefined;
    if (active && !holdActive) return undefined; // shortcut recording: spaces type normally

    // Kitty keyboard protocol: \x1b[32u press, \x1b[32;1:2u repeat, \x1b[32;1:3u release
    const csiEvents = [...data.matchAll(/\x1b\[32(?::\d+)*(?:;(\d+)(?::(\d+))?)?u/g)];
    if (csiEvents.length > 0 && csiEvents.map((match) => match[0]).join("") === data) {
      const lastType = Number(csiEvents[csiEvents.length - 1]?.[2] ?? "1");
      if (lastType === 3) {
        csiSpaceDown = false;
        if (holdActive) {
          csiPendingSpaces = 0;
          endHold();
          return { consume: true };
        }
        if (holdPressTimer) { clearTimeout(holdPressTimer); holdPressTimer = null; }
        // Quick tap: the press was swallowed, so re-insert the space(s).
        const typed = csiPendingSpaces;
        csiPendingSpaces = 0;
        if (typed > 0) ctx.ui.pasteToEditor(" ".repeat(typed));
        return { consume: true };
      }
      csiSpaceDown = true;
      if (holdActive) {
        armHoldRelease();
        return { consume: true };
      }
      if (lastType === 2) {
        // Auto-repeat while held: definitely push-to-talk.
        if (holdPressTimer) { clearTimeout(holdPressTimer); holdPressTimer = null; }
        activateHold(0);
      } else if (!holdPressTimer) {
        csiPendingSpaces += csiEvents.filter((match) => Number(match[2] ?? "1") === 1).length;
        holdPressTimer = setTimeout(() => {
          holdPressTimer = null;
          if (csiSpaceDown) activateHold(0);
        }, HOLD_PRESS_MS);
      }
      return { consume: true };
    }

    // Legacy terminals: literal space auto-repeat.
    if (/^ +$/.test(data)) {
      if (holdActive) {
        armHoldRelease();
        return { consume: true };
      }
      const now = Date.now();
      const gap = now - spaceRunLastAt;
      const restart = spaceRun === 0 || gap > (spaceRun === 1 ? HOLD_FIRST_GAP_MS : HOLD_GAP_MS);
      spaceRun = restart ? data.length : spaceRun + data.length;
      spaceRunLastAt = now;
      if (spaceRun >= HOLD_EVENTS) {
        const strip = spaceRun - 1;
        spaceRun = 0;
        if (activateHold(strip)) return { consume: true };
      }
      return undefined;
    }

    // Any other key means the user is typing, not holding.
    spaceRun = 0;
    return undefined;
  };

  pi.registerShortcut(keybind, {
    description: "Voice Dictation: live dictation (Deepgram Nova-3 or on-device Apple)",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      if (active) {
        requestStop();
        return;
      }
      await start(ctx);
    },
  });

  const transcribeAudioTool = defineTool({
    name: "transcribe_audio",
    label: "Transcribe audio",
    description:
      "Transcribe a local audio file to text. Uses Deepgram Nova-3 when a Deepgram API key is configured, otherwise on-device Apple speech recognition. Supports wav, mp3, m4a, mp4, aac, flac, ogg, opus and webm files.",
    parameters: Type.Object({
      path: Type.String({
        description: "Local audio file path (absolute, starting with ~, or relative to the session working directory)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const raw = params.path.trim();
      const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
      const absolute = isAbsolute(expanded) ? expanded : join(ctx.cwd, expanded);
      try {
        await stat(absolute);
      } catch {
        throw new Error(`audio file not found: ${absolute}`);
      }

      const locale = (config.locale || sttLanguage()).trim();
      const terms = await buildTerms(ctx);
      let choice = config.fileProvider;
      let apiKey = "";
      if (choice !== "apple") {
        apiKey = await resolveKey();
        choice = apiKey ? "deepgram" : "apple";
      }

      if (choice === "deepgram") {
        const text = await transcribeWithDeepgram({
          apiKey,
          path: absolute,
          model: config.deepgram.model,
          language: deepgramLanguage(config, locale),
          keyterms: terms,
        });
        return {
          content: [{ type: "text" as const, text }],
          details: { text, provider: "deepgram", model: config.deepgram.model, path: absolute },
        };
      }

      const args = [absolute];
      if (locale) args.push("--locale", locale);
      const { stdout, code } = await pi.exec(BATCH_BIN, args);
      if (code !== 0) throw new Error(`on-device transcription failed (exit code ${code})`);
      const text = stdout.trim();
      if (!text) throw new Error("on-device transcription returned no text");
      return {
        content: [{ type: "text" as const, text }],
        details: { text, provider: "apple", model: "dictation", path: absolute },
      };
    },
  });
  pi.registerTool(transcribeAudioTool);

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    setIndicator(idleHint);
    if (typeof ctx.ui.onTerminalInput === "function") {
      terminalUnsubscribe = ctx.ui.onTerminalInput(handleTerminalInput);
    }
  });

  pi.on("session_shutdown", () => {
    if (backend) {
      try { backend.kill(); } catch { /* ignore */ }
    }
    if (terminalUnsubscribe) {
      try { terminalUnsubscribe(); } catch { /* ignore */ }
      terminalUnsubscribe = null;
    }
    active = false;
    backend = null;
    holdActive = false;
    csiSpaceDown = false;
    csiPendingSpaces = 0;
    spaceRun = 0;
    clearTimers();
    setIndicator(undefined);
  });
}
