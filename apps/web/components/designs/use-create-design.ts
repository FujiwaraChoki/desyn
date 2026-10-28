"use client";

import type { DesignKind, Unit } from "@desyn/schema";
import { toast } from "@desyn/ui";
import { useConvex, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { aiBackend, isMissingFunction } from "@/lib/ai-backend";
import { track } from "@/lib/analytics";
import { api, type Id } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { MAX_PROMPT_LENGTH } from "@/lib/infer-kind";
import { markPromptForAutostart } from "@/lib/prompt-handoff";
import { routes } from "@/lib/routes";

export interface CreateInput {
  kind?: DesignKind;
  presetId?: string;
  size?: { width: number; height: number; unit?: Unit };
  name?: string;
  folderId?: Id<"folders"> | null;
}

/**
 * Creates a design in the current workspace and opens it in the editor. With a prompt, the editor
 * opens with the AI dock prefilled (`?prompt=`) so the agent starts from the user's words.
 */
export function useCreateDesign() {
  const router = useRouter();
  const { workspaceId } = useApp();
  const convex = useConvex();
  const create = useMutation(api.designs.designs.create);
  const [pending, setPending] = useState<string | null>(null);

  const createDesign = useCallback(
    async (input: CreateInput, options: { prompt?: string; key?: string } = {}) => {
      const key = options.key ?? input.presetId ?? input.kind ?? "custom";
      setPending(key);
      try {
        const { designId } = await create({
          workspaceId,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.presetId ? { presetId: input.presetId } : {}),
          ...(input.size ? { size: input.size } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.folderId ? { folderId: input.folderId } : {}),
        });
        track("design_created", {
          kind: input.kind ?? null,
          preset: input.presetId ?? null,
          source: options.prompt ? "ai_prompt" : "blank",
        });
        const prompt = options.prompt?.trim().slice(0, MAX_PROMPT_LENGTH);
        if (!prompt) {
          router.push(routes.design(designId));
          return designId;
        }
        // Start the server-run agent when the backend offers it; the editor follows the run. Without
        // it, the editor opens with the prompt prefilled in its AI dock.
        try {
          const { runId } = await convex.mutation(aiBackend.runAgent, {
            designId,
            goal: prompt,
            mode: "generate",
          });
          router.push(`${routes.design(designId)}?run=${encodeURIComponent(runId)}`);
        } catch (error) {
          if (!isMissingFunction(error)) toast.error(errorMessage(error));
          markPromptForAutostart(designId, prompt);
          router.push(`${routes.design(designId)}?prompt=${encodeURIComponent(prompt)}`);
        }
        return designId;
      } catch (error) {
        toast.error(errorMessage(error));
        setPending(null);
        return null;
      }
    },
    [create, convex, workspaceId, router],
  );

  return { createDesign, pending };
}
