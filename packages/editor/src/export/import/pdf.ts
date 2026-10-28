/// <reference path="./pdfjs-worker.d.ts" />
/**
 * PDF pages as images, rendered in the browser with pdf.js. pdf.js runs its worker code on the main thread
 * ("fake worker": the worker module is imported and registered as `globalThis.pdfjsWorker`), which keeps it
 * independent of how the host bundles web workers; imports are occasional and page-by-page.
 */

export interface RenderedPdfPage {
  index: number;
  count: number;
  /** Page size in design px (PDF points × 96 / 72). */
  width: number;
  height: number;
  image: Blob;
  mime: string;
}

/** Longest side of the rendered page image (px). */
export const PDF_RENDER_MAX_SIDE = 2400;
export const PDF_MAX_PAGES = 200;

type PdfJs = typeof import("pdfjs-dist");

let loading: Promise<PdfJs> | null = null;

async function loadPdfJs(): Promise<PdfJs> {
  loading ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs"),
    ]);
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker ??= worker;
    return pdfjs;
  })();
  try {
    return await loading;
  } catch (e) {
    loading = null;
    throw e;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Couldn't encode the page image."))),
      type,
      quality,
    ),
  );
}

/** Scale that renders a page of `w` x `h` points at most `maxSide` px on its longest side (and at least 1x). */
export function pdfRenderScale(w: number, h: number, maxSide = PDF_RENDER_MAX_SIDE): number {
  const longest = Math.max(w, h, 1);
  return Math.max(1, Math.min(4, maxSide / longest));
}

/** Renders PDF pages one at a time (yielded in order). */
export async function* renderPdfPages(
  data: Uint8Array,
  options: { signal?: AbortSignal; pages?: number[] } = {},
): AsyncGenerator<RenderedPdfPage> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  try {
    const count = Math.min(doc.numPages, PDF_MAX_PAGES);
    const wanted = options.pages ?? Array.from({ length: count }, (_, i) => i);
    for (const index of wanted) {
      if (options.signal?.aborted) throw new DOMException("Import canceled", "AbortError");
      if (index < 0 || index >= count) continue;
      const page = await doc.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = pdfRenderScale(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;
      // PNG keeps text crisp; photographic pages that would be huge fall back to high-quality JPEG.
      let image = await canvasToBlob(canvas, "image/png");
      let mime = "image/png";
      if (image.size > 6 * 1024 * 1024) {
        image = await canvasToBlob(canvas, "image/jpeg", 0.92);
        mime = "image/jpeg";
      }
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
      yield {
        index,
        count,
        width: Math.round(base.width * (96 / 72) * 100) / 100,
        height: Math.round(base.height * (96 / 72) * 100) / 100,
        image,
        mime,
      };
    }
  } finally {
    await task.destroy();
  }
}
