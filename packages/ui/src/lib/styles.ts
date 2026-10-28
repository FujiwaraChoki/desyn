/**
 * Shared class recipes so every component speaks the same visual language.
 */

/** Visible keyboard focus: 2 px sun ring at 60%, offset from the element. */
export const focusRing =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Focus ring drawn inside the element's border (for inputs and dense rows). */
export const focusRingInset =
  "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

/** Text-input shell: surface-2 fill, hairline border, sun ring on focus. */
export const fieldShell =
  "rounded-control border border-line-subtle bg-surface-2 text-fg shadow-inset transition-[border-color,box-shadow,background-color] duration-200 ease-out hover:border-line focus-within:border-transparent focus-within:ring-2 focus-within:ring-ring has-[[aria-invalid=true]]:border-danger/70 has-[[aria-invalid=true]]:focus-within:ring-danger/50 has-[:disabled]:opacity-50 has-[:disabled]:hover:border-line-subtle";

/** Glass surface for menus and popovers floating over the canvas. */
export const glassSurface =
  "border border-line-subtle bg-glass text-fg shadow-popover backdrop-blur-[20px] backdrop-saturate-[1.2]";

/** Menu/listbox container. */
export const menuContent = `${glassSurface} min-w-44 overflow-hidden rounded-card p-1 dsn-pop`;

/** A row inside a menu, select or command list. */
export const menuItem =
  "relative flex h-8 w-full cursor-default select-none items-center gap-2 rounded-[6px] px-2 text-sm text-fg-secondary outline-none transition-colors duration-100 data-[highlighted]:bg-fg/8 data-[highlighted]:text-fg [&[data-disabled]:not([data-disabled=false])]:pointer-events-none [&[data-disabled]:not([data-disabled=false])]:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-muted data-[highlighted]:[&_svg]:text-fg";

/** Small uppercase-free group label inside menus. */
export const menuLabel = "px-2 pt-2 pb-1 text-2xs font-medium text-fg-muted";

/** Hairline between menu groups. */
export const menuSeparator = "-mx-1 my-1 h-px bg-line-subtle";

/** Right-aligned shortcut hint in a menu row. */
export const menuShortcut = "ml-auto pl-4 font-sans text-2xs tracking-wide text-fg-muted";
