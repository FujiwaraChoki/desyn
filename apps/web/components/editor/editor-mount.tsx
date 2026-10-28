"use client";

import { useSearchParams } from "next/navigation";
import { type ComponentType, lazy, Suspense, useEffect, useRef, useState } from "react";
import type { EditorProps } from "@/lib/editor-contract";
import { MAX_PROMPT_LENGTH } from "@/lib/infer-kind";
import { consumePromptAutostart } from "@/lib/prompt-handoff";
import { EditorSkeleton } from "./editor-skeleton";

// Client-only: the editor drives a WebAssembly engine in a worker with an OffscreenCanvas, none of
// which exists on the server, so the module is only requested after mount.
const Editor = lazy(() =>
  import("@desyn/editor").then((m) => ({ default: m.Editor as ComponentType<EditorProps> })),
);

/** Mounts `@desyn/editor`'s <Editor/> with the route's design id and URL state; skeleton meanwhile. */
export function EditorMount({ designId }: { designId: string }) {
  const params = useSearchParams();
  const [mounted, setMounted] = useState(false);
  const shareToken = params.get("share") ?? undefined;
  const prompt = params.get("prompt")?.slice(0, MAX_PROMPT_LENGTH) || undefined;
  // Read once (the marker is consumed): a ref survives React's dev double-invoked effects.
  const autoStartRead = useRef(false);
  const [autoStart, setAutoStart] = useState(false);
  useEffect(() => {
    if (!autoStartRead.current) {
      autoStartRead.current = true;
      setAutoStart(consumePromptAutostart(designId, prompt));
    }
    setMounted(true);
  }, [designId, prompt]);
  const runId = params.get("run") ?? undefined;
  const exitHref = shareToken ? `/share/${encodeURIComponent(shareToken)}` : "/";
  const skeleton = (
    <EditorSkeleton
      designId={designId}
      exitHref={exitHref}
      {...(shareToken ? { shareToken } : {})}
    />
  );
  if (!mounted) return skeleton;
  return (
    <Suspense fallback={skeleton}>
      <Editor
        designId={designId}
        exitHref={exitHref}
        {...(shareToken ? { shareToken } : {})}
        {...(prompt ? { initialPrompt: prompt, autoStartPrompt: autoStart } : {})}
        {...(runId ? { runId } : {})}
      />
    </Suspense>
  );
}
