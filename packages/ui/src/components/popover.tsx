"use client";

import { HoverCard as HoverCardPrimitive, Popover as PopoverPrimitive } from "radix-ui";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/cn.ts";
import { glassSurface } from "../lib/styles.ts";
import { useFloatingLayer, usePortalContainer } from "./portal.tsx";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export interface PopoverContentProps
  extends ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  /** Remove default padding (for pickers that manage their own layout). */
  flush?: boolean;
  /**
   * Force the popover layer. Inside Desyn dialogs and sheets this is automatic; use it when the
   * popover must sit above a custom modal surface.
   */
  elevated?: boolean;
}

/** Glass panel anchored to its trigger. Focus moves inside; Escape and outside click close it. */
export function PopoverContent({
  className,
  flush = false,
  elevated = false,
  align = "center",
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: PopoverContentProps) {
  const container = usePortalContainer();
  const layer = useFloatingLayer(elevated);
  return (
    <PopoverPrimitive.Portal container={container ?? undefined}>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          layer,
          glassSurface,
          "dsn-pop origin-(--radix-popover-content-transform-origin) rounded-panel outline-none",
          !flush && "w-72 p-3",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export const HoverCard = HoverCardPrimitive.Root;
export const HoverCardTrigger = HoverCardPrimitive.Trigger;

/** Rich preview on hover (profiles, template previews). Not for essential content. */
export function HoverCardContent({
  className,
  align = "center",
  sideOffset = 8,
  ...props
}: ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>) {
  const container = usePortalContainer();
  const layer = useFloatingLayer();
  return (
    <HoverCardPrimitive.Portal container={container ?? undefined}>
      <HoverCardPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          layer,
          glassSurface,
          "dsn-pop origin-(--radix-hover-card-content-transform-origin) w-72 rounded-panel p-4 outline-none",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}
