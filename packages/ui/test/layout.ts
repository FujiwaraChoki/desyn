import { afterEach, beforeEach, vi } from "vitest";

/**
 * jsdom has no layout, so every element measures 0×0 and virtualized lists render nothing.
 * Give elements a viewport-sized box (top-left at 0,0) for the duration of a test file.
 */
export function useFakeLayout(width = 320, height = 600): void {
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, width, height),
    );
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(height);
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(width);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(height);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
}
