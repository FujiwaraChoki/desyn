// Canvas interaction checks on the 2,000-layer harness (vite --config test/canvas/perf/vite.config.ts must be
// running on :4108): scripted drags / resizes / marquee / pans with real mouse input at display rate, main-thread
// frame intervals, long tasks and engine (worker) frame times, plus screenshots of every interaction state.
// Usage: node test/canvas/perf/perf.mjs [--theme=light]   Writes shots/*.png and shots/report.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const theme = process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "dark";
const out = new URL("./shots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`http://127.0.0.1:4108/?theme=${theme}`);
await page.waitForFunction(
  () => window.__canvas?.editor?.getState().engine.painted === true,
  null,
  { timeout: 60000 },
);
await page.waitForTimeout(600);

// Instrumentation: rAF intervals, long tasks, engine frame stats.
await page.evaluate(() => {
  const w = window;
  w.__perf = { raf: [], long: [], frames: [], recording: false };
  const tick = (t) => {
    if (w.__perf.recording) {
      if (w.__perf.last !== undefined) w.__perf.raf.push(t - w.__perf.last);
      w.__perf.last = t;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  new PerformanceObserver((list) => {
    if (!w.__perf.recording) return;
    for (const e of list.getEntries()) w.__perf.long.push(e.duration);
  }).observe({ type: "longtask", buffered: false });
  w.__canvas.editor.engineClient.on("frame", (f) => {
    if (w.__perf.recording) w.__perf.frames.push(f.renderMs + f.presentMs);
  });
});

const nodeCount = await page.evaluate(() => window.__canvas.nodeCount);

/** Client coordinates of a page point. */
async function toClient(x, y) {
  return page.evaluate(
    ([px, py]) => {
      const c = window.__canvas.editor.engineClient;
      const el = document.querySelector("[data-canvas-interaction]").getBoundingClientRect();
      const s = c.pageToScreen({ x: px, y: py });
      return { x: el.left + s.x, y: el.top + s.y };
    },
    [x, y],
  );
}

async function nodeCenter(id) {
  const n = await page.evaluate((nid) => {
    const d = window.__canvas.editor.design.nodes[nid];
    return { x: d.x + d.width / 2, y: d.y + d.height / 2 };
  }, id);
  return toClient(n.x, n.y);
}

const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    p50: +q(0.5).toFixed(2),
    p95: +q(0.95).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
  };
};

async function record(name, fn) {
  await page.evaluate(() => {
    const p = window.__perf;
    p.raf = [];
    p.long = [];
    p.frames = [];
    p.last = undefined;
    p.recording = true;
  });
  await fn();
  const r = await page.evaluate(() => {
    const p = window.__perf;
    p.recording = false;
    return { raf: p.raf, long: p.long, frames: p.frames };
  });
  return {
    name,
    rafMs: stats(r.raf),
    longTasks: r.long.length,
    longestTaskMs: Math.max(0, ...r.long),
    workerFrameMs: stats(r.frames),
  };
}

/** A pointer drag of `steps` moves paced by animation frames (display-rate input). */
async function drag(from, to, steps = 90, mods = []) {
  for (const k of mods) await page.keyboard.down(k);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }
  await page.mouse.up();
  for (const k of mods) await page.keyboard.up(k);
  await page.waitForTimeout(150);
}

const steps = [];
const shot = async (name) => {
  steps.push({
    name,
    undo: await page.evaluate(() => window.__canvas.editor.getState().history.undoLabel),
    mode: await page.evaluate(() => window.__canvas.controller()?.mode?.kind ?? null),
  });
  await page.screenshot({ path: `${out}${theme === "dark" ? "" : `${theme}-`}${name}.png` });
};
const ids = await page.evaluate(() => window.__canvas.ids);
const results = [];

// 1. Click a card: selection handles.
const card = await nodeCenter(ids.card);
await page.mouse.click(card.x, card.y);
await page.waitForTimeout(200);
await shot("01-selection");

// 2. Drag the card across the page (snapping, live engine previews).
results.push(
  await record("drag card", async () => {
    const to = { x: card.x + 420, y: card.y + 260 };
    const mid = { x: card.x + 210, y: card.y + 130 };
    await page.mouse.move(card.x, card.y);
    await page.mouse.down();
    for (let i = 1; i <= 120; i++) {
      const t = i / 120;
      await page.mouse.move(card.x + (to.x - card.x) * t, card.y + (to.y - card.y) * t);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      if (i === 60) {
        await page.mouse.move(mid.x + 3, mid.y + 2);
        await shot("02-drag-snapping");
      }
    }
    await page.mouse.up();
    await page.waitForTimeout(200);
  }),
);
const undoLabel = await page.evaluate(() => window.__canvas.editor.getState().history.undoLabel);
await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
await page.waitForTimeout(200);

