"use client";

import { Portal as RadixPortal } from "radix-ui";
import { createContext, type ReactNode, useContext } from "react";
import { layers } from "../lib/layers.ts";

/** Whether the subtree is inside a modal surface (dialog, sheet, command palette). */
const ModalLayerContext = createContext(false);

/**
 * Marks its subtree as living inside a modal layer. Dialog, AlertDialog, Sheet and CommandPalette
 * content wrap their children in it so menus, selects and popovers opened from inside them stack
 * above the modal instead of behind it.
 */
export function ModalLayerProvider({ children }: { children: ReactNode }) {
  return <ModalLayerContext.Provider value={true}>{children}</ModalLayerContext.Provider>;
}

/**
 * z-index class for a floating surface (menu, select, popover, hover card): `dropdown` normally,
 * `popover` when opened from inside a modal or when `elevated` is forced.
 */
export function useFloatingLayer(elevated = false): string {
  const inModal = useContext(ModalLayerContext);
  return elevated || inModal ? layers.popover : layers.dropdown;
}

/** Where portalled content mounts. `null` means `document.body`. */
export const PortalContainerContext = createContext<HTMLElement | null>(null);

/** The element portals should mount into (set by `ThemeScope` / `PortalContainerProvider`). */
export function usePortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext);
}

/** Routes every Desyn portal in the subtree into `container`. */
export function PortalContainerProvider({
  container,
  children,
}: {
  container: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>
  );
}

export interface PortalProps {
  children: ReactNode;
  /** Explicit container; defaults to the nearest `PortalContainerProvider` or `document.body`. */
  container?: HTMLElement | null;
}

/** Portal that respects the layering context (themes, scoped containers). */
export function Portal({ children, container }: PortalProps) {
  const ctx = usePortalContainer();
  return <RadixPortal.Root container={container ?? ctx ?? undefined}>{children}</RadixPortal.Root>;
}
