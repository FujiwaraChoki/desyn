import type { FeatureKey } from "@desyn/schema";
import { describe, expect, test } from "vitest";
import { featuresOfPlan } from "../../src/export/features.ts";
import { FORMATS } from "../../src/export/formats.ts";
import {
  defaultExportOptions,
  type ExportContext,
  type ExportOptions,
  emailsWhenReady,
  engineRequests,
  outputFileNames,
  planExport,
  safeFileName,
  serverRequest,
  snapFps,
} from "../../src/export/options.ts";

const pages = (n: number, w = 1080, h = 1350, bleed = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `page${i}`,
    name: `Slide ${i + 1}`,
    width: w,
    height: h,
    bleed,
  }));

function ctx(over: Partial<ExportContext> = {}): ExportContext {
  return {
    designName: "Summer / Sale",
    pages: pages(3),
    currentPageId: "page1",
    features: featuresOfPlan("pro"),
    engineReady: true,
    signedIn: true,
    serverAvailable: true,
    ...over,
  };
}

const opts = (over: Partial<ExportOptions> = {}): ExportOptions => ({
  ...defaultExportOptions(),
  ...over,
});

describe("export options", () => {
  test("PNG of three pages at 2x renders in the browser, one file per page", () => {
    const plan = planExport(opts({ format: "png", scale: 2 }), ctx());
    expect(plan.ok).toBe(true);
    expect(plan.route).toBe("browser");
    expect(plan.outputs.map((o) => [o.width, o.height])).toEqual([
      [2160, 2700],
      [2160, 2700],
      [2160, 2700],
    ]);
    const reqs = engineRequests(plan, opts({ format: "png", scale: 2 }));
    expect(reqs.map((r) => r.pageId)).toEqual(["page0", "page1", "page2"]);
    expect(reqs[0]).toMatchObject({ format: "png", scale: 2 });
    expect(outputFileNames(plan, "Summer / Sale")).toEqual([
      "01 Slide 1.png",
      "02 Slide 2.png",
      "03 Slide 3.png",
    ]);
  });

  test("validates scale, width, quality, colors, fps and DPI", () => {
    expect(planExport(opts({ scale: 9 }), ctx()).errors.scale).toMatch(/between/);
    expect(planExport(opts({ scale: 0.05 }), ctx()).errors.scale).toMatch(/between/);
    expect(planExport(opts({ sizeMode: "width", width: 8 }), ctx()).errors.width).toMatch(/16/);
    // 1080 px wide page at 16384 px wide is > 8x.
    expect(planExport(opts({ sizeMode: "width", width: 16000 }), ctx()).errors.width).toMatch(
      /scale/,
    );
    const w = planExport(opts({ sizeMode: "width", width: 540 }), ctx());
    expect(w.scale).toBeCloseTo(0.5);
    expect(w.outputs[0]).toMatchObject({ width: 540, height: 675 });
    // 8x of a tall page exceeds the renderer's 16384 px limit.
    expect(
      planExport(opts({ scale: 8 }), ctx({ pages: pages(1, 1080, 4000) })).errors.scale,
    ).toMatch(/16384/);
    expect(planExport(opts({ format: "jpeg", quality: 0 }), ctx()).errors.quality).toBeTruthy();
    expect(planExport(opts({ format: "jpeg", quality: 55.5 }), ctx()).errors.quality).toBeTruthy();
    expect(planExport(opts({ format: "png", quality: 0 }), ctx()).ok).toBe(true); // not used by PNG
    expect(planExport(opts({ background: "orange" }), ctx()).errors.background).toBeTruthy();
    expect(planExport(opts({ format: "gif", fps: 60 }), ctx()).errors.fps).toBeTruthy();
    expect(planExport(opts({ format: "mp4", fps: 60 }), ctx()).errors.fps).toBeUndefined();
    expect(
      planExport(
        opts({ format: "pdf", pdf: { bleed: false, cropMarks: false, cmyk: false, dpi: 1200 } }),
        ctx(),
      ).errors.pdf,
    ).toBeTruthy();
    expect(planExport(opts({ pages: [] }), ctx()).errors.pages).toBeTruthy();
  });

  test("transparency only where the format has it", () => {
    const jpg = planExport(opts({ format: "jpeg", transparent: true }), ctx());
    expect(jpg.ok).toBe(true);
    expect(jpg.warnings[0]).toMatch(/no transparency/);
    expect(
      engineRequests(jpg, opts({ format: "jpeg", transparent: true }))[0]?.background,
    ).toBeUndefined();
    const png = planExport(opts({ format: "png", transparent: true }), ctx());
    expect(engineRequests(png, opts({ format: "png", transparent: true }))[0]?.background).toBe(
      "transparent",
    );
  });

  test("plan gating locks Pro formats and print options", () => {
    const free = featuresOfPlan("free");
    for (const f of FORMATS) {
      const plan = planExport(opts({ format: f.id }), ctx({ features: free }));
      const allowed = f.features.every((k) => free[k]);
      expect(plan.locked.length === 0).toBe(allowed);
    }
    expect(
      planExport(opts({ format: "pdf-print" }), ctx({ features: free })).errors.format,
    ).toMatch(/Print-ready/);
    expect(planExport(opts({ format: "svg" }), ctx({ features: free })).errors.format).toMatch(
      /SVG export/,
    );
    const partial: Partial<Record<FeatureKey, boolean>> = { "export.pdf": true };
    expect(planExport(opts({ format: "pdf-print" }), ctx({ features: partial })).locked).toEqual([
      "export.pdfPrint",
    ]);
  });

  test("routing: many pages, page subsets of documents, video and huge images go to the server", () => {
    expect(planExport(opts({ format: "png" }), ctx({ pages: pages(6) })).route).toBe("server");
    expect(planExport(opts({ format: "pdf", pages: ["page0", "page2"] }), ctx()).route).toBe(
      "server",
    );
    expect(planExport(opts({ format: "pdf", pages: ["page2"] }), ctx()).route).toBe("browser");
    expect(planExport(opts({ format: "pdf" }), ctx()).route).toBe("browser");
    expect(planExport(opts({ format: "mp4" }), ctx()).route).toBe("server");
    expect(
      planExport(opts({ format: "png", scale: 6 }), ctx({ pages: pages(1, 2000, 1300) })).route,
    ).toBe("server");
    expect(planExport(opts({ format: "png", forceServer: true }), ctx()).route).toBe("server");
    expect(planExport(opts({ format: "png" }), ctx({ engineReady: false })).route).toBe("server");
    // Server routes need a signed-in user and a backend.
    expect(planExport(opts({ format: "mp4" }), ctx({ signedIn: false })).errors.route).toMatch(
      /Sign in/,
    );
    expect(
      planExport(opts({ format: "mp4" }), ctx({ serverAvailable: false })).errors.route,
    ).toBeTruthy();
  });

  test("document requests: one file for all pages, print options only for PDF Print", () => {
    const o = opts({
      format: "pdf-print",
      pdf: { bleed: true, cropMarks: true, cmyk: true, dpi: 150 },
    });
    const plan = planExport(o, ctx({ pages: pages(2, 1000, 1000, 12) }));
    expect(plan.outputs).toEqual([
      { pageId: null, name: "Summer / Sale", width: 1024, height: 1024 },
    ]);
    expect(engineRequests(plan, o)).toEqual([
      { format: "pdf", pageId: "all", pdf: { dpi: 150, bleed: true, cropMarks: true, cmyk: true } },
    ]);
    // `notify` is only sent to force the e-mail: `false` would switch off the server's mail for large jobs.
    expect(serverRequest(plan, o, 2)).toEqual({
      format: "pdf",
      pages: "all",
      pdf: { bleed: true, cropMarks: true, cmyk: true },
      dpi: 150,
    });
    expect(planExport(o, ctx({ pages: pages(2) })).warnings.some((w) => /no bleed/.test(w))).toBe(
      true,
    );
    const sub = planExport(
      opts({ format: "png", pages: ["page2", "page0"], scale: 1.5, notify: true }),
      ctx(),
    );
    expect(serverRequest(sub, opts({ format: "png", scale: 1.5, notify: true }), 3)).toEqual({
      format: "png",
      pages: ["page0", "page2"],
      scale: 1.5,
      notify: true,
    });
    expect(outputFileNames(plan, "Summer / Sale")).toEqual(["Summer Sale.pdf"]);
  });

  test("frame rates snap to the offered choices", () => {
    expect(snapFps("mp4", 15)).toBe(30);
    expect(snapFps("mp4", 60)).toBe(60);
    expect(snapFps("gif", 60)).toBe(15);
    expect(snapFps("gif", 24)).toBe(24);
    expect(snapFps("png", 15)).toBe(15);
  });

  test("server requests carry the frame rate and resolution; large jobs always e-mail", () => {
    const mp4 = opts({ format: "mp4", fps: 60 });
    const video = planExport(mp4, ctx());
    expect(serverRequest(video, mp4, 3)).toEqual({
      format: "mp4",
      pages: "all",
      scale: 2,
      fps: 60,
    });
    expect(emailsWhenReady(video, mp4)).toBe(true);
    const gif = opts({ format: "gif", fps: 10, pages: ["page0", "page2"] });
    expect(serverRequest(planExport(gif, ctx()), gif, 3)).toMatchObject({ fps: 10 });
    const pdf = opts({
      format: "pdf",
      pdf: { bleed: false, cropMarks: false, cmyk: false, dpi: 96 },
    });
    expect(serverRequest(planExport(pdf, ctx()), pdf, 3)).toEqual({
      format: "pdf",
      pages: "all",
      pdf: { bleed: false, cropMarks: false, cmyk: false },
      dpi: 96,
    });
    // Small image exports only mail when asked; many pages always do.
    const png = opts({ format: "png", forceServer: true });
    expect(emailsWhenReady(planExport(png, ctx()), png)).toBe(false);
    expect(emailsWhenReady(planExport(png, ctx()), { ...png, notify: true })).toBe(true);
    expect(emailsWhenReady(planExport(png, ctx({ pages: pages(8) })), png)).toBe(true);
    expect(serverRequest(planExport(png, ctx()), png, 3)).not.toHaveProperty("notify");
  });

  test("current page selection and safe file names", () => {
    const plan = planExport(opts({ pages: "current" }), ctx());
    expect(plan.pageIds).toEqual(["page1"]);
    expect(outputFileNames(plan, "A:B")).toEqual(["A B - Slide 2.png"]);
    expect(safeFileName("  \u0000 ")).toBe("design");
    const dupes = planExport(opts(), ctx({ pages: pages(2).map((p) => ({ ...p, name: "Same" })) }));
    expect(outputFileNames(dupes, "x")).toEqual(["01 Same.png", "02 Same.png"]);
  });
});
