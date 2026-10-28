# @desyn/ui

React 19 component library for the Desyn apps: Radix primitives, Tailwind CSS 4, `motion`, Lucide, cmdk and TanStack Virtual,
styled with `@desyn/tokens`. Internal package: `exports` point at TypeScript source; consumers transpile it
(Next: `transpilePackages: ["@desyn/ui", "@desyn/tokens"]`).

## Setup

```css
/* app global CSS */
@import "tailwindcss";
@import "@desyn/tokens/fonts.css";
@import "@desyn/ui/styles.css"; /* tokens + component CSS + @source for this package */
```

```tsx
import { DesynProvider, themeScript } from "@desyn/ui";
// <head>: <script dangerouslySetInnerHTML={{ __html: themeScript() }} /> (no theme flash)
<DesynProvider>{children}</DesynProvider> // theme, tooltips (400 ms), reduced motion, useConfirm, Toaster
```

### Next.js (App Router, verified with Next 16.4 + Turbopack)

- `next.config.ts`: `transpilePackages: ["@desyn/ui", "@desyn/tokens"]`.
- `tsconfig.json`: add `"allowImportingTsExtensions": true` (Next already sets `noEmit`). Both packages import their
  own source with explicit `.ts`/`.tsx` extensions (the token generator runs under Node's type stripping), and the
  consumer's type check walks that source.
- Component and hook modules carry `"use client"`, so Server Components can import from `@desyn/ui` and render any
  component with serializable props. Directive-free helpers are callable on the server: `themeScript`, `cn`,
  `buttonVariants` / `iconButtonVariants` / `inputShellVariants` / `badgeVariants`, `layers`, and the color, gradient,
  tree, expression and shortcut utilities.
- Persisted state (theme preference, recent colors, font recents/favorites, panel sizes) is hydration-safe: the server
  and the hydration render use defaults, and stored values apply before the first paint (no mismatch warnings).
- The root layout can be a Server Component: `<html suppressHydrationWarning>` (themeScript sets `data-theme` before
  React hydrates), `<script dangerouslySetInnerHTML={{ __html: themeScript() }} />` in `<head>`, and
  `<DesynProvider>` around `children`.

### Layering

Floating surfaces use `layers` z-index classes backed by the `--z-*` tokens: dropdown (menus, selects, popovers, hover
cards) < overlay (scrims) < modal (dialogs, sheets, palette) < popover < toast < tooltip. Anything opened from inside a
`Dialog`, `AlertDialog`, `Sheet` or `CommandPalette` is raised to the popover layer automatically (`ModalLayerProvider` /
`useFloatingLayer`); wrap custom modal surfaces in `ModalLayerProvider` to get the same behaviour.

## Components

- **Actions**: `Button` (primary/secondary/outline/ghost/danger/link, xs–xl, `pill`, `loading`, `asChild`), `IconButton` (label + tooltip + shortcut), `ButtonGroup`, `Toggle`, `ToggleGroup(Item)`, `Toolbar` (+ `ToolbarButton`, `ToolbarToggleGroup/Item`, `ToolbarSeparator`), `SunSpinner`.
- **Forms**: `Field` (+ `Label`, `HelpText`, `ErrorText`, `useField`, `useFieldControlProps`), `Input`, `Textarea` (autoResize), `NumberField` (drag-label scrub with Shift ×10 / Alt ÷10, arrows, Home/End, expressions like `100/2`, units, mixed state, `onChange` live + `onChangeEnd` once per gesture), `Slider` (single/range), `Select` (+ `SelectRoot/Trigger/Content/Item…`), `Combobox`, `SegmentedControl`, `Switch`, `Checkbox` (indeterminate), `RadioGroup(Item)`.
- **Pickers**: `ColorPicker` (HSV field, hue, alpha, EyeDropper API with fallback callback/native input, hex/rgb/hsl/oklch, brand/document/recent/default swatches), `PaintPicker` (solid/linear/radial/conic, `GradientBar` with draggable stops, `AngleDial`, center for radial/conic, radii for radial), `PaintSwatchButton` (inspector trigger), `FontPicker` / `FontPickerButton` (virtualized, lazy `loadFont`, search, categories, recents, favorites).
- **Overlays**: `Tooltip`, `Popover`, `HoverCard`, `DropdownMenu*`, `ContextMenu*`, `Menubar*`, `Dialog*`, `AlertDialog*`, `useConfirm()`, `Sheet*`/`Drawer*`, `CommandPalette` + `Command*`, `toast()` / `Toaster`.
- **Structure**: `Tabs` (underline/pill, sliding indicator), `Accordion*`, `Collapsible*`, `CollapsibleSection`, `ScrollArea`, `Separator`, `ResizablePanelGroup` / `ResizablePanel` / `ResizableHandle` / `useResizablePanel` (px sizes, collapsible, keyboard, `autoSaveId`), `Tree` + `TreeRowToggle`, `DataTable`, `Breadcrumbs`, `Pagination`, `Stepper`, `Link`.
- **Display**: `Avatar`, `AvatarStack`, `Badge`, `ProBadge`, `Skeleton`, `Progress`, `CircularProgress`, `Card*`, `EmptyState`, `Callout`, `Heading`, `Eyebrow`, `Kbd`, `Shortcut`, `VisuallyHidden`, `Logo`, `SunMark`, `Orbs`, `SunGlow`.
- **Theme & layering**: `ThemeProvider`, `useTheme`, `useResolvedTheme`, `useSystemTheme`, `ThemeScope` (subtree theme; overlays opened inside mount inside it), `themeScript`, `DEFAULT_THEME_STORAGE_KEY`, `layers` (z-index classes), `ModalLayerProvider`, `useFloatingLayer`, `Portal`, `PortalContainerProvider`.
- **Hooks & helpers**: `useHotkeys`, `formatShortcut`/`shortcutKeys`/`matchesShortcut`, `useControllableState`, color math (`parseColor`, `toHex`, `rgbToOklch`…), gradients (`paintToCss`, `convertPaint`, `colorAt`), tree logic (`flattenTree`, `resolveDrop`, `moveTreeNodes`), `evaluateExpression`, `cn`.

### Tree drag & drop contract

`onMove(ids, parentId, index)`: `ids` in visual order, `parentId` `null` for the root level, `index` counted among the
parent's children **after the dragged nodes are removed** (`moveTreeNodes` implements the same convention). Below the
last row of an expanded group, moving the pointer left outdents the drop to the group's level (or further up), so nodes
can be dropped after a group as well as at its end; `DropTarget.line` is the row boundary where the indicator is drawn. The editor's
layers panel shows front-most first while the document stores children back-to-front; map indexes accordingly.

### Paint values

`Paint` matches the document model's `Fill` shapes (`solid` / `linear` / `radial` / `conic`, `stops: { pos, color }[]`) minus
`opacity`/`visible`/`blend`. Colors are lowercase `#rrggbb` / `#rrggbbaa`. Colors and numbers coming from documents are
untrusted: `paintToCss`, `Swatch` and the gradient stop chips normalize every color through `cssColor()` (canonical hex or
`transparent`) and every number through a finite check before it reaches a `style` attribute.

## Playground

```sh
pnpm --filter @desyn/ui playground            # http://127.0.0.1:4101
pnpm --filter @desyn/ui screenshots           # with the playground running: PNGs in playground/screenshots/
```

Every component rendered side by side in dark and light, plus an editor composition (top bar, layers tree, canvas with tool
dock + context menu, inspector; collapses to a bottom-sheet inspector on phones).

## Checks

```sh
pnpm --filter @desyn/ui test        # vitest + Testing Library + axe-core (jsdom)
pnpm --filter @desyn/ui typecheck
pnpm --filter @desyn/ui lint
```
