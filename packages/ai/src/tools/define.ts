// Tool definition helper: every tool returns `{ ok: true, summary, … }` or `{ ok: false, error, hint }` instead of
// throwing, so the model can read the failure and correct itself within the same run.
import { type Tool, tool } from "ai";
import type { z } from "zod";
import { redactSecrets } from "../byok";
import { AiError } from "../errors";
import { isAbortError, throwIfAborted } from "../util/async";
import { type ToolContext, ToolInputError, type ToolResult } from "./types";

export interface DesignToolSpec<S extends z.ZodType> {
  description: string;
  inputSchema: S;
  execute: (input: z.output<S>, ctx: ToolContext) => Promise<ToolResult>;
  toModelOutput?: Tool<z.output<S>, ToolResult>["toModelOutput"];
}

export function failure(error: unknown): ToolResult {
  if (error instanceof ToolInputError)
    return { ok: false, error: error.message, ...(error.hint ? { hint: error.hint } : {}) };
  if (error instanceof AiError) {
    const hint =
      error.code === "provider-not-configured"
        ? "Tell the user which provider to configure in Settings › AI providers, then continue without this asset."
        : error.code === "budget-exceeded"
          ? "Stop generating assets; finish with what exists and mention the limit."
          : error.code === "moderation-blocked"
            ? "Do not retry this request; choose a different, acceptable subject."
            : undefined;
    return {
      ok: false,
      error: redactSecrets(error.message),
      code: error.code,
      ...(hint ? { hint } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: redactSecrets(message) };
}

export function designTool<S extends z.ZodType>(
  ctx: ToolContext,
  spec: DesignToolSpec<S>,
): Tool<z.output<S>, ToolResult> {
  return tool({
    description: spec.description,
    inputSchema: spec.inputSchema,
    execute: async (input: z.output<S>) => {
      try {
        throwIfAborted(ctx.signal);
        return await spec.execute(input, ctx);
      } catch (error) {
        if (isAbortError(error)) throw error;
        return failure(error);
      }
    },
    ...(spec.toModelOutput ? { toModelOutput: spec.toModelOutput } : {}),
  }) as Tool<z.output<S>, ToolResult>;
}
