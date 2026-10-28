// Normalized crop helpers for image nodes.

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Normalized crop that covers a w×h box with a srcW×srcH image (center crop). */
export function coverCrop(
  srcW: number | undefined,
  srcH: number | undefined,
  w: number,
  h: number,
) {
  if (!srcW || !srcH || !w || !h) return { x: 0, y: 0, w: 1, h: 1 };
  const srcRatio = srcW / srcH;
  const boxRatio = w / h;
  if (srcRatio > boxRatio) {
    const cw = boxRatio / srcRatio;
    return { x: round4((1 - cw) / 2), y: 0, w: round4(cw), h: 1 };
  }
  const ch = srcRatio / boxRatio;
  return { x: 0, y: round4((1 - ch) / 2), w: 1, h: round4(ch) };
}
