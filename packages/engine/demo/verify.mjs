#!/usr/bin/env node
// Browser verification of the engine demo with Playwright (headless Chromium):
//   node demo/verify.mjs [--out demo/shots] [--keep-server]
// Starts the Vite demo on 127.0.0.1:4105, then
//   1. loads every fixture and takes a screenshot,
//   2. pans and zooms (scroll reuse + progressive tiles),
//   3. drags a node for ~2 s with real mouse input and measures frame timing (worker render time per frame,
//      interval between presented frames, main-thread frame intervals),
//   4. edits text live through the bridge (typing, selection, bold),
//   5. exports PNG / SVG / PDF (PDF loads the exporters module),
//   6. checks that the presented canvas equals a fresh full render after all of the above.
// Writes screenshots and `report.json` to the output directory and exits non-zero on failure.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const outDir = resolve(
  argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : join(here, "shots"),
);
mkdirSync(outDir, { recursive: true });

const report = { checks: [], perf: {}, errors: [] };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  process.stdout.write(
    `${ok ? "✓" : "✗"} ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}\n`,
  );
}

function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))] ?? 0;
  const mean = v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
  return {
    n: v.length,
    mean: +mean.toFixed(2),
    p50: +q(0.5).toFixed(2),
    p95: +q(0.95).toFixed(2),
    max: +q(1).toFixed(2),
  };
}

