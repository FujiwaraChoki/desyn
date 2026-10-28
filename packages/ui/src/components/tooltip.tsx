"use client";

import { tooltipDelay } from "@desyn/tokens";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { type ComponentPropsWithoutRef, createContext, type ReactNode, useContext } from "react";
import { cn } from "../lib/cn.ts";
import { layers } from "../lib/layers.ts";
import { Shortcut } from "./kbd.tsx";
import { usePortalContainer } from "./portal.tsx";

const ProviderPresent = createContext(false);

export interface TooltipProviderProps {
  children: ReactNode;
  /** Open delay in ms (design system: 400). */
  delayDuration?: number;
  /** Window in which moving to another trigger opens instantly. */
  skipDelayDuration?: number;
}

/** Shares tooltip timing across the app so moving along a toolbar feels instant after the first. */
export function TooltipProvider({
  children,
  delayDuration = tooltipDelay,
  skipDelayDuration = 300,
}: TooltipProviderProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration}>
      <ProviderPresent.Provider value={true}>{children}</ProviderPresent.Provider>
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps
  extends Omit<ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>, "content"> {
  /** The trigger. Must accept a ref and focus/pointer handlers (buttons do). */
  children: ReactNode;
  /** Tooltip text. Keep it to a few words. */
  content: ReactNode;
  /** Shortcut shown after the text, e.g. `"mod+z"`. */
  shortcut?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Overrides the provider delay for this tooltip. */
  delayDuration?: number;
  disabled?: boolean;
}

/**
 * Hover/focus tooltip (400 ms delay) with an optional shortcut. Content is supplementary: the
 * trigger must already have an accessible name.
 */
export function Tooltip({
  children,
  content,
  shortcut,
  open,
  defaultOpen,
  onOpenChange,
  delayDuration,
  disabled,
  side = "top",
  sideOffset = 6,
  className,
  ...props
}: TooltipProps) {
  const hasProvider = useContext(ProviderPresent);
  const container = usePortalContainer();
  if (disabled || content === null || content === undefined || content === "")
    return <>{children}</>;
  const tooltip = (
    <TooltipPrimitive.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      delayDuration={delayDuration}
    >
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={container ?? undefined}>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={sideOffset}
          collisionPadding={8}
          className={cn(
            layers.tooltip,
            "dsn-pop origin-(--radix-tooltip-content-transform-origin) flex max-w-64 select-none items-center gap-2 rounded-[7px] border border-line-subtle bg-surface-3/95 px-2 py-1 text-xs text-fg shadow-popover backdrop-blur-md",
            className,
          )}
          {...props}
        >
          <span>{content}</span>
          {shortcut ? <Shortcut keys={shortcut} variant="text" className="text-fg-muted" /> : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
  return hasProvider ? tooltip : <TooltipProvider>{tooltip}</TooltipProvider>;
}
