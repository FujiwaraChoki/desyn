import { describe, expect, test } from "vitest";
import { pickExecution } from "../../src/ai/core/execution.ts";
import { aiLocked, gate, toAccountView, upgradeMessage } from "../../src/ai/core/gating.ts";
import {
  buildGoal,
  defaultMode,
  expandTarget,
  findLanguage,
  formatCredits,
  parseExpandArgs,
  parseSlash,
  parseUpscaleFactor,
  parseVariantArgs,
  slashSuggestions,
  textActionGoal,
} from "../../src/ai/core/prompt.ts";
import { account } from "./fake-ai-backend.ts";

describe("slash commands", () => {
  test("parse the command and its arguments", () => {
    expect(parseSlash("/image a sunlit vase")).toMatchObject({
      command: { id: "image" },
      args: "a sunlit vase",
    });
    expect(parseSlash("/REMOVE-BG")).toMatchObject({ command: { id: "remove-bg" }, args: "" });
    expect(parseSlash("/nope x")).toBeNull();
    expect(parseSlash("make it /image")).toBeNull();
  });

  test("suggest while the name is typed, stop at the first space", () => {
    expect(slashSuggestions("/")?.length).toBe(11);
    expect(
      slashSuggestions("/re")
        ?.map((c) => c.id)
        .slice(0, 2),
    ).toEqual(["remove-bg", "resize"]);
    expect(slashSuggestions("/upscale ")).toBeNull();
    expect(slashSuggestions("hello")).toBeNull();
    // Matches by label or description too.
    expect(slashSuggestions("/vector")?.map((c) => c.id)).toContain("svg");
  });

  test("expand arguments: ratio, words, direction and a prompt", () => {
    expect(parseExpandArgs("16:9 left beach at dusk")).toMatchObject({
      aspect: "16:9",
      direction: "left",
      prompt: "beach at dusk",
    });
    expect(parseExpandArgs("square")).toMatchObject({ aspect: "1:1", ratio: 1, direction: "all" });
    expect(parseExpandArgs("top 4x5").direction).toBe("up");
    expect(parseExpandArgs("more sky").ratio).toBeNull();
  });

  test("expand geometry grows only along the chosen direction", () => {
    const left = expandTarget(1000, 1000, 16 / 9, "left");
    expect(left).toMatchObject({
      width: 1778,
      height: 1000,
      grow: { left: 778, right: 0, top: 0, bottom: 0 },
    });
    const all = expandTarget(1000, 1000, 9 / 16, "all");
    expect(all.width).toBe(1000);
    expect(all.height).toBe(1778);
    expect(all.grow.top + all.grow.bottom).toBe(778);
    // Already wider than 1:1 when growing only vertically: height grows to match.
    expect(expandTarget(1600, 900, 1, "vertical")).toMatchObject({ width: 1600, height: 1600 });
    expect(expandTarget(1000, 500, 1, "horizontal")).toMatchObject({ width: 1000, height: 500 });
  });

  test("upscale and variants arguments", () => {
    expect(parseUpscaleFactor("4x")).toBe(4);
    expect(parseUpscaleFactor("")).toBe(2);
    expect(parseVariantArgs("5 colors")).toEqual({ count: 5, axis: "color" });
    expect(parseVariantArgs("")).toEqual({ count: 3, axis: null });
  });
});

describe("goals and modes", () => {
  test("the mode follows the selection", () => {
    expect(defaultMode(0)).toBe("edit-design");
    expect(defaultMode(2)).toBe("edit-selection");
  });

  test("goals carry the prompt first, then scope, attachments and the brand choice", () => {
    const g = buildGoal({
      mode: "edit-selection",
      prompt: " Warmer ",
      brand: true,
      attachments: ["ref.png"],
    });
    expect(g.startsWith("Warmer")).toBe(true);
    expect(g).toContain("Change only the selected elements");
    expect(g).toContain("ref.png");
    expect(g).toContain("Follow the brand kit");
    expect(buildGoal({ mode: "generate", prompt: "x", brand: false, attachments: [] })).toContain(
      "Do not apply the brand kit",
    );
    // No kit: nothing is said about brands; critique never restyles.
    expect(buildGoal({ mode: "edit-design", prompt: "x", brand: null, attachments: [] })).toBe("x");
    expect(
      buildGoal({ mode: "critique", prompt: "x", brand: true, attachments: [] }),
    ).not.toContain("brand");
  });

  test("text actions and languages", () => {
    expect(textActionGoal({ kind: "tone", tone: "Playful" }).goal).toContain("playful tone");
    expect(textActionGoal({ kind: "translate", language: "German" }).label).toBe(
      "Translate to German",
    );
    expect(findLanguage("de")?.label).toBe("German");
    expect(findLanguage("japan")?.code).toBe("ja");
    expect(findLanguage("")).toBeNull();
    expect(formatCredits(0)).toBe("free");
    expect(formatCredits(1)).toBe("1 credit");
    expect(formatCredits(5)).toBe("5 credits");
  });
});

