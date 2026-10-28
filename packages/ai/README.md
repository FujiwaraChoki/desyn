# @desyn/ai

Desyn's AI layer: provider registry and per-task model routing, media generation, the design agent and its
tools, design-intelligence prompts, durable workflows and an eval harness. Isomorphic TypeScript (ESM). It runs in
Convex Node actions (server keys and decrypted BYOK keys), in the browser (BYOK in "local keys" mode, Ollama and
other local servers) and in Node (Agent API, evals). Built on Vercel AI SDK 7 (`ai@7`). The contract it follows
is `docs/DOCUMENT_MODEL.md`. The architecture is described in `docs/SPEC.md` §7.

This is an internal package: `exports` points at `src/index.ts`, and consumers transpile it (Next
`transpilePackages`, Convex esbuild, Vite).

```
src/
  providers/   registry of 11 providers (zod config schemas for UI forms, create(), connectivity probes),
               env / workspace / user / local config resolution, fal queue transport
  models.ts    per-task routing table, resolveModel(), live catalogs (OpenRouter + fal) with a TTL cache
  media/       Media implementation (image, svg, bg removal, inpaint, outpaint, upscale, mockup, trace, video,
               speech), fal endpoint adapters, SVG sanitizer/optimizer, built-in raster tracer, moderation
  byok.ts      AES-GCM key encryption (WebCrypto), key redaction for logs
  credits.ts   action -> config/plans.json creditCosts, estimates, CreditMeter, settlement helpers
  host.ts      DocHost interface (+ memory-host.ts: MemoryHost on @desyn/doc-ops)
  design/      TS describe / measure / render / reflow / brand mapping / localization helpers
  tools/       the agent tools from SPEC §7 (zod inputs, compact diffs, one transaction per edit)
  agent/       runAgent (ToolLoopAgent + streaming events), generateDesign pipeline, model setup
  prompts/     design-intelligence system prompts, kind guides, font pairings, untrusted-content guard
  search/      stock (Unsplash, Pexels) and Iconify providers
  workflows/   campaign, variants, resize, localize, bulk, exportBundle as resumable step machines
evals/         golden prompts, rule-based scoring, real-provider harness (opt-in)
```

## Providers and routing

| Provider            | Kinds                                         | Config                                   |
| ------------------- | --------------------------------------------- | ---------------------------------------- |
| `openrouter`        | text, embedding                               | env `OPENROUTER_API_KEY` or BYOK          |
| `fal`               | image, video, speech, transcription           | env `FAL_AI_API_KEY` or BYOK (passed explicitly) |
| `ollama`            | text, embedding                               | env `OLLAMA_BASE_URL` or local base URL   |
| `openai-compatible` | text, image, embedding                        | base URL + optional key (LM Studio, vLLM…) |
| `anthropic`, `openai`, `google`, `mistral`, `groq`, `replicate` | as each SDK supports | BYOK                    |

Config precedence is `local > user > workspace > env`. Billing follows the source: `platform` (env keys),
`byok` (free when `plans.fairUse.byokBypassesCredits`) or `local`.

```ts
import { createProviders, envProviderConfigs, testProvider } from "@desyn/ai";

const providers = createProviders({
  env: envProviderConfigs(),              // reads env var names only; values are never logged
  user: { anthropic: { apiKey: decryptedUserKey } },
});
await testProvider("openrouter", { apiKey }); // { ok, latencyMs, message, models? }
```

The default routes are `resolveModel(task, prefs)`: user override, then workspace, then env
(`DESYN_AI_MODEL_<TASK>="provider:model"`), then the pinned default, then the pinned fallbacks. A candidate is
skipped when its provider is not configured. The pinned ids were verified against
`https://openrouter.ai/api/v1/models` and `https://api.fal.ai/v1/models` (see `MODELS_VERIFIED_AT`).

