import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";

// Defensive theme helpers: fall back to identity functions if the theme
// implementation does not expose fg/bold, or a colour key is missing in the
// active theme (a missing key must never crash the TUI).
function makeStyle(theme: any) {
  const fg =
    typeof theme?.fg === "function"
      ? (color: string, text: string) => {
          try {
            return theme.fg(color, text);
          } catch {
            return text;
          }
        }
      : (_color: string, text: string) => text;
  const bold = typeof theme?.bold === "function" ? (text: string) => theme.bold(text) : (text: string) => text;
  const styled = (color: string, text: string) => fg(color, bold(text));
  return { fg, bold, styled };
}

function addUsage(total: Usage, usage: Usage | undefined): void {
  if (!usage) return;
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  total.totalTokens += usage.totalTokens ?? 0;
  total.reasoning = (total.reasoning ?? 0) + (usage.reasoning ?? 0);
  total.cost.input += usage.cost?.input ?? 0;
  total.cost.output += usage.cost?.output ?? 0;
  total.cost.cacheRead += usage.cost?.cacheRead ?? 0;
  total.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
  total.cost.total += usage.cost?.total ?? 0;
}

function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
  return `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}

/** Compact context window size: 1000000 -> "1.0M", 128000 -> "128k". */
function formatContextWindow(tokens: number | undefined): string | null {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function prettyModel(id: string | undefined): string {
  if (!id) return "unknown";
  return id
    .replace(/^claude[-_]/i, "Claude ")
    .replace(/^gpt[-_]/i, "GPT ")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Hide the reasoning share below this percent (mirrors tmustier's usage insights). */
const REASONING_MIN_PERCENT = 5;

/** Theme key for a level: thinkingOff … thinkingMax (already in every theme). */
function thinkingColorKey(level: string): string {
  return THINKING_LEVELS.has(level) ? `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}` : "footerDim";
}

/** Current effective thinking level; "off" when the model cannot reason. */
function currentThinkingLevel(pi: ExtensionAPI, ctx: any): string | undefined {
  try {
    const level = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : ctx?.thinkingLevel;
    return typeof level === "string" && level !== "" ? level : undefined;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  let startedAt = Date.now();
  // Set while a custom footer is mounted, so thinking-level changes can repaint
  // the footer without waiting for the next unrelated render.
  let requestRender: (() => void) | undefined;

  pi.on("thinking_level_select", () => {
    requestRender?.();
  });

  pi.on("session_start", (_event, ctx) => {
    startedAt = Date.now();

    ctx.ui.setFooter((tui, theme, footerData) => {
      const { styled } = makeStyle(theme);
      requestRender = () => tui.requestRender();
      const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
      const unsubName = pi.events.on("session-name-changed", () => tui.requestRender());
      const interval = setInterval(() => tui.requestRender(), 30_000);

      // Track uncommitted line changes (+added, -removed vs HEAD), refreshed in the background.
      let gitStats = { added: 0, removed: 0 };
      const refreshGitStats = () => {
        execFile("git", ["diff", "--numstat", "HEAD"], { cwd: ctx.cwd }, (err, stdout) => {
          if (err) {
            if (gitStats.added !== 0 || gitStats.removed !== 0) {
              gitStats = { added: 0, removed: 0 };
              tui.requestRender();
            }
            return;
          }
          let added = 0;
          let removed = 0;
          for (const line of stdout.split("\n")) {
            const [a, r] = line.split("\t");
            if (a && a !== "-") added += parseInt(a, 10) || 0;
            if (r && r !== "-") removed += parseInt(r, 10) || 0;
          }
          if (added !== gitStats.added || removed !== gitStats.removed) {
            gitStats = { added, removed };
            tui.requestRender();
          }
        });
      };
      refreshGitStats();
      const statsInterval = setInterval(refreshGitStats, 10_000);

      return {
        dispose: () => {
          requestRender = undefined;
          unsubBranch();
          unsubName();
          clearInterval(interval);
          clearInterval(statsInterval);
        },
        invalidate() {},
        render(width: number): string[] {
          const total: Usage = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };

          for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "message") {
              addUsage(total, (entry.message as { usage?: Usage }).usage);
            } else if (entry.type === "compaction" || entry.type === "branch_summary") {
              addUsage(total, entry.usage);
            }
          }

          const context = ctx.getContextUsage();
          const percent = context?.percent ?? 0;
          const contextWindow = formatContextWindow(context?.contextWindow ?? ctx.model?.contextWindow);
          // True session age from the session file header (survives reloads and
          // resumes). `startedAt` is only the fallback for sessions without a file yet.
          const header = ctx.sessionManager.getHeader();
          const sessionStart = header?.timestamp ? Date.parse(header.timestamp) : startedAt;
          const sessionAge = Date.now() - (Number.isFinite(sessionStart) ? sessionStart : startedAt);
          const branch = footerData.getGitBranch();
          const sessionName = pi.getSessionName();

          // footer* theme keys mirror ccstatusline's truecolor table so the
          // footer matches Claude Code's: model teal, ctx grey, session/cost
          // amber, cwd blue, git purple (stats amber). Thinking uses the
          // theme's own thinking<Level> colour (same key the editor border
          // uses), so the footer always agrees with the active level.
          const thinking = currentThinkingLevel(pi, ctx);
          const line1Parts = [styled("footerModel", ` model: ${prettyModel(ctx.model?.id)}`), "  "];
          if (thinking) {
            line1Parts.push(styled(thinkingColorKey(thinking), `thinking: ${thinking}`), "  ");
          }
          // Share of output tokens that were hidden reasoning (provider-reported only).
          const reasoningShare =
            total.output > 0 ? ((total.reasoning ?? 0) / total.output) * 100 : null;
          if (reasoningShare !== null && reasoningShare >= REASONING_MIN_PERCENT) {
            line1Parts.push(styled("footerReason", `reason: ${Math.round(reasoningShare)}%`), "  ");
          }
          line1Parts.push(
            styled("footerDim", contextWindow ? `context: ${Math.round(percent)}% / ${contextWindow}` : `context: ${Math.round(percent)}%`),
            "  ",
            styled("footerWarn", `session: ${formatDuration(sessionAge)}`),
            "  ",
            styled("footerWarn", `cost: ${formatCost(total.cost.total)}`),
          );
          const line1 = line1Parts.join("");

          const line2 = styled("footerPath", ` cwd: ${ctx.cwd}`);
          // Extension statuses are shown as plain text: emoji are stripped so
          // third-party status icons (e.g. ketch's globe) don't leak into the
          // Claude-style footer.
          const stripEmoji = (text: string) =>
            text
              .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
              .replace(/\s{2,}/g, " ")
              .trim();
          const statuses = [...footerData.getExtensionStatuses().values()]
            .map(stripEmoji)
            .filter((text) => text.length > 0);
          const line3 = branch
            ? styled("footerGit", ` ⎇ ${branch}`) + styled("footerWarn", ` (+${gitStats.added},-${gitStats.removed})`)
            : styled("footerGit", " ⎇ no git");
          // Extension hints live on their own line, below the git status.
          const statusLine = statuses.length > 0 ? styled("footerDim", ` ${statuses.join("  ")}`) : undefined;

          const nameLine = sessionName
            ? styled("footerModel", ` name: ${sessionName}`)
            : undefined;
          const lines = nameLine ? [nameLine, line1, line2, line3] : [line1, line2, line3];
          if (statusLine) lines.push(statusLine);
          return lines.map((line) => truncateToWidth(line, width, ""));
        },
      };
    });
  });
}
