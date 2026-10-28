"use client";

import { springSnappy } from "@desyn/tokens/motion";
import { ChevronDown } from "lucide-react";
import { LayoutGroup, motion } from "motion/react";
import {
  Accordion as AccordionPrimitive,
  Collapsible as CollapsiblePrimitive,
  ScrollArea as ScrollAreaPrimitive,
  Separator as SeparatorPrimitive,
  Tabs as TabsPrimitive,
} from "radix-ui";
import {
  type ComponentPropsWithoutRef,
  createContext,
  type ReactNode,
  useContext,
  useId,
} from "react";
import { cn } from "../lib/cn.ts";
import { focusRing } from "../lib/styles.ts";
import { useControllableState } from "../lib/use-controllable.ts";

// ---------------------------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------------------------

type TabsVariant = "underline" | "pill";
const TabsVariantContext = createContext<{ variant: TabsVariant; active: string | undefined }>({
  variant: "underline",
  active: undefined,
});

export interface TabsProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Root> {
  /** `underline` (page sections, inspector) or `pill` (compact toolbars). */
  variant?: TabsVariant;
}

/** Tabs with a sliding sun underline (or pill). Arrow keys move between tabs. */
export function Tabs({
  variant = "underline",
  className,
  value,
  defaultValue,
  onValueChange,
  ...props
}: TabsProps) {
  const layoutId = useId();
  const [active, setActive] = useControllableState<string | undefined>(value, defaultValue, (v) => {
    if (v !== undefined) onValueChange?.(v);
  });
  return (
    <TabsVariantContext.Provider value={{ variant, active }}>
      <LayoutGroup id={layoutId}>
        <TabsPrimitive.Root
          value={active}
          onValueChange={setActive}
          className={cn("flex flex-col gap-3", className)}
          {...props}
        />
      </LayoutGroup>
    </TabsVariantContext.Provider>
  );
}

export function TabsList({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  const { variant } = useContext(TabsVariantContext);
  return (
    <TabsPrimitive.List
      className={cn(
        "relative flex shrink-0 items-center",
        variant === "underline"
          ? "gap-4 border-b border-line-subtle"
          : "gap-0.5 rounded-[8px] bg-fg/6 p-0.5",
        className,
      )}
      {...props}
    />
  );
}

export interface TabsTriggerProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {
  icon?: ReactNode;
}

export function TabsTrigger({ className, icon, children, ...props }: TabsTriggerProps) {
  const { variant, active } = useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "group relative flex cursor-pointer select-none items-center gap-1.5 whitespace-nowrap font-medium text-fg-muted transition-colors duration-150 hover:text-fg-secondary data-[state=active]:text-fg disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4",
        variant === "underline" ? "h-9 text-sm" : "h-7 rounded-[6px] px-2.5 text-xs",
        focusRing,
        className,
      )}
      {...props}
    >
      {active === props.value ? <TabIndicator /> : null}
      <span className="relative z-[1] flex items-center gap-1.5">
        {icon}
        {children}
      </span>
    </TabsPrimitive.Trigger>
  );
}

/** Rendered only in the active trigger; motion's shared layout slides it between triggers. */
function TabIndicator() {
  const { variant } = useContext(TabsVariantContext);
  return (
    <motion.span
      layoutId="tab-indicator"
      transition={springSnappy}
      aria-hidden
      className={cn(
        "pointer-events-none absolute",
        variant === "underline"
          ? "inset-x-0 -bottom-px h-0.5 rounded-full bg-accent"
          : "inset-0 rounded-[6px] bg-surface-3 shadow-[0_1px_3px_rgb(0_0_0/0.25),inset_0_0_0_1px_var(--line-subtle)] light:bg-background",
      )}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("outline-none", focusRing, className)} {...props} />;
}

// ---------------------------------------------------------------------------------------------
// Accordion
// ---------------------------------------------------------------------------------------------

export const Accordion = AccordionPrimitive.Root;

export function AccordionItem({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item className={cn("border-b border-line-subtle", className)} {...props} />
  );
}

