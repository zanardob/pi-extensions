/**
 * Small command aliases.
 *
 * /exit   → same as /quit
 * /rename → same as /name (set or show the session display name)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("exit", {
    description: "Alias for /quit",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  pi.registerCommand("rename", {
    description: "Alias for /name — set or show the session display name",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (name) {
        pi.setSessionName(name);
        ctx.ui.notify(`Session named: ${name}`, "info");
      } else {
        const current = pi.getSessionName();
        ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
      }
    },
  });
}