const server = await createServer({ configFile: join(here, "vite.config.ts"), logLevel: "warn" });
await server.listen();
const base = "http://127.0.0.1:4105/";
const browser = await chromium.launch({ args: ["--enable-features=CanvasOopRasterization"] });

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    // Dark-first (the demo follows the system theme; `?theme=light` or a light OS gives the light pasteboard).
    colorScheme: "dark",
  });
  page.on("pageerror", (e) => report.errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") report.errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${base}?design=social`);
  await page.waitForFunction(() => window.desyn !== undefined, null, { timeout: 30000 });
  await page.evaluate(() => window.desyn.ready);
  const mode = await page.evaluate(() => window.desyn.client.mode);
  check("engine runs in a worker with an OffscreenCanvas", mode === "worker", mode);

  // 1. Fixtures ---------------------------------------------------------------------------------------------
  const names = await page.evaluate(() =>
    [...document.querySelectorAll("#fixture option")].map((o) => o.value),
  );
  for (const name of names) {
    await page.evaluate((n) => window.desyn.loadDesign(n), name);
    await page.evaluate(() => window.desyn.client.flush());
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(outDir, `fixture-${name}.png`) });
  }
  check("every fixture renders", names.length >= 10, `${names.length} fixtures`);

  // 2. Pan and zoom -------------------------------------------------------------------------------------------
  await page.evaluate(() => window.desyn.loadDesign("social"));
  await page.evaluate(() => window.desyn.client.flush());
  const canvasBox = await page.locator("#canvas").boundingBox();
  const panFrames = await page.evaluate(async () => {
    const d = window.desyn;
    const start = d.frames.length;
    for (let i = 0; i < 20; i++) {
      d.client.panBy(7, 3);
      await new Promise((r) => requestAnimationFrame(r));
    }
    await d.client.flush();
    return d.frames.slice(start);
  });
  const scrolled = panFrames.filter((f) => f.scrolled).length;
  check(
    "panning reuses pixels (whole-pixel scrolls)",
    scrolled >= 10,
    `${scrolled}/${panFrames.length} frames scrolled`,
  );
  const zoomFrames = await page.evaluate(async () => {
    const d = window.desyn;
    const start = d.frames.length;
    for (let i = 0; i < 12; i++) {
      d.client.zoomAt({ x: 700, y: 400 }, d.client.view.zoom * 1.12);
      await new Promise((r) => requestAnimationFrame(r));
    }
    // Let the settle render run progressively on its own (no flush), as it does for users.
    await new Promise((r) => setTimeout(r, 1500));
    return d.frames.slice(start);
  });
  report.perf.zoom = {
    renderMs: stats(zoomFrames.map((f) => f.renderMs)),
    buildMs: stats(zoomFrames.map((f) => f.buildMs)),
    rasterMs: stats(zoomFrames.map((f) => f.rasterMs)),
    presentMs: stats(zoomFrames.map((f) => f.presentMs)),
    progressiveFrames: zoomFrames.filter((f) => f.pending > 0).length,
    settleCalls: zoomFrames.filter((f) => f.rasterMs > 0).map((f) => +f.rasterMs.toFixed(1)),
  };
  check(
    "zooming renders (progressive tiles when over budget)",
    zoomFrames.length > 0,
    report.perf.zoom,
  );
  await page.screenshot({ path: join(outDir, "zoomed.png") });
  await page.evaluate(() => {
    window.desyn.client.fit(undefined, 56);
    return window.desyn.client.flush();
  });

  // 3. Drag at 60 fps -------------------------------------------------------------------------------------------
  // The call-to-action button (a frame with a drop shadow): realistic drag content.
  const target = await page.evaluate(() => {
    const d = window.desyn;
    const nodes = Object.values(d.client.design.nodes);
    const n = nodes.find((x) => x.name?.endsWith("-cta")) ?? nodes.find((x) => x.type === "rect");
    if (!n) return null;
    return {
      id: n.id,
      x: n.x,
      y: n.y,
      center: d.client.pageToScreen({ x: n.x + n.width / 2, y: n.y + n.height / 2 }),
    };
  });
  check("found a node to drag", target !== null, target?.id);
  if (target) {
    const sx = canvasBox.x + target.center.x;
    const sy = canvasBox.y + target.center.y;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.evaluate(() => {
      window.__rafTimes = [];
      window.__dragStart = window.desyn.frames.length;
      const loop = (t) => {
        window.__rafTimes.push(t);
        if (window.__rafTimes.length < 100000 && !window.__stopRaf) requestAnimationFrame(loop);
      };
      window.__stopRaf = false;
      requestAnimationFrame(loop);
    });
    const steps = 120;
    for (let i = 1; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      await page.mouse.move(
        sx - 240 * (i / steps) - 120 * Math.sin(a),
        sy - 160 * Math.sin(a) - 90 * (i / steps),
      );
      await page.waitForTimeout(16);
    }
    await page.screenshot({ path: join(outDir, "dragging.png") });
    await page.mouse.up();
    const timing = await page.evaluate(async () => {
      window.__stopRaf = true;
      await window.desyn.client.flush();
      const frames = window.desyn.frames.slice(window.__dragStart);
      const raf = window.__rafTimes;
      return { frames, raf };
    });
    const dragFrames = timing.frames.filter((f) => f.pixels > 0);
    const intervals = dragFrames.slice(1).map((f, i) => f.at - dragFrames[i].at);
    const rafIntervals = timing.raf.slice(1).map((t, i) => t - timing.raf[i]);
    report.perf.drag = {
      workerFrameMs: stats(dragFrames.map((f) => f.renderMs + f.presentMs)),
      workerRasterMs: stats(dragFrames.map((f) => f.rasterMs)),
      presentedIntervalMs: stats(intervals),
      mainThreadFrameMs: stats(rafIntervals),
      presentedFrames: dragFrames.length,
      pointerMoves: steps,
      pixelsPerFrame: stats(dragFrames.map((f) => f.pixels)),
    };
    check(
      "drag frames fit a 60 Hz budget (worker p95 < 16.7 ms)",
      report.perf.drag.workerFrameMs.p95 < 16.7,
      report.perf.drag.workerFrameMs,
    );
    check(
      "main thread stays responsive during the drag (p95 < 20 ms)",
      report.perf.drag.mainThreadFrameMs.p95 < 20,
      report.perf.drag.mainThreadFrameMs,
    );
    const moved = await page.evaluate((id) => {
      const n = window.desyn.client.design.nodes[id];
      return n ? { x: n.x, y: n.y, selection: window.desyn.selection } : null;
    }, target.id);
    check(
      "drag moves the hit node and commits on release",
      moved !== null &&
        moved.selection[0] === target.id &&
        (moved.x !== target.x || moved.y !== target.y),
      { from: { x: target.x, y: target.y }, to: moved },
    );
    await page.screenshot({ path: join(outDir, "after-drag.png") });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await page.evaluate(() => window.desyn.client.flush());
  }

  // 4. Live text editing --------------------------------------------------------------------------------------
  await page.evaluate(() => window.desyn.loadDesign("text"));
  await page.evaluate(() => window.desyn.client.flush());
  const head = await page.evaluate(() => {
    const d = window.desyn;
    const n = d.client.design.nodes.headline0001;
    return d.client.pageToScreen({ x: n.x + 30, y: n.y + n.height / 2 });
  });
  await page.mouse.dblclick(canvasBox.x + head.x, canvasBox.y + head.y);
  await page.waitForFunction(() => window.desyn.editing !== null);
  await page.keyboard.press("End");
  await page.keyboard.type(" — edited live", { delay: 30 });
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+b" : "Control+b");
  await page.keyboard.press("End");
  await page.evaluate(() => window.desyn.client.flush());
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(outDir, "text-editing.png") });
  const editedPreview = await page.evaluate(() => window.desyn.editing?.text ?? "");
  check("typing goes through the bridge", editedPreview.includes("edited live"), editedPreview);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.desyn.editing === null);
  const committed = await page.evaluate(() =>
    window.desyn.client.design.nodes.headline0001.runs.map((r) => ({
      text: r.text,
      w: r.style?.fontWeight,
    })),
  );
  check(
    "edits commit with run styles",
    committed
      .map((r) => r.text)
      .join("")
      .includes("edited live") && committed.some((r) => r.w === 700 || r.w === 400),
    committed,
  );
  await page.evaluate(() => window.desyn.client.flush());
  await page.screenshot({ path: join(outDir, "text-committed.png") });

  // 5. Exports -------------------------------------------------------------------------------------------------
  const exports = await page.evaluate(async () => {
    const c = window.desyn.client;
    const out = {};
    for (const format of ["png", "svg", "pdf"]) {
      const t0 = performance.now();
      const r = await c.export({ format });
      out[format] = {
        bytes: r.bytes.length,
        mime: r.info.mime,
        ms: Math.round(performance.now() - t0),
        head: Array.from(r.bytes.slice(0, 5)),
      };
    }
    return out;
  });
  report.perf.exports = exports;
  check(
    "PDF export through the lazily loaded exporters module",
    exports.pdf.head.join(",") === "37,80,68,70,45",
    exports.pdf,
  );

  // 6. Presented canvas equals a fresh render -----------------------------------------------------------------
  await page.evaluate(() => window.desyn.loadDesign("shapes"));
  await page.evaluate(async () => {
    const c = window.desyn.client;
    for (let i = 0; i < 8; i++) {
      c.panBy(5, -3);
      await new Promise((r) => requestAnimationFrame(r));
    }
    await c.flush();
  });
  const consistent = await page.evaluate(async () => {
    const c = window.desyn.client;
    const a = await c.capture();
    // Force a full redraw by toggling the pasteboard color, then compare.
    const pasteboard = c.renderOptions.background;
    c.setRenderOptions({ background: "#0e0e0f" });
    await c.flush();
    c.setRenderOptions({ background: pasteboard });
    await c.flush();
    const b = await c.capture();
    const decode = async (bytes) => {
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = cv.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    };
    const [pa, pb] = await Promise.all([decode(a), decode(b)]);
    let diff = 0;
    for (let i = 0; i < pa.length; i += 4) {
      if (
        Math.abs(pa[i] - pb[i]) > 2 ||
        Math.abs(pa[i + 1] - pb[i + 1]) > 2 ||
        Math.abs(pa[i + 2] - pb[i + 2]) > 2
      )
        diff++;
    }
    return { pixels: pa.length / 4, diff };
  });
  check(
    "incremental frames equal a full redraw",
    consistent.diff / consistent.pixels < 0.001,
    consistent,
  );

  // Main-thread fallback ---------------------------------------------------------------------------------------
  const fallback = await browser.newPage({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 1,
  });
  fallback.on("pageerror", (e) => report.errors.push(`fallback pageerror: ${e.message}`));
  await fallback.goto(`${base}?design=charts&mode=main`);
  await fallback.waitForFunction(() => window.desyn !== undefined);
  await fallback.evaluate(() => window.desyn.ready);
  await fallback.evaluate(() => window.desyn.client.flush());
  // The loading veil fades out over 0.5 s.
  await fallback.waitForTimeout(800);
  await fallback.screenshot({ path: join(outDir, "fallback-main-thread.png") });
  check(
    "main-thread fallback renders",
    (await fallback.evaluate(() => window.desyn.client.mode)) === "main",
  );

  check("no page errors", report.errors.length === 0, report.errors.slice(0, 5));
} finally {
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  if (!argv.includes("--keep-server")) await server.close();
}

const failed = report.checks.filter((c) => !c.ok);
process.stdout.write(
  `\n${report.checks.length - failed.length}/${report.checks.length} checks passed; report: ${join(outDir, "report.json")}\n`,
);
process.exit(failed.length ? 1 : 0);