describe("plan gating", () => {
  test("free plans see upgrade prompts, Pro and self-host do not", () => {
    const free = account("free");
    expect(gate(free, "agent.edit")).toEqual({ state: "upgrade", feature: "ai.agent" });
    expect(gate(free, "removeBackground")).toEqual({
      state: "upgrade",
      feature: "ai.removeBackground",
    });
    expect(gate(free, "workflow.resize")).toEqual({ state: "upgrade", feature: "workflows" });
    expect(aiLocked(free)).toBe(true);
    expect(upgradeMessage("ai.removeBackground")).toBe("Background removal is part of Pro.");
    for (const plan of ["pro", "selfhost"] as const) {
      expect(gate(account(plan), "agent.generate")).toEqual({ state: "ok" });
      expect(gate(account(plan), "workflow.campaign")).toEqual({ state: "ok" });
      expect(aiLocked(account(plan))).toBe(false);
    }
  });

  test("loading, signed out and unverified accounts", () => {
    expect(gate(undefined, "image")).toEqual({ state: "loading" });
    expect(gate(null, "image")).toEqual({ state: "signed-out" });
    expect(gate(account("pro", { emailVerified: false }), "image")).toEqual({
      state: "unverified",
    });
  });

  test("the profile query is parsed defensively", () => {
    expect(toAccountView(null)).toBeNull();
    expect(toAccountView({ name: "no id" })).toBeNull();
    const a = toAccountView({
      userId: "u",
      plan: "pro",
      features: { "ai.agent": true, "ai.images": "yes" },
      aiSettings: {
        keyMode: "local",
        taskModels: { agent: { provider: "ollama", model: "qwen3" }, bad: 3 },
      },
    });
    expect(a?.features).toEqual({ "ai.agent": true, "ai.images": false });
    expect(a?.aiSettings?.keyMode).toBe("local");
    expect(a?.aiSettings?.taskModels).toEqual({ agent: { provider: "ollama", model: "qwen3" } });
    expect(a?.edition).toBe("hosted");
  });
});

describe("execution", () => {
  test("server by default", () => {
    expect(pickExecution(account("pro"), {}).execution).toEqual({ where: "server" });
    expect(pickExecution(null, {}).choices).toHaveLength(1);
  });

  test("local keys mode with an OpenRouter key runs in the browser, with the cloud as a choice", () => {
    const a = account("pro", { aiSettings: { keyMode: "local" } });
    const picked = pickExecution(a, { openrouter: { apiKey: "k" } });
    expect(picked.execution).toMatchObject({
      where: "browser",
      reason: "local-keys",
      provider: "openrouter",
    });
    expect(picked.choices.map((c) => c.where)).toEqual(["browser", "server"]);
    expect(pickExecution(a, { openrouter: { apiKey: "k" } }, "server").execution.where).toBe(
      "server",
    );
    // A key for another provider needs an agent model choice first.
    expect(pickExecution(a, { anthropic: { apiKey: "k" } }).execution.where).toBe("server");
    const withModel = account("pro", {
      aiSettings: {
        keyMode: "local",
        taskModels: { agent: { provider: "anthropic", model: "claude" } },
      },
    });
    expect(pickExecution(withModel, { anthropic: { apiKey: "k" } }).execution).toMatchObject({
      where: "browser",
      model: "claude",
    });
  });

  test("a local model on the hosted edition must run in the browser", () => {
    const a = account("pro", {
      aiSettings: {
        ollamaBaseUrl: "http://localhost:11434",
        taskModels: { agent: { provider: "ollama", model: "qwen3" } },
      },
    });
    const picked = pickExecution(a, {}, "server");
    expect(picked.execution).toMatchObject({ where: "browser", reason: "local-model" });
    expect(picked.choices).toHaveLength(1);
  });

  test("plans without BYOK / local features never run in the browser", () => {
    const a = account("free", {
      aiSettings: { keyMode: "local", ollamaBaseUrl: "http://localhost:11434" },
    });
    expect(pickExecution(a, { openrouter: { apiKey: "k" } }).execution.where).toBe("server");
  });
});
