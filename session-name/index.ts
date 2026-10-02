/**
 * session-name — kebab-case session names for Pi.
 *
 * /rename [name]   set a name, or generate one from the conversation.
 * Auto-generate    after the first exchange; regenerate at the configured
 *                  user-turn count while the name is still AI-generated.
 * A user-set name is never overwritten.
 *
 * The generated name is also what Pi shows in the /resume session list;
 * claude-ui's footer renders it on its own first line.
 *
 * Config: ~/.pi/agent/session-name.json (optional):
 *   { "autoGenerate": true, "regenerateAfterTurns": 3, "model": "" }
 *   - model: "provider/id" for name generation; empty = current model.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH =
  process.env.SESSION_NAME_CONFIG || join(homedir(), ".pi", "agent", "session-name.json");
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 40;
const MAX_WORDS = 4;
const MAX_CONVERSATION_CHARS = 1200;
const NAME_TIMEOUT_MS = 15_000;
const EVENT_CHANGED = "session-name-changed";

// Adapted from Claude Code's kebab-case session name prompt.
const KEBAB_PROMPT = [
  "Generate a short kebab-case name (2-4 words) that captures the main topic of this conversation.",
  "Use lowercase words separated by hyphens.",
  'Examples: "fix-login-bug", "add-auth-feature", "refactor-api-client", "debug-test-failures".',
  'Return JSON with a "name" field.',
].join(" ");

type NameOrigin = "ai" | "user";

type Config = {
  autoGenerate: boolean;
  regenerateAfterTurns: number;
  model: string;
};

function loadConfig(): Config {
  const defaults: Config = { autoGenerate: true, regenerateAfterTurns: 3, model: "" };
  try {
    const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return defaults;
    const obj = raw as Record<string, unknown>;
    return {
      autoGenerate: obj.autoGenerate !== false,
      regenerateAfterTurns:
        typeof obj.regenerateAfterTurns === "number"
          ? Math.max(0, Math.floor(obj.regenerateAfterTurns))
          : defaults.regenerateAfterTurns,
      model: typeof obj.model === "string" ? obj.model : defaults.model,
    };
  } catch {
    return defaults;
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, MAX_WORDS)
    .join("-");
}

/** Accept JSON, a quoted name field, or plain kebab text; always validate. */
function sanitizeName(raw: string): string | null {
  let text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let candidate = "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { name?: unknown }).name === "string"
    ) {
      candidate = (parsed as { name: string }).name;
    }
  } catch {
    /* not JSON */
  }
  if (!candidate) {
    const match = /"name"\s*:\s*"([^"]+)"/.exec(text);
    candidate = match?.[1] ?? text.split("\n")[0] ?? "";
  }
  const slug = slugify(candidate);
  if (!slug || slug.length > MAX_NAME_LENGTH || !KEBAB_RE.test(slug)) return null;
  return slug;
}

function textFromContent(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
  }
  return parts;
}

/** User + assistant text only, tail-sliced so recent context wins. */
function extractConversationText(ctx: ExtensionContext): string {
  const parts: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    parts.push(...textFromContent(message.content));
  }
  const text = parts.join("\n").trim();
  return text.length > MAX_CONVERSATION_CHARS ? text.slice(-MAX_CONVERSATION_CHARS) : text;
}

function firstUserText(ctx: ExtensionContext): string {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role !== "user") continue;
    const text = textFromContent(message.content).join("\n").trim();
    if (text) return text;
  }
  return "";
}

function countUserTurns(ctx: ExtensionContext): number {
  let count = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && (entry.message as { role?: string }).role === "user") count++;
  }
  return count;
}

function pickModel(ctx: ExtensionContext, config: Config) {
  const spec = config.model.trim();
  if (spec) {
    const slash = spec.indexOf("/");
    if (slash > 0) {
      const found = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
      if (found && ctx.modelRegistry.hasConfiguredAuth(found)) return found;
    }
  }
  return ctx.model ?? null;
}