| Task | Default | Fallbacks |
| --- | --- | --- |
| agent, vision, svg | `openrouter:anthropic/claude-sonnet-5.5` | sonnet-5, opus-5.5 |
| plan, critique | `openrouter:anthropic/claude-opus-5.5` | opus-5, sonnet-5.5 |
| copy, translate | `openrouter:anthropic/claude-haiku-5.5` | haiku-4.5, sonnet-5.5 |
| image | `fal:blackforestlabs/flux-3/text-to-image` | google/nano-banana-2.1 |
| imageText | `fal:ideogram/v4.5` | google/nano-banana-2.1 |
| vector | `fal:fal-ai/recraft/v4.1/text-to-vector` | recraft v4 |
| bgRemove | `fal:fal-ai/birefnet/v2` | fal-ai/bria/background/remove |
| inpaint | `fal:fal-ai/flux-pro/v1/fill` | fal-ai/bria/genfill |
| outpaint | `fal:fal-ai/flux-2-pro/outpaint` | fal-ai/bria/expand |
| upscale | `fal:fal-ai/seedvr/upscale/image` | topaz/upscale/image/precision |
| mockup | `fal:google/nano-banana-2.1/edit` | bytedance/seedream/v5/pro/edit |
| trace | `fal:fal-ai/recraft/vectorize` | `builtin:posterize-trace` (offline) |
| video | `fal:alibaba/wan-3.0-prime/image-to-video` | bytedance/seedance-2.5 |
| speech | `fal:elevenlabs/tts/eleven-v4` | fal-ai/minimax/speech-2.8-hd |
| embedding | `openrouter:google/gemini-embedding-2` | openai/text-embedding-3-small |

`listModels()` fetches both public catalogs and caches them for six hours. Pass `fetch` to supply your own
transport. `modelsForTask(catalog, task)` filters the catalog for a settings picker, and
`missingPinnedModels(catalog)` reports pinned ids that have disappeared from the catalogs.

## The agent

```ts
import { MemoryHost, runAgent, generateDesign } from "@desyn/ai";

const result = await runAgent({
  host,                       // DocHost: WasmHost (browser), WorkerHost (Convex), MemoryHost (tests)
  goal: "Make the headline bigger and warmer",
  mode: "edit",               // "edit" | "generate" | "critique"
  providers, prefs,
  history,                    // previous ModelMessages (result.responseMessages of earlier runs)
  signal, maxSteps: 24,
  budget: { credits: 30, tokens: 400_000, usd: 1 },
  onEvent: (e) => {/* start | step | thinking | text | tool-call | tool-result | applied-tx | preview | plan |
                      progress | credits | question | error | done */},
});
// result: { status: completed | needs-input | budget-exceeded | step-limit | cancelled | failed, summary,
//           changes, transactions, createdIds, credits, usage, costUsd, responseMessages, question? }

await generateDesign({ host, prompt: "A poster for a jazz night", providers });
// plan (structured brief) -> assets in parallel -> build -> render_preview -> critique -> fix (max N) -> finish
```

How the agent behaves:
- **Edits:** every edit is one `host.apply(tx)` with `source: "ai"` and `actor.runId`, so a run is a single undo
  group that collaborators see live.
- **Tool results:** each result returns a compact diff (`created`, `updated`, `deleted`) and new ids.
- **Untrusted content:** design text, brand voice and tool output are wrapped in
  `<<untrusted source=…>>` delimiters. The system prompt forbids following instructions found inside them.
- **Destructive bulk operations:** these need `confirmDestructive` or `allowDestructive`. Without either, the
  agent refuses and asks the user.
- **Limits:** the step, credit, token and USD caps force a final `finish` call. Cancelling stops the run between
  stream parts.

Tools (names exact, SPEC §7): `read_design`, `read_selection`, `render_preview`, `query_elements`,
`create_elements`, `update_elements`, `delete_elements`, `duplicate_elements`, `group_elements`, `ungroup`,
`set_roles`, `arrange`, `set_text`, `rewrite_text`, `translate_text`, `set_style`, `apply_brand`, `add_page`,
`delete_page`, `reorder_pages`, `resize_page`, `generate_image`, `generate_svg`, `remove_background`, `inpaint`,
`outpaint`, `upscale`, `mockup`, `trace_to_vector`, `search_stock`, `search_icons`, `search_templates`,
`apply_template`, `critique`, `plan`, `ask_user`, `run_workflow`, `finish`. `describeDesignTools()` returns
their JSON schemas (for the Agent API / MCP server), and `toolsForMode(mode)` gives each mode's allowlist.