export function AccordionTrigger({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        className={cn(
          "group flex flex-1 cursor-pointer items-center justify-between gap-3 py-3 text-left text-sm font-medium text-fg-secondary transition-colors hover:text-fg data-[state=open]:text-fg",
          focusRing,
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown className="size-4 shrink-0 text-fg-muted transition-transform duration-300 ease-out group-data-[state=open]:rotate-180" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content className="dsn-collapse" {...props}>
      <div className={cn("pb-4 text-sm text-fg-muted", className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}

// ---------------------------------------------------------------------------------------------
// Collapsible
// ---------------------------------------------------------------------------------------------

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;

export function CollapsibleContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>) {
  return <CollapsiblePrimitive.Content className={cn("dsn-collapse", className)} {...props} />;
}

export interface SectionProps
  extends Omit<ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>, "title"> {
  /** Section heading (inspector style: small, medium weight). */
  title: ReactNode;
  /** Controls on the right of the header (add button, toggles). */
  actions?: ReactNode;
}

/**
 * Collapsible inspector section: header with chevron and optional actions, animated body.
 */
export function CollapsibleSection({
  title,
  actions,
  children,
  className,
  defaultOpen = true,
  ...props
}: SectionProps) {
  return (
    <CollapsiblePrimitive.Root
      defaultOpen={defaultOpen}
      className={cn("group/section", className)}
      {...props}
    >
      <div className="flex h-9 items-center gap-1 pr-1">
        <CollapsiblePrimitive.Trigger
          className={cn(
            "flex h-7 flex-1 cursor-pointer items-center gap-1.5 rounded-[6px] pl-1 text-left text-xs font-medium text-fg-secondary transition-colors hover:text-fg",
            focusRing,
          )}
        >
          <ChevronDown className="size-3.5 text-fg-muted transition-transform duration-200 group-data-[state=closed]/section:-rotate-90" />
          {title}
        </CollapsiblePrimitive.Trigger>
        {actions ? <div className="flex items-center gap-0.5">{actions}</div> : null}
      </div>
      <CollapsiblePrimitive.Content className="dsn-collapse">
        <div className="pb-3">{children}</div>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

// ---------------------------------------------------------------------------------------------
// ScrollArea & Separator
// ---------------------------------------------------------------------------------------------

export interface ScrollAreaProps extends ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  /** Which scrollbars to render. */
  orientation?: "vertical" | "horizontal" | "both";
  viewportClassName?: string;
}

/** Overlay scrollbars that stay out of the way until hovered (keyboard/wheel scrolling native). */
export function ScrollArea({
  className,
  viewportClassName,
  orientation = "vertical",
  children,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      type="hover"
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        className={cn("size-full rounded-[inherit]", focusRing, viewportClassName)}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {orientation !== "horizontal" ? <ScrollBar orientation="vertical" /> : null}
      {orientation !== "vertical" ? <ScrollBar orientation="horizontal" /> : null}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

export function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Scrollbar>) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      orientation={orientation}
      className={cn(
        "flex touch-none select-none p-0.5 transition-opacity duration-200 data-[state=hidden]:opacity-0",
        orientation === "vertical" ? "h-full w-2.5" : "h-2.5 flex-col",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-fg/20 transition-colors hover:bg-fg/35" />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export interface SeparatorProps extends ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root> {
  /** Optional centered label ("or"). */
  label?: ReactNode;
}

export function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  label,
  ...props
}: SeparatorProps) {
  if (label && orientation === "horizontal") {
    return (
      <div className={cn("flex items-center gap-3 text-2xs text-fg-muted", className)}>
        <SeparatorPrimitive.Root
          decorative={decorative}
          className="h-px flex-1 bg-line-subtle"
          {...props}
        />
        <span>{label}</span>
        <SeparatorPrimitive.Root decorative className="h-px flex-1 bg-line-subtle" />
      </div>
    );
  }
  return (
    <SeparatorPrimitive.Root
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-line-subtle",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}
