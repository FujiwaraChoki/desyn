"use client";

import { MotionConfig } from "motion/react";
import { Direction } from "radix-ui";
import type { ReactNode } from "react";
import { ConfirmProvider } from "./dialog.tsx";
import { ThemeProvider, type ThemeProviderProps } from "./theme.tsx";
import { Toaster, type ToasterProps } from "./toast.tsx";
import { TooltipProvider } from "./tooltip.tsx";

export interface DesynProviderProps extends Omit<ThemeProviderProps, "children"> {
  children: ReactNode;
  /** Text direction for Radix primitives (RTL-ready chrome). */
  dir?: "ltr" | "rtl";
  /** Render the global `<Toaster />` (default true). Pass props to configure it. */
  toaster?: boolean | ToasterProps;
}

/**
 * One wrapper for app roots: theme (persisted system/dark/light), tooltip timing (400 ms),
 * reduced-motion aware animations, `useConfirm()` dialogs and the toast region.
 */
export function DesynProvider({
  children,
  dir = "ltr",
  toaster = true,
  ...themeProps
}: DesynProviderProps) {
  return (
    <ThemeProvider {...themeProps}>
      <Direction.Provider dir={dir}>
        <MotionConfig reducedMotion="user">
          <TooltipProvider>
            <ConfirmProvider>
              {children}
              {toaster ? <Toaster {...(typeof toaster === "object" ? toaster : {})} /> : null}
            </ConfirmProvider>
          </TooltipProvider>
        </MotionConfig>
      </Direction.Provider>
    </ThemeProvider>
  );
}