// 3. Marquee over half the cards.
// Marquee starts on the pasteboard: a press on a layer drags it.
const m0 = await toClient(-40, 150);
const m1 = await toClient(980, 760);
results.push(await record("marquee", () => drag(m0, m1, 90)));
const marqueeCount = await page.evaluate(() => window.__canvas.editor.getState().selection.length);
await shot("03-marquee-selection");

// 4. Resize the marquee selection from its bottom-right corner.
const box = await page.evaluate(() => {
  const ed = window.__canvas.editor;
  const ids = ed.getState().selection;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const id of ids) {
    const n = ed.design.nodes[id];
    x1 = Math.max(x1, n.x + n.width);
    y1 = Math.max(y1, n.y + n.height);
  }
  return { x1, y1 };
});
const corner = await toClient(box.x1, box.y1);
results.push(
  await record("resize selection", () => drag(corner, { x: corner.x + 160, y: corner.y + 90 }, 90)),
);
await shot("04-resized");
await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
// Undo restores the selection asynchronously: clear it once the undo landed.
await page.waitForTimeout(300);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// 5. Wheel pans (trackpad-like).
results.push(
  await record("wheel pan", async () => {
    await page.mouse.move(700, 450);
    for (let i = 0; i < 90; i++) {
      await page.mouse.wheel(i < 45 ? 12 : -12, i < 45 ? 8 : -8);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    }
  }),
);

// 6. Smooth zoom (command) to selection and back.
const viewAfterPan = await page.evaluate(() => {
  const c = window.__canvas.controller();
  const s = window.__canvas.editor.getState();
  return {
    g: !!c.gesture,
    st: !!c.starting,
    mode: c.mode?.kind,
    tool: s.tool,
    held: s.heldTool,
    sel: s.selection.length,
    focus: document.activeElement?.tagName,
  };
});
const cardNow = await nodeCenter(ids.card);
viewAfterPan.hit = await page.evaluate(
  async ([x, y]) => {
    const c = window.__canvas.controller();
    const r = c.root.getBoundingClientRect();
    const el = document.elementFromPoint(x, y);
    return {
      path: await c.hitPath({ x: x - r.left, y: y - r.top }),
      top: el?.outerHTML.slice(0, 80),
    };
  },
  [cardNow.x, cardNow.y],
);
await page.mouse.click(cardNow.x, cardNow.y);
// The click selects after an engine hit test (one worker round trip).
await page.waitForTimeout(150);
const zoomTarget = await page.evaluate(() =>
  window.__canvas.editor
    .getState()
    .selection.map((id) => window.__canvas.editor.design.nodes[id].name),
);
await page.keyboard.press("Shift+2");
await page.waitForTimeout(500);
await shot("05-zoom-selection");
const zoomed = await page.evaluate(() => window.__canvas.editor.getState().viewport.zoom);
await page.keyboard.press("Shift+1");
await page.waitForTimeout(500);

// 7. Rulers and a guide dragged from the top ruler; alt measurements.
await page.keyboard.press("Shift+r");
await page.waitForTimeout(200);
const canvasRect = await page.evaluate(() => {
  const r = document.querySelector("[data-canvas-interaction]").getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
});
const g = await toClient(0, 600);
await drag(
  { x: canvasRect.left + 400, y: canvasRect.top + 10 },
  { x: canvasRect.left + 400, y: g.y },
  30,
);
const guides = await page.evaluate(() => window.__canvas.editor.currentPage().guides);
await page.mouse.click(card.x, card.y);
const card2 = await nodeCenter(ids.card2);
await page.keyboard.down("Alt");
await page.mouse.move(card2.x, card2.y);
await page.waitForTimeout(250);
await shot("06-rulers-guide-measure");
await page.keyboard.up("Alt");

// 8. Path editing on the wave (double click).
await page.keyboard.press("Shift+r");
const waveTop = await toClient(1500 + 180, 920 + 40);
await page.mouse.dblclick(waveTop.x, waveTop.y, { delay: 40 });
await page.waitForTimeout(300);
await shot("07-path-edit");
await page.keyboard.press("Escape");
await page.waitForTimeout(100);

// 9. Crop mode on the photo (double click), drag the image inside the frame.
const photo = await nodeCenter(ids.photo);
await page.mouse.dblclick(photo.x, photo.y, { delay: 40 });
await page.waitForTimeout(400);
await drag(photo, { x: photo.x - 30, y: photo.y - 10 }, 20);
await shot("08-crop");
const cropped = await page.evaluate(
  (id) => window.__canvas.editor.design.nodes[id].crop,
  ids.photo,
);
await page.keyboard.press("Enter");

