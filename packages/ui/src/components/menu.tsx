"use client";

import { Check, ChevronRight, Circle } from "lucide-react";
import {
  ContextMenu as ContextMenuPrimitive,
  DropdownMenu as DropdownMenuPrimitive,
  Menubar as MenubarPrimitive,
} from "radix-ui";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { menuContent, menuItem, menuLabel, menuSeparator } from "../lib/styles.ts";
import { Shortcut } from "./kbd.tsx";
import { useFloatingLayer, usePortalContainer } from "./portal.tsx";

/**
 * DropdownMenu, ContextMenu and Menubar share one look: glass panel, 32 px rows, muted icons,
 * right-aligned OS-formatted shortcuts and a red `destructive` tone.
 */

interface ItemExtras {
  /** Leading icon (Lucide element). */
  icon?: ReactNode;
  /** Shortcut like `"mod+d"`, formatted for the OS. */
  shortcut?: string;
  /** Red tone for destructive actions (delete, discard). */
  destructive?: boolean;
  /** Indent to align with items that have icons/indicators. */
  inset?: boolean;
}

const destructiveClass =
  "text-danger data-[highlighted]:bg-danger/12 data-[highlighted]:text-danger [&_svg]:text-danger! ";

function ItemContent({
  icon,
  shortcut,
  children,
}: {
  icon?: ReactNode;
  shortcut?: string;
  children?: ReactNode;
}) {
  return (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? <Shortcut keys={shortcut} variant="text" className="ml-auto pl-4" /> : null}
    </>
  );
}

const indicatorSlot = "absolute left-2 flex size-4 items-center justify-center";

