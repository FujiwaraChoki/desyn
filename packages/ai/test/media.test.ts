import { describe, expect, it } from "vitest";
import { CreditMeter } from "../src/credits";
import { decodePng, encodePng } from "../src/design/raster";
import { isAiError } from "../src/errors";
import {
  FAL_ADAPTERS,
  falAdapterFor,
  GENERIC_FAL_ADAPTER,
  nearestRatio,
  parseFalOutput,
} from "../src/media/fal-endpoints";
import { createMedia, outpaintExpansion } from "../src/media/media";
import {
  combineModeration,
  createModelModeration,
  createRuleModeration,
} from "../src/media/moderation";
import {
  constrainPalette,
  extractSvg,
  optimizeSvg,
  parseSvg,
  SvgParseError,
  sanitizeSvg,
  svgColors,
  validateSvg,
} from "../src/media/svg";
import { traceRaster } from "../src/media/trace";
import { createProviders } from "../src/providers";
import { fakeFal, fakeFetch, pngDataUri, scriptedTextModel, solidPng } from "./helpers";

describe("svg safety", () => {
  it("removes scripts, handlers, foreignObject, external refs and DOCTYPE entities", () => {
    const dirty = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "boom">]><svg width="100" height="50" onload="alert(1)">
      <script>alert(1)</script><foreignObject><div>hi</div></foreignObject>
      <a href="javascript:alert(1)"><rect width="10" height="10"/></a>
      <image href="https://evil/x.png"/><use href="https://evil/x.svg#a"/><use href="#ok"/>
      <rect id="ok" width="10" height="10" fill="url(https://evil/p)" style="fill:url(#g);behavior:x"/>
      <path d="M0 0L10 10" fill="#FF0000"/></svg>`;
    const { svg, report } = sanitizeSvg(dirty);
    expect(svg).not.toMatch(/script|onload|foreignObject|javascript|evil|behavior|ENTITY|boom/i);
    expect(svg).toContain('viewBox="0 0 100 50"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('href="#ok"');
    expect(report.removedElements).toEqual(
      expect.arrayContaining(["script", "foreignObject", "a", "image"]),
    );
    expect(report.removedAttributes).toEqual(expect.arrayContaining(["onload"]));
  });

  it("rejects malformed markup and oversized input", () => {
    expect(() => parseSvg("<svg><g></svg>")).toThrow(SvgParseError);
    expect(() => parseSvg("<div/>")).toThrow(/no <svg>/);
    expect(() => sanitizeSvg(`<svg>${"x".repeat(600 * 1024)}</svg>`)).toThrow(/larger/);
  });

  it("optimizes precision and drops empty groups and editor ids", () => {
    const out = optimizeSvg(
      '<svg viewBox="0 0 10 10"><g><g></g></g><g id="layer1"><path id="path123" d="M 0.123456 1.98765 L 3.000001 4" fill-opacity="1" fill="#AABBCC"/></g></svg>',
    );
    expect(out).toBe('<svg viewBox="0 0 10 10"><path d="M 0.12 1.99 L 3 4" fill="#aabbcc"/></svg>');
  });

  it("validates structure and palette, and constrains colors", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5" fill="#ff0000"/><circle r="2" style="fill:rgb(0,0,250)"/></svg>';
    expect(svgColors(svg)).toEqual(["#ff0000", "#0000fa"]);
    const v = validateSvg(svg, { palette: ["#ffb02e", "#111111"] });
    expect(v.ok).toBe(false);
    expect(v.issues[0]).toMatch(/palette/);
    const fixed = constrainPalette(svg, ["#ffb02e", "#111111"]);
    expect(svgColors(fixed).every((c) => ["#ffb02e", "#111111"].includes(c))).toBe(true);
    expect(validateSvg('<svg viewBox="0 0 0 0"></svg>').issues).toHaveLength(2);
    expect(
      extractSvg('Here you go:\n```svg\n<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>\n```'),
    ).toBe('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>');
    expect(extractSvg("no svg here")).toBeUndefined();
  });
});

describe("fal adapters", () => {
  it("maps requests onto each pinned endpoint's schema", () => {
    const flux = FAL_ADAPTERS["blackforestlabs/flux-3/text-to-image"]?.input({
      task: "image",
      prompt: "a fox",
      width: 1920,
      height: 1080,
      n: 1,
    });
    expect(flux).toMatchObject({ prompt: "a fox", aspect_ratio: "16:9", resolution: "2k" });
    const ideogram = FAL_ADAPTERS["ideogram/v4.5"]?.input({
      task: "imageText",
      prompt: "sign",
      width: 1080,
      height: 1350,
      n: 2,
      seed: 4,
    });
    expect(ideogram).toMatchObject({ image_size: "portrait_4_3", num_images: 2, seed: 4 });
    const vector = FAL_ADAPTERS["fal-ai/recraft/v4.1/text-to-vector"]?.input({
      task: "vector",
      prompt: "leaf",
      width: 512,
      height: 512,
      n: 1,
      palette: ["#ffb02e"],
    });
    expect(vector).toMatchObject({ colors: [{ r: 255, g: 176, b: 46 }], image_size: "square_hd" });
    const outpaint = FAL_ADAPTERS["fal-ai/flux-2-pro/outpaint"]?.input({
      task: "outpaint",
      image: "data:x",
      srcWidth: 100,
      srcHeight: 100,
      left: 5000,
      right: 10.4,
      top: 0,
      bottom: 0,
    });
    expect(outpaint).toMatchObject({ expand_left: 2048, expand_right: 10 });
    const expand = FAL_ADAPTERS["fal-ai/bria/expand"]?.input({
      task: "outpaint",
      image: "u",
      srcWidth: 100,
      srcHeight: 50,
      left: 10,
      right: 20,
      top: 5,
      bottom: 15,
    });
    expect(expand).toMatchObject({
      canvas_size: [130, 70],
      original_image_size: [100, 50],
      original_image_location: [10, 5],
    });
    const wan = FAL_ADAPTERS["alibaba/wan-3.0-prime/image-to-video"] as NonNullable<
      (typeof FAL_ADAPTERS)[string]
    >;
    expect(
      wan.endpoint("alibaba/wan-3.0-prime/image-to-video", { task: "video", prompt: "p" }),
    ).toBe("alibaba/wan-3.0-prime/text-to-video");
    expect(
      wan.endpoint("alibaba/wan-3.0-prime/image-to-video", {
        task: "video",
        prompt: "p",
        image: "u",
      }),
    ).toBe("alibaba/wan-3.0-prime/image-to-video");
    expect(wan.input({ task: "video", prompt: "p", image: "u", durationSec: 99 })).toMatchObject({
      start_image_url: "u",
      duration: 30,
      aspect_ratio: "adaptive",
    });
    expect(() =>
      FAL_ADAPTERS["fal-ai/birefnet/v2"]?.input({ task: "upscale", image: "u", factor: 2 }),
    ).toThrow();
    expect(falAdapterFor("someone/new-model")).toBe(GENERIC_FAL_ADAPTER);
    expect(nearestRatio(1000, 1000, ["16:9", "1:1", "9:16"])).toBe("1:1");
  });

  it("parses the common output shapes", () => {
    expect(
      parseFalOutput({
        images: [{ url: "u1", content_type: "image/png", width: 4, height: 2 }],
        seed: 7,
      }),
    ).toEqual({ files: [{ url: "u1", mime: "image/png", width: 4, height: 2 }], seed: 7 });
    expect(parseFalOutput({ video: { url: "v" }, duration: 5 })).toEqual({
      files: [{ url: "v" }],
      durationMs: 5000,
    });
    expect(parseFalOutput({ audio: { url: "a" }, duration_ms: 1200 })).toEqual({
      files: [{ url: "a" }],
      durationMs: 1200,
    });
  });
});

describe("tracer", () => {
  it("traces flat color regions into even-odd paths, largest first", async () => {
    const w = 40;
    const h = 30;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inSquare = x >= 10 && x < 25 && y >= 8 && y < 22;
        data.set(inSquare ? [220, 30, 30, 255] : [250, 250, 250, 255], (y * w + x) * 4);
      }
    }
    const traced = await traceRaster(encodePng(w, h, data), { colors: 2, detail: "high" });
    expect(traced.layers).toHaveLength(2);
    expect(traced.layers[0]?.color).toBe("#fafafa");
    expect(traced.layers[1]?.color).toBe("#dc1e1e");
    expect(traced.layers[1]?.d).toContain("M10 8");
    expect(traced.layers[0]?.d.match(/M/g)?.length).toBe(2); // outer + hole
    expect(traced.svg).toContain('viewBox="0 0 40 30"');
    await expect(traceRaster(new Uint8Array([0xff, 0xd8, 0xff]))).rejects.toThrow();
  });
});

describe("media", () => {
  const settings = {
    env: { fal: { apiKey: "test-fal-key-1234" }, openrouter: { apiKey: "test-openrouter-key" } },
  };
  const png = solidPng(64, 32);
  const fileFetch = () =>
    fakeFetch({
      "https://fal.media/": () =>
        new Response(png as Uint8Array<ArrayBuffer>, { headers: { "content-type": "image/png" } }),
    });

  it("generates images through the pinned fal adapter, meters credits and reports progress", async () => {
    const fal = fakeFal({
      "blackforestlabs/flux-3/text-to-image": () => ({
        images: [{ url: "https://fal.media/a.png", content_type: "image/png" }],
      }),
    });
    const meter = new CreditMeter(100);
    const progress: string[] = [];
    const providers = createProviders(settings, { falTransport: fal.transport });
    const media = createMedia({
      providers,
      meter,
      ...fileFetch(),
      onProgress: (p) => progress.push(p.status),
    });
    const [img] = await media.generateImage({
      prompt: "a calm desert at dawn",
      width: 1600,
      height: 900,
      style: "photo",
      negativePrompt: "text",
    });
    expect(fal.calls[0]?.input).toMatchObject({ aspect_ratio: "16:9" });
    expect(String(fal.calls[0]?.input.prompt)).toContain("photorealistic");
    expect(String(fal.calls[0]?.input.prompt)).toContain("Avoid: text");
    expect(img).toMatchObject({
      mime: "image/png",
      width: 64,
      height: 32,
      provider: "fal",
      costCredits: 3,
      billing: "platform",
    });
    expect(img?.bytes?.length).toBe(png.length);
    expect(meter.used).toBe(3);
    expect(progress).toEqual(expect.arrayContaining(["queued", "running", "downloading", "done"]));
  });

  it("falls back to the next pinned model on provider errors but not on invalid input", async () => {
    const fal = fakeFal({
      "blackforestlabs/flux-3/text-to-image": () => {
        throw new Error("upstream 503");
      },
      "google/nano-banana-2.1": () => ({ images: [{ url: pngDataUri(8, 8) }] }),
    });
    const media = createMedia({
      providers: createProviders(settings, { falTransport: fal.transport }),
    });
    const [img] = await media.generateImage({ prompt: "x y z" });
    expect(img?.model).toBe("google/nano-banana-2.1");
    expect(img?.width).toBe(8);
    // A user's explicit choice is strict.
    const strict = createMedia({
      providers: createProviders(settings, { falTransport: fal.transport }),
      prefs: {
        user: { image: { provider: "fal", model: "blackforestlabs/flux-3/text-to-image" } },
      },
    });
    await expect(strict.generateImage({ prompt: "x y z" })).rejects.toThrow(/503/);
  });

  it("blocks moderated prompts, enforces budgets and reports missing providers", async () => {
    const fal = fakeFal({
      "blackforestlabs/flux-3/text-to-image": () => ({ images: [{ url: pngDataUri() }] }),
    });
    const providers = createProviders(settings, { falTransport: fal.transport });
    const moderated = createMedia({ providers, moderation: createRuleModeration() });
    const blocked = await moderated.generateImage({ prompt: "nude teen" }).catch((e) => e);
    expect(isAiError(blocked, "moderation-blocked")).toBe(true);
    expect(fal.calls).toHaveLength(0);
    const tight = createMedia({ providers, meter: new CreditMeter(2) });
    expect(
      isAiError(await tight.generateImage({ prompt: "a cat" }).catch((e) => e), "budget-exceeded"),
    ).toBe(true);
    const none = createMedia({ providers: createProviders({}) });
    expect(
      isAiError(
        await none.generateImage({ prompt: "a cat" }).catch((e) => e),
        "provider-not-configured",
      ),
    ).toBe(true);
  });

  it("treats BYOK fal keys as free and edits images (bg removal, inpaint, outpaint, upscale, mockup)", async () => {
    const out = { image: { url: pngDataUri(16, 16), content_type: "image/png" } };
    const fal = fakeFal({
      "fal-ai/birefnet/v2": () => out,
      "fal-ai/flux-pro/v1/fill": (input) => ({
        images: [out.image],
        seed: 3,
        prompt: input.prompt,
      }),
      "fal-ai/flux-2-pro/outpaint": () => ({ images: [out.image] }),
      "fal-ai/seedvr/upscale/image": () => out,
      "google/nano-banana-2.1/edit": () => ({ images: [out.image] }),
    });
    const providers = createProviders(
      { user: { fal: { apiKey: "user-fal-key-123" } } },
      { falTransport: fal.transport },
    );
    const meter = new CreditMeter(10);
    const media = createMedia({ providers, meter });
    const image = { bytes: solidPng(100, 50), mime: "image/png" };
    expect((await media.removeBackground({ image })).costCredits).toBe(0);
    expect(fal.calls[0]?.input).toMatchObject({
      model: "General Use (Heavy)",
      output_format: "png",
    });
    expect(String(fal.calls[0]?.input.image_url)).toMatch(/^data:image\/png;base64,/);
    const inpainted = await media.inpaint({ image, mask: image, prompt: "a vase" });
    expect(inpainted.seed).toBe(3);
    await media.outpaint({ image, target: { width: 1600, height: 900 }, direction: "right" });
    expect(fal.calls[2]?.input).toMatchObject({ expand_right: 0, expand_left: 0 });
    await media.upscale({ image, factor: 4 });
    expect(fal.calls[3]?.input).toMatchObject({ upscale_factor: 4 });
    await media.mockup({ design: image, scene: "poster on a gallery wall" });
    expect(fal.calls[4]?.input.image_urls as string[]).toHaveLength(1);
    expect(meter.used).toBe(0);
  });

  it("computes outpaint expansions per direction", () => {
    expect(outpaintExpansion(1000, 1000, { width: 1600, height: 900 }, "all")).toEqual({
      left: 389,
      right: 389,
      top: 0,
      bottom: 0,
    });
    expect(outpaintExpansion(1000, 1000, { width: 1600, height: 900 }, "left")).toEqual({
      left: 778,
      right: 0,
      top: 0,
      bottom: 0,
    });
    expect(outpaintExpansion(1600, 900, { width: 1080, height: 1920 }, "down")).toEqual({
      left: 0,
      right: 0,
      top: 0,
      bottom: 1944,
    });
  });

  it("generates SVG with a repair loop and palette enforcement", async () => {
    const model = scriptedTextModel([
      "Sure! <svg><rect width='10' height='10' fill='#ff0000'/></svg>", // no viewBox -> sanitizer adds one, palette off
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z" fill="#ffb02e"/></svg>',
    ]);
    const providers = createProviders(settings);
    // Inject the mock language model through a provider-shaped override.
    (providers as unknown as { languageModel: () => unknown }).languageModel = () => model;
    const media = createMedia({ providers });
    const result = await media.generateSvg({
      prompt: "sun icon",
      kind: "icon",
      palette: ["#ffb02e", "#111111"],
    });
    expect(result.repairs).toBe(1);
    expect(result.colors).toEqual(["#ffb02e"]);
    expect(result.width).toBe(24);
    expect(result.costCredits).toBe(1);
    expect(model.doGenerateCalls).toHaveLength(2);
    const repairPrompt = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(repairPrompt).toContain("palette");
  });

  it("traces with the built-in tracer when fal is not configured", async () => {
    const media = createMedia({
      providers: createProviders({ env: { openrouter: { apiKey: "test-openrouter-key" } } }),
    });
    const traced = await media.trace({
      image: { bytes: solidPng(10, 10, [10, 20, 30, 255]), mime: "image/png" },
      colors: 2,
    });
    expect(traced.provider).toBe("builtin");
    expect(traced.layers?.[0]?.color).toBe("#0a141e");
    expect(traced.billing).toBe("local");
    const decoded = await decodePng(solidPng(2, 2));
    expect(decoded.width).toBe(2);
  });
});

describe("moderation", () => {
  it("rule moderation blocks only clear violations and model moderation fails open", async () => {
    const rules = createRuleModeration();
    expect(
      (await rules({ task: "image", prompt: "a teenager skateboarding at sunset" })).allowed,
    ).toBe(true);
    expect((await rules({ task: "image", prompt: "sexy schoolgirl photo" })).allowed).toBe(false);
    const model = scriptedTextModel([
      { allowed: false, categories: ["impersonation"], reason: "Fake IDs are not allowed." },
    ]);
    const combined = combineModeration(rules, createModelModeration(model));
    expect(
      await combined({ task: "image", prompt: "a passport photo id card for John" }),
    ).toMatchObject({ allowed: false, reason: "Fake IDs are not allowed." });
    const broken = createModelModeration(scriptedTextModel(["not json"]));
    expect((await broken({ task: "image", prompt: "x" })).allowed).toBe(true);
  });
});
