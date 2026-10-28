// Test helpers: file:// fetch for Node (the package resolves wasm and fonts relative to its sources), a canvas
// stand-in that records what the engine presents, and fixture loading.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Design } from "@desyn/schema";

export const FIXTURES = fileURLToPath(new URL("../../../spec/fixtures/render/", import.meta.url));

export function fixture(name: string): Design {
  return JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")) as Design;
}

export function fixtureAsset(file: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FIXTURES}assets/${file}`));
}

const MIME: Record<string, string> = {
  wasm: "application/wasm",
  ttf: "font/ttf",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
};

/** Lets `fetch` read `file:` URLs (wasm modules, bundled fonts, fixture assets); everything else is refused. */
export function installFileFetch(): void {
  const handler = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("file:")) return new Response("offline test", { status: 503 });
    try {
      const bytes = readFileSync(fileURLToPath(url));
      const ext = url.split(".").pop() ?? "";
      return new Response(bytes, {
        headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  };
  globalThis.fetch = handler as typeof fetch;
}

export class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

/** A canvas with a 2D context that keeps real pixels for putImageData and whole-pixel self copies. */
export class FakeCanvas {
  private w = 0;
  private h = 0;
  pixels = new Uint8ClampedArray(0);
  readonly log: string[] = [];
  private composite = "source-over";
  private transform = [1, 0, 0, 1, 0, 0];

  constructor(
    readonly cssWidth: number,
    readonly cssHeight: number,
  ) {}

  get width(): number {
    return this.w;
  }
  set width(v: number) {
    this.w = v;
    this.pixels = new Uint8ClampedArray(this.w * this.h * 4);
  }
  get height(): number {
    return this.h;
  }
  set height(v: number) {
    this.h = v;
    this.pixels = new Uint8ClampedArray(this.w * this.h * 4);
  }
  get clientWidth(): number {
    return this.cssWidth;
  }
  get clientHeight(): number {
    return this.cssHeight;
  }
  getBoundingClientRect() {
    return { width: this.cssWidth, height: this.cssHeight, x: 0, y: 0, left: 0, top: 0 };
  }

  getContext() {
    const c = this;
    return {
      save() {},
      restore() {
        c.composite = "source-over";
        c.transform = [1, 0, 0, 1, 0, 0];
      },
      set globalCompositeOperation(v: string) {
        c.composite = v;
      },
      get globalCompositeOperation() {
        return c.composite;
      },
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "low",
      setTransform(...m: number[]) {
        c.transform = m;
      },
      fillRect() {
        c.log.push("fillRect");
      },
      putImageData(
        img: FakeImageData,
        dx: number,
        dy: number,
        x: number,
        y: number,
        w: number,
        h: number,
      ) {
        c.log.push(`put ${x},${y},${w},${h}`);
        for (let row = y; row < y + h; row++) {
          const src = (row * img.width + x) * 4;
          const dst = ((row + dy) * c.w + x + dx) * 4;
          c.pixels.set(img.data.subarray(src, src + w * 4), dst);
        }
      },
      drawImage(src: unknown, dx: number, dy: number) {
        const [a, , , d] = c.transform;
        if (src !== c || a !== 1 || d !== 1) {
          c.log.push("drawImage scaled");
          return;
        }
        c.log.push(`scroll ${dx},${dy}`);
        const old = c.pixels.slice();
        c.pixels.fill(0);
        for (let y = 0; y < c.h; y++) {
          const sy = y - dy;
          if (sy < 0 || sy >= c.h) continue;
          for (let x = 0; x < c.w; x++) {
            const sx = x - dx;
            if (sx < 0 || sx >= c.w) continue;
            const s = (sy * c.w + sx) * 4;
            c.pixels.set(old.subarray(s, s + 4), (y * c.w + x) * 4);
          }
        }
      },
    };
  }
}

export function installCanvasGlobals(): void {
  (globalThis as { ImageData?: unknown }).ImageData ??= FakeImageData;
}
