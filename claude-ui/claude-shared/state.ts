// Shared state between claude-editor.ts and claude-tools.ts.
// Lives in a subdirectory (not extensions/*.ts) so pi's auto-discovery
// doesn't try to load it as an extension — only top-level *.ts and
// */index.ts files are treated as extension entry points.
export const claudeState = {
  /** app.tools.expand state for thinking blocks: false = one-line summary, true = full text. */
  thinkingExpanded: false,
};
