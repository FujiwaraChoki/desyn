/**
 * Props the web app passes to `@desyn/editor`'s `<Editor/>` (mounted client-only at /design/[id]).
 * The editor package owns its implementation; this is the contract the route relies on.
 */
export interface EditorProps {
  /** Convex `designs` document id (the route param). */
  designId: string;
  /** Share-link token when the design was opened through /share/[token] (view/comment/edit by link). */
  shareToken?: string;
  /**
   * Prompt from "Describe a design" (`?prompt=`) to prefill in the AI dock when no server run was
   * started. Prefill only: the editor sends it by itself only when `autoStartPrompt` is true.
   */
  initialPrompt?: string;
  /**
   * True when this tab's dashboard handed `initialPrompt` over a moment ago (lib/prompt-handoff.ts),
   * so the AI dock should send it right away. Never true for a prompt that only arrived in a URL:
   * a crafted link must not run the agent (spending credits, editing the design) without a click.
   */
  autoStartPrompt?: boolean;
  /** A server-run agent started by the dashboard; the AI dock follows its events. */
  runId?: string;
  /** Where "back" / the logo menu should return to. */
  exitHref: string;
}