// 10. Text editing with the toolbar.
const title = await toClient(64 + 300, 40 + 43);
await page.mouse.dblclick(title.x, title.y, { delay: 40 });
await page.waitForTimeout(400);
await page.keyboard.press("End");
await page.keyboard.type(" now");
await page.waitForTimeout(600);
await page.keyboard.down("Shift");
for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
await page.keyboard.up("Shift");
await page.waitForTimeout(300);
await shot("09-text-editing");
await page.keyboard.press("Escape");
await page.waitForTimeout(700);
const titleText = await page.evaluate(
  (id) => window.__canvas.editor.design.nodes[id].runs.map((r) => r.text).join(""),
  ids.title,
);

// 11. Pen drawing in progress.
await page.keyboard.press("p");
const p0 = await toClient(200, 1000);
const p1 = await toClient(420, 960);
const p2 = await toClient(600, 1030);
await page.mouse.click(p0.x, p0.y);
await drag(p1, { x: p1.x + 60, y: p1.y - 30 }, 10);
await page.mouse.move(p2.x, p2.y);
await page.waitForTimeout(150);
await shot("10-pen");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);

// 12. Rectangle tool with size label (mid-drag).
await page.keyboard.press("r");
const r0 = await toClient(1300, 140);
await page.mouse.move(r0.x, r0.y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(r0.x + i * 12, r0.y + i * 8);
await page.waitForTimeout(150);
await shot("11-draw-rect");
await page.mouse.up();
await page.waitForTimeout(200);

// 13. Auto-layout frame: padding and gap handles on hover.
await page.keyboard.press("Escape");
await page.keyboard.press("v");
await page.evaluate((id) => window.__canvas.editor.select([id]), ids.row);
await page.keyboard.press("Shift+2");
await page.waitForTimeout(500);
const rowMid = await nodeCenter(ids.row);
await page.mouse.move(rowMid.x + 3, rowMid.y + 18);
await page.waitForTimeout(200);
await shot("12-autolayout-handles");
await page.keyboard.press("Shift+1");
await page.waitForTimeout(500);

// 14. Pencil stroke.
await page.keyboard.press("Shift+p");
const s0 = await toClient(820, 130);
await page.mouse.move(s0.x, s0.y);
await page.mouse.down();
for (let i = 1; i <= 50; i++) {
  await page.mouse.move(s0.x + i * 6, s0.y + Math.sin(i / 5) * 25);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}
await page.mouse.up();
await page.waitForTimeout(300);
await shot("13-pencil");

// 15. Drag and drop: an SVG file and plain text from another app.
const dropAt = await toClient(900, 980);
const dropped = await page.evaluate(
  async ([x, y]) => {
    const el = document.querySelector("[data-canvas-interaction]");
    const fire = (type, dt) =>
      el.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          dataTransfer: dt,
        }),
      );
    const svg = new DataTransfer();
    svg.items.add(
      new File(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="36" fill="#ffb02e"/></svg>',
        ],
        "sun.svg",
        { type: "image/svg+xml" },
      ),
    );
    fire("dragenter", svg);
    fire("dragover", svg);
    fire("drop", svg);
    await new Promise((r) => setTimeout(r, 400));
    const text = new DataTransfer();
    text.setData("text/plain", "Dropped words");
    fire("dragenter", text);
    fire("dragover", text);
    fire("drop", text);
    await new Promise((r) => setTimeout(r, 400));
    const nodes = Object.values(window.__canvas.editor.design.nodes);
    return {
      svg: nodes.some((n) => n.type === "svg"),
      text: nodes.some(
        (n) => n.type === "text" && n.runs.map((r) => r.text).join("") === "Dropped words",
      ),
    };
  },
  [dropAt.x, dropAt.y],
);
await shot("14-dropped");

// 16. Two-finger pinch zoom (touch).
const cdp = await page.context().newCDPSession(page);
const zoomBefore = await page.evaluate(() => window.__canvas.editor.getState().viewport.zoom);
const cx = canvasRect.left + canvasRect.width / 2;
const cy = canvasRect.top + canvasRect.height / 2;
const touch = (type, d) =>
  cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints:
      type === "touchEnd"
        ? []
        : [
            { x: cx - d, y: cy, id: 1 },
            { x: cx + d, y: cy, id: 2 },
          ],
  });
await touch("touchStart", 40);
for (let d = 40; d <= 120; d += 8) await touch("touchMove", d);
await touch("touchEnd", 0);
await page.waitForTimeout(200);
const zoomAfter = await page.evaluate(() => window.__canvas.editor.getState().viewport.zoom);

const history = await page.evaluate(() =>
  window.__canvas.editor.history.undoStack.map((e) => e.label),
);
const report = {
  history,
  steps,
  dropped,
  zoomTarget,
  viewAfterPan,
  pinch: { zoomBefore, zoomAfter },
  theme,
  nodeCount,
  results,
  undoLabel,
  marqueeCount,
  zoomed,
  guides,
  cropped,
  titleText,
  errors,
};
writeFileSync(
  `${out}${theme === "dark" ? "" : `${theme}-`}report.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
await browser.close();
