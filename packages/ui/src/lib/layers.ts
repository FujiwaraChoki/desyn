/**
 * Layering conventions. Every portalled surface uses one of these z-index classes (backed by the
 * `--z-*` tokens) so stacking is predictable app-wide:
 * dropdown (menus, selects, popovers) < overlay (scrims) < modal (dialogs, sheets)
 * < popover (surfaces opened from a modal) < toast < tooltip.
 */
export const layers = {
  raised: "z-(--z-raised)",
  sticky: "z-(--z-sticky)",
  dock: "z-(--z-dock)",
  dropdown: "z-(--z-dropdown)",
  overlay: "z-(--z-overlay)",
  modal: "z-(--z-modal)",
  popover: "z-(--z-popover)",
  toast: "z-(--z-toast)",
  tooltip: "z-(--z-tooltip)",
} as const;