async function generateName(ctx: ExtensionContext, config: Config): Promise<string | null> {
  const conversation = extractConversationText(ctx);
  if (!conversation) return null;
  const model = pickModel(ctx, config);
  if (!model) return null;
  try {
    const response = await ctx.modelRegistry.complete(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: `${KEBAB_PROMPT}\n\nConversation:\n${conversation}` }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal: AbortSignal.timeout(NAME_TIMEOUT_MS),
        maxTokens: 256,
        reasoning: "minimal",
        cacheRetention: "none",
        sessionId: ctx.sessionManager.getSessionId(),
      },
    );
    if (process.env.SESSION_NAME_TEST === "1") {
      const blocks = response.content
        .map((part) => {
          const typed = part as { type?: string; text?: string };
          return `${typed.type ?? "?"}:${typed.text?.length ?? 0}`;
        })
        .join(", ");
      const meta = response as { stopReason?: string; usage?: { output?: number }; errorMessage?: string };
      console.error(
        `[session-name] response blocks: ${blocks}; stop=${meta.stopReason ?? "?"}; out=${meta.usage?.output ?? "?"}; err=${meta.errorMessage ?? "none"}`,
      );
    }
    const text = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (process.env.SESSION_NAME_TEST === "1") {
      console.error(`[session-name] raw: ${JSON.stringify(text.slice(0, 200))}`);
    }
    return sanitizeName(text);
  } catch (error) {
    if (process.env.SESSION_NAME_TEST === "1") {
      console.error(
        `[session-name] model call failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const debug = process.env.SESSION_NAME_TEST === "1";
  let generating = false;
  let aiNamed = false;

  const announce = () => pi.events.emit(EVENT_CHANGED, undefined);

  const setName = (name: string, origin: NameOrigin) => {
    pi.setSessionName(name);
    aiNamed = origin === "ai";
    pi.appendEntry("session-name", { origin });
    announce();
  };

  // Reconstruct whether the current name is AI-generated (a user rename wins).
  pi.on("session_start", (_event, ctx) => {
    aiNamed = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "session-name") {
        aiNamed = (entry.data as { origin?: string } | undefined)?.origin === "ai";
      }
    }
  });

  pi.registerCommand("rename", {
    description: "Set the session display name; without an argument, generate one from the conversation",
    handler: async (args, ctx) => {
      const explicit = args.trim();
      if (explicit) {
        setName(explicit, "user");
        ctx.ui.notify(`Session named: ${explicit}`, "info");
        return;
      }
      if (generating) return;
      generating = true;
      try {
        const generated = await generateName(ctx, config);
        if (!generated) {
          ctx.ui.notify(
            "Could not generate a name: no conversation context yet. Usage: /rename <name>",
            "warning",
          );
          return;
        }
        setName(generated, "ai");
        ctx.ui.notify(`Session named: ${generated}`, "info");
      } finally {
        generating = false;
      }
    },
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!config.autoGenerate || generating) return;
    if (!ctx.hasUI && !debug) return;

    const turns = countUserTurns(ctx);
    const current = pi.getSessionName();
    const shouldGenerate = !current && turns >= 1;
    const shouldRegenerate =
      aiNamed &&
      config.regenerateAfterTurns > 0 &&
      turns === config.regenerateAfterTurns;
    if (!shouldGenerate && !shouldRegenerate) return;

    generating = true;
    try {
      // Instant placeholder from the first user message while the model runs.
      if (!current) {
        const placeholder = slugify(firstUserText(ctx));
        if (placeholder) {
          pi.setSessionName(placeholder);
          aiNamed = true;
          pi.appendEntry("session-name", { origin: "ai" });
          announce();
        }
      }
      const generated = await generateName(ctx, config);
      if (generated) {
        setName(generated, "ai");
        if (debug) console.error(`[session-name] generated: ${generated}`);
      } else if (debug) {
        console.error("[session-name] generation failed; keeping current name");
      }
    } finally {
      generating = false;
    }
  });
}