## Media

```ts
const media = createMedia({ providers, prefs, meter, moderation, onProgress });
const [img] = await media.generateImage({ prompt, width: 1536, height: 1024, palette: ["#0b0b0f", "#ffb02e"] });
// { bytes | url, mime, width, height, provider, model, prompt, seed, costCredits }
await media.generateSvg({ prompt: "a sun icon", kind: "icon", palette });
await media.removeBackground({ image });
await media.inpaint({ image, mask, prompt });
await media.outpaint({ image, direction: "right", target: { width: 2048, height: 1024 } });
await media.upscale({ image, factor: 2 });
await media.mockup({ design, scene: "poster on a gallery wall" });
await media.trace({ image });
await media.generateVideo({ prompt, image, durationSec: 5 });
await media.speech({ text });
```

`generateSvg` runs a text LLM in a validate/repair loop. Its output is sanitized (no script, foreignObject,
event handlers or external refs), optimized, given a `viewBox`, and has its colors snapped to the brand palette.
Prompts go through the moderation hook (`createRuleModeration`, `createModelModeration`, `combineModeration`)
before any provider call.

## Workflows

Each workflow is a `WorkflowDefinition` over JSON-serializable `WorkflowState`. Convex persists the state and
schedules one `stepWorkflow(state, env)` per action, so runs can resume and can be cancelled between steps
(`cancelWorkflow`). Optional steps (one preset, one row, one locale) fail without failing the run.

```ts
const state = startWorkflow("resize", { designId, presets: ["instagram-story", "poster-a3"] });
estimateWorkflow("localize", { designId, locales: ["de", "ar"] }); // { total, lines }
const next = await stepWorkflow(state, env); // env: loadDesign, createDesign, openHost, providers, media, exporter…
```

- **campaign:** brief, then one concept/design system, then a shared key visual, then one agent-built design
  per deliverable.
- **variants:** A/B directions along one axis (`copy`, `color`, `layout` or `image`). Each variant is a copy
  edited only on that axis.
- **resize:** smart reflow using roles and constraints (not just scaling), then mechanical fixes from describe,
  then an optional agent polish.
- **localize:** one translation pass over all pages, then length-aware refit, script fonts and RTL mirroring.
- **bulk:** RFC 4180 CSV merged into `meta.slot` layers (text is fitted; image URLs and asset ids, colors and
  QR codes are supported).
- **exportBundle:** designs × formats become export jobs, run through `env.exporter`.

## BYOK and credits

```ts
const blob = await encryptKey(apiKey, process.env.AI_KEY_ENCRYPTION_SECRET!, { aad: byokAad(userId, "openai") });
const key = await decryptKey(blob, secret, { aad: byokAad(userId, "openai") });
redactSecrets("Bearer sk-…") // safe for logs; redactKey / keyHint for UI

estimateAgentRun({ maxSteps: 24 });           // reserve before a run
const meter = new CreditMeter(limit);         // charges per action from config/plans.json creditCosts
settleCredits(reserved, meter.used);          // { charge, release, overage } for the Convex ledger
```

## Verify

```sh
pnpm --filter @desyn/ai typecheck
pnpm --filter @desyn/ai test     # offline: AI SDK mock models, fake fal transport, fake fetch
pnpm --filter @desyn/ai lint
pnpm --filter @desyn/ai evals    # real providers; skipped unless OPENROUTER_API_KEY is set
```

The evals in `evals/golden.ts` build or edit designs from golden prompts. `evals/score.ts` scores each result
deterministically: run status, roles, required and forbidden copy, font count, and the contrast, overflow,
off-page, tiny-text, hierarchy and error lints from describe. `DESYN_EVAL_CASES=id1,id2` runs a subset, and
`DESYN_EVAL_REPORT=path.json` writes a JSON report.