// ---------------------------------------------------------------------------------------------
// DropdownMenu
// ---------------------------------------------------------------------------------------------

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>) {
  const container = usePortalContainer();
  const layer = useFloatingLayer();
  return (
    <DropdownMenuPrimitive.Portal container={container ?? undefined}>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          layer,
          menuContent,
          "origin-(--radix-dropdown-menu-content-transform-origin) max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export type DropdownMenuItemProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> &
  ItemExtras;

export function DropdownMenuItem({
  className,
  icon,
  shortcut,
  destructive,
  inset,
  children,
  ...props
}: DropdownMenuItemProps) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(menuItem, destructive && destructiveClass, inset && "pl-8", className)}
      {...props}
    >
      <ItemContent icon={icon} shortcut={shortcut}>
        {children}
      </ItemContent>
    </DropdownMenuPrimitive.Item>
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  shortcut,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem> & { shortcut?: string }) {
  return (
    <DropdownMenuPrimitive.CheckboxItem className={cn(menuItem, "pl-8", className)} {...props}>
      <span className={indicatorSlot}>
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="text-accent!" strokeWidth={2.5} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      <ItemContent shortcut={shortcut}>{children}</ItemContent>
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem className={cn(menuItem, "pl-8", className)} {...props}>
      <span className={indicatorSlot}>
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle className="size-2! fill-accent text-accent!" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      <span className="truncate">{children}</span>
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  inset,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.Label className={cn(menuLabel, inset && "pl-8", className)} {...props} />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={cn(menuSeparator, className)} {...props} />;
}

export function DropdownMenuSubTrigger({
  className,
  icon,
  inset,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> &
  Pick<ItemExtras, "icon" | "inset">) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(
        menuItem,
        "data-[state=open]:bg-fg/8 data-[state=open]:text-fg",
        inset && "pl-8",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
      <ChevronRight className="ml-auto size-3.5!" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>) {
  const container = usePortalContainer();
  const layer = useFloatingLayer();
  return (
    <DropdownMenuPrimitive.Portal container={container ?? undefined}>
      <DropdownMenuPrimitive.SubContent
        sideOffset={4}
        className={cn(
          layer,
          menuContent,
          "origin-(--radix-dropdown-menu-content-transform-origin)",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

// ---------------------------------------------------------------------------------------------
// ContextMenu
// ---------------------------------------------------------------------------------------------

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuGroup = ContextMenuPrimitive.Group;
export const ContextMenuSub = ContextMenuPrimitive.Sub;
export const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

export function ContextMenuContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>) {
  const container = usePortalContainer();
  const layer = useFloatingLayer();
  return (
    <ContextMenuPrimitive.Portal container={container ?? undefined}>
      <ContextMenuPrimitive.Content
        collisionPadding={8}
        className={cn(
          layer,
          menuContent,
          "origin-(--radix-context-menu-content-transform-origin) max-h-(--radix-context-menu-content-available-height) overflow-y-auto",
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export type ContextMenuItemProps = ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> &
  ItemExtras;

export function ContextMenuItem({
  className,
  icon,
  shortcut,
  destructive,
  inset,
  children,
  ...props
}: ContextMenuItemProps) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(menuItem, destructive && destructiveClass, inset && "pl-8", className)}
      {...props}
    >
      <ItemContent icon={icon} shortcut={shortcut}>
        {children}
      </ItemContent>
    </ContextMenuPrimitive.Item>
  );
}

export function ContextMenuCheckboxItem({
  className,
  children,
  shortcut,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem> & { shortcut?: string }) {
  return (
    <ContextMenuPrimitive.CheckboxItem className={cn(menuItem, "pl-8", className)} {...props}>
      <span className={indicatorSlot}>
        <ContextMenuPrimitive.ItemIndicator>
          <Check className="text-accent!" strokeWidth={2.5} />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      <ItemContent shortcut={shortcut}>{children}</ItemContent>
    </ContextMenuPrimitive.CheckboxItem>
  );
}

export function ContextMenuRadioItem({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem>) {
  return (
    <ContextMenuPrimitive.RadioItem className={cn(menuItem, "pl-8", className)} {...props}>
      <span className={indicatorSlot}>
        <ContextMenuPrimitive.ItemIndicator>
          <Circle className="size-2! fill-accent text-accent!" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      <span className="truncate">{children}</span>
    </ContextMenuPrimitive.RadioItem>
  );
}

export function ContextMenuLabel({
  className,
  inset,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.Label className={cn(menuLabel, inset && "pl-8", className)} {...props} />
  );
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator className={cn(menuSeparator, className)} {...props} />;
}

export function ContextMenuSubTrigger({
  className,
  icon,
  inset,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> &
  Pick<ItemExtras, "icon" | "inset">) {
  return (
    <ContextMenuPrimitive.SubTrigger
      className={cn(
        menuItem,
        "data-[state=open]:bg-fg/8 data-[state=open]:text-fg",
        inset && "pl-8",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
      <ChevronRight className="ml-auto size-3.5!" />
    </ContextMenuPrimitive.SubTrigger>
  );
}

export function ContextMenuSubContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>) {
  const container = usePortalContainer();
  const layer = useFloatingLayer();
  return (
    <ContextMenuPrimitive.Portal container={container ?? undefined}>
      <ContextMenuPrimitive.SubContent
        sideOffset={4}
        className={cn(
          layer,
          menuContent,
          "origin-(--radix-context-menu-content-transform-origin)",
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

// ---------------------------------------------------------------------------------------------
// Menubar (desktop-style app menu: File, Edit, View...)
// ---------------------------------------------------------------------------------------------

export function Menubar({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenubarPrimitive.Root>) {
  return (
    <MenubarPrimitive.Root className={cn("flex h-8 items-center gap-0.5", className)} {...props} />
  );
}

export const MenubarMenu = MenubarPrimitive.Menu;
export const MenubarGroup = MenubarPrimitive.Group;
export const MenubarSub = MenubarPrimitive.Sub;
export const MenubarRadioGroup = MenubarPrimitive.RadioGroup;

export function MenubarTrigger({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenubarPrimitive.Trigger>) {
  return (
    <MenubarPrimitive.Trigger
      className={cn(
        "flex h-7 cursor-default select-none items-center rounded-[6px] px-2.5 text-sm text-fg-secondary outline-none transition-colors hover:bg-fg/6 hover:text-fg focus-visible:bg-fg/8 data-[state=open]:bg-fg/8 data-[state=open]:text-fg",
        className,
      )}
      {...props}
    />
  );
}

export function MenubarContent({
  className,
  align = "start",
  sideOffset = 6,
  alignOffset = -4,
  ...props
}: ComponentPropsWithoutRef<typeof MenubarPrimitive.Content>) {
  const container = usePortalContainer();
  const layer = useFloatingLayer();
  return (
    <MenubarPrimitive.Portal container={container ?? undefined}>
      <MenubarPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={8}
        className={cn(
          layer,
          menuContent,
          "min-w-52 origin-(--radix-menubar-content-transform-origin)",
          className,
        )}
        {...props}
      />
    </MenubarPrimitive.Portal>
  );
}

export type MenubarItemProps = ComponentPropsWithoutRef<typeof MenubarPrimitive.Item> & ItemExtras;

export function MenubarItem({
  className,
  icon,
  shortcut,
  destructive,
  inset,
  children,
  ...props
}: MenubarItemProps) {
  return (
    <MenubarPrimitive.Item
      className={cn(menuItem, destructive && destructiveClass, inset && "pl-8", className)}
      {...props}
    >
      <ItemContent icon={icon} shortcut={shortcut}>
        {children}
      </ItemContent>
    </MenubarPrimitive.Item>
  );
}

export function MenubarCheckboxItem({
  className,
  children,
  shortcut,
  ...props
}: ComponentPropsWithoutRef<typeof MenubarPrimitive.CheckboxItem> & { shortcut?: string }) {
  return (
    <MenubarPrimitive.CheckboxItem className={cn(menuItem, "pl-8", className)} {...props}>
      <span className={indicatorSlot}>
        <MenubarPrimitive.ItemIndicator>
          <Check className="text-accent!" strokeWidth={2.5} />
        </MenubarPrimitive.ItemIndicator>
      </span>
      <ItemContent shortcut={shortcut}>{children}</ItemContent>
    </MenubarPrimitive.CheckboxItem>
  );
}

export function MenubarRadioItem({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof MenubarPrimitive.RadioItem>) {
  return (
    <MenubarPrimitive.RadioItem className={cn(menuItem, "pl-8", className)} {...props}>
      <span className={indicatorSlot}>
        <MenubarPrimitive.ItemIndicator>
          <Circle className="size-2! fill-accent text-accent!" />
        </MenubarPrimitive.ItemIndicator>
      </span>
      <span className="truncate">{children}</span>
    </MenubarPrimitive.RadioItem>
  );
}

export function MenubarLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenubarPrimitive.Label>) {
  return <MenubarPrimitive.Label className={cn(menuLabel, className)} {...props} />;
}

export function MenubarSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenubarPrimitive.Separator>) {
  return <MenubarPrimitive.Separator className={cn(menuSeparator, className)} {...props} />;
}

export function MenubarSubTrigger({
  className,
  icon,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof MenubarPrimitive.SubTrigger> & Pick<ItemExtras, "icon">) {
  return (
    <MenubarPrimitive.SubTrigger
      className={cn(menuItem, "data-[state=open]:bg-fg/8 data-[state=open]:text-fg", className)}
      {...props}
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
      <ChevronRight className="ml-auto size-3.5!" />
    </MenubarPrimitive.SubTrigger>
  );
}

export function MenubarSubContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenubarPrimitive.SubContent>) {
  const container = usePortalContainer();
  const layer = useFloatingLayer();
  return (
    <MenubarPrimitive.Portal container={container ?? undefined}>
      <MenubarPrimitive.SubContent
        sideOffset={4}
        className={cn(
          layer,
          menuContent,
          "origin-(--radix-menubar-content-transform-origin)",
          className,
        )}
        {...props}
      />
    </MenubarPrimitive.Portal>
  );
}
