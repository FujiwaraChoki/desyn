"use client";

import { useEffect, useState } from "react";
import type { SlotProps } from "../shell/extensions.ts";

/** Props of a registered modal component (see `registerModal`). */
export type ModalProps = SlotProps & { props: Record<string, unknown>; close: () => void };

/** False on the first frame after mount, then true: drives CSS enter transitions without keyframes. */
export function useEntered(): boolean {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return entered;
}
