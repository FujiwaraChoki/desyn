"use client";

import { toast } from "@desyn/ui";
import { type ConvexReactClient, useConvex } from "convex/react";
import { useEffect, useState } from "react";
import { EditorProvider } from "./context.tsx";
import { EditorController, type EditorControllerOptions, type Notice } from "./controller.ts";
import { BUILTIN_EXTENSIONS } from "./extensions.ts";
import type { EditorExtension } from "./shell/extensions.ts";
import { describeLoadError, ErrorScreen, LoadingScreen } from "./shell/screens.tsx";
import { Shell } from "./shell/shell.tsx";
import { createConvexBackend, type EditorBackend } from "./sync/convex-transport.ts";
import type { Telemetry } from "./sync/sync-client.ts";
import type { ShareArg } from "./sync/wire.ts";

/**
 * Props of <Editor/>. The first six are the contract apps/web relies on (apps/web/lib/editor-contract.ts);
 * the rest are for other hosts and tests.
 */
export interface EditorProps {
  /** Convex `designs` document id. */
  designId: string;
  /** Share-link token when opened through /share/[token] (view / comment / edit by link). */
  shareToken?: string;
  /** Dashboard prompt to prefill in the AI dock (sent by itself only when `autoStartPrompt`). */
  initialPrompt?: string;
  autoStartPrompt?: boolean;
  /** Server-run agent started by the dashboard; the AI dock follows its events. */
  runId?: string;
  /** Where "Back to designs" goes. */
  exitHref: string;
  /** Convex client (default: the one from <ConvexProvider>). */
  convex?: ConvexReactClient;
  /** Backend override (tests, other hosts). Wins over `convex`. */
  backend?: EditorBackend;
  /** Extra extensions after the built-in ones. */
  extensions?: EditorExtension[];
  /** Telemetry sink (default: a `desyn:editor-telemetry` window event). */
  onTelemetry?: Telemetry;
  /** Navigation override (default: full page navigation). */
  navigate?: (href: string) => void;
  engine?: EditorControllerOptions["engine"];
}

/** Share-link passwords live in sessionStorage (apps/web/lib/share-access.ts uses the same key). */
function shareArg(token: string | undefined): ShareArg | undefined {
  if (!token) return undefined;
  try {
    const password = sessionStorage.getItem(`desyn-share-pw:${token}`);
    return password ? { token, password } : { token };
  } catch {
    return { token };
  }
}

function toastNotice(n: Notice): void {
  const opts = n.description ? { description: n.description } : {};
  if (n.kind === "error") toast.error(n.title, opts);
  else if (n.kind === "warning") toast.warning(n.title, opts);
  else if (n.kind === "success") toast.success(n.title, opts);
  else toast.info(n.title, opts);
}

/**
 * The Desyn editor for one design. Client-only: mount it after hydration (it drives a WebAssembly engine in
 * a worker). Needs <ConvexProvider> (or `convex` / `backend`) and @desyn/ui's <DesynProvider> above it.
 */
export function Editor(props: EditorProps) {
  const contextClient = useConvex() as ConvexReactClient | undefined;
  const client = props.convex ?? contextClient;
  const [editor, setEditor] = useState<EditorController | null>(null);
  const { designId, shareToken, backend: backendProp } = props;

  // The editor is rebuilt only for another design / link / backend; other props are read at creation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const share = shareArg(shareToken);
    const backend = backendProp ?? (client ? createConvexBackend(client, designId, share) : null);
    if (!backend) return;
    const controller = new EditorController({
      designId,
      shareToken: shareToken ?? null,
      exitHref: props.exitHref,
      backend,
      convex: client ?? null,
      ...(share ? { share } : {}),
      extensions: [...BUILTIN_EXTENSIONS, ...(props.extensions ?? [])],
      notify: toastNotice,
      ai: {
        initialPrompt: props.initialPrompt ?? null,
        autoStart: props.autoStartPrompt ?? false,
        runId: props.runId ?? null,
      },
      ...(props.onTelemetry ? { telemetry: props.onTelemetry } : {}),
      ...(props.navigate ? { navigate: props.navigate } : {}),
      ...(props.engine ? { engine: props.engine } : {}),
    });
    setEditor(controller);
    void controller.start();
    return () => {
      setEditor(null);
      void controller.dispose();
    };
  }, [designId, shareToken, client, backendProp]);

  if (!backendProp && !client) {
    return (
      <ErrorScreen
        info={describeLoadError(
          { code: "INTERNAL", message: "The editor has no connection to the Desyn backend." },
          { exitHref: props.exitHref, shareToken: shareToken ?? null, designId },
        )}
      />
    );
  }
  if (!editor) return <LoadingScreen />;
  return (
    <EditorProvider editor={editor}>
      <Shell />
    </EditorProvider>
  );
}
