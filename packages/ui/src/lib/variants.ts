import { cva } from "class-variance-authority";
import { fieldShell, focusRing } from "./styles.ts";

/*
 * Class recipes (class-variance-authority) for Desyn controls. They live outside the component
 * modules (which are client modules) so Server Components can style links and other elements
 * with them, e.g. `<a className={buttonVariants({ variant: "primary" })}>`.
 */

/** Button styles: `variant` primary/secondary/outline/ghost/danger/link, `size` xs-xl, `shape`. */
export const buttonVariants = cva(
  [
    "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap font-sans font-medium",
    "transition-[background-color,border-color,color,box-shadow,opacity,transform] duration-200 ease-out",
    "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 aria-busy:cursor-progress",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
    focusRing,
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-accent-solid text-accent-ink hover:bg-[color-mix(in_srgb,var(--accent-solid),white_14%)] disabled:bg-fg/10 disabled:text-fg-muted disabled:opacity-100",
        secondary:
          "border border-line-subtle bg-surface-2 text-fg shadow-inset hover:border-line hover:bg-surface-3",
        outline:
          "border border-line bg-transparent text-fg-secondary hover:border-line-strong hover:text-fg",
        ghost:
          "bg-transparent text-fg-secondary hover:bg-fg/6 hover:text-fg data-[state=open]:bg-fg/8",
        danger: "bg-danger text-danger-ink hover:bg-[color-mix(in_srgb,var(--danger),white_10%)]",
        link: "h-auto! rounded-sm px-0! text-accent-text underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        xs: "h-6 gap-1 rounded-[5px] px-2 text-xs [&_svg]:size-3.5",
        sm: "h-7 gap-1.5 rounded-control px-2.5 text-sm [&_svg]:size-3.5",
        md: "h-8 rounded-control px-3 text-sm [&_svg]:size-4",
        lg: "h-10 rounded-[8px] px-4 text-base [&_svg]:size-4",
        xl: "h-12 rounded-[10px] px-6 text-md [&_svg]:size-5",
      },
      shape: {
        default: "",
        pill: "rounded-full",
      },
    },
    defaultVariants: { variant: "secondary", size: "md", shape: "default" },
  },
);

/** Square icon-only button styles (24/28/32/36 px). */
export const iconButtonVariants = cva(
  [
    "inline-flex shrink-0 cursor-pointer select-none items-center justify-center rounded-control",
    "transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-95",
    "disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    focusRing,
  ],
  {
    variants: {
      variant: {
        ghost:
          "text-fg-secondary hover:bg-fg/7 hover:text-fg aria-pressed:bg-fg/10 aria-pressed:text-accent data-[state=open]:bg-fg/8 data-[state=open]:text-fg data-[state=on]:bg-fg/10 data-[state=on]:text-accent",
        secondary:
          "border border-line-subtle bg-surface-2 text-fg-secondary shadow-inset hover:border-line hover:bg-surface-3 hover:text-fg aria-pressed:border-accent/40 aria-pressed:text-accent",
        primary:
          "bg-accent-solid text-accent-ink hover:bg-[color-mix(in_srgb,var(--accent-solid),white_14%)] disabled:bg-fg/10 disabled:text-fg-muted disabled:opacity-100",
        danger: "text-danger hover:bg-danger/12",
      },
      size: {
        xs: "size-6 [&_svg]:size-3.5",
        sm: "size-7 [&_svg]:size-4",
        md: "size-8 [&_svg]:size-4",
        lg: "size-9 [&_svg]:size-[18px]",
      },
      shape: { default: "", round: "rounded-full" },
    },
    defaultVariants: { variant: "ghost", size: "md", shape: "default" },
  },
);

/** Text-input shell (surface-2 fill, hairline border, sun focus ring) in three sizes. */
export const inputShellVariants = cva(`${fieldShell} flex w-full min-w-0 items-center`, {
  variants: {
    size: {
      sm: "h-7 gap-1.5 px-2 text-xs [&_svg]:size-3.5",
      md: "h-8 gap-2 px-2.5 text-sm [&_svg]:size-4",
      lg: "h-10 gap-2 px-3 text-base [&_svg]:size-4",
    },
  },
  defaultVariants: { size: "md" },
});

/** Badge styles: `tone` and `size`. */
export const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full font-medium [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "bg-fg/8 text-fg-secondary",
        accent: "bg-accent-tint text-accent-text",
        success: "bg-success/14 text-success",
        warning: "bg-warning/16 text-accent-text",
        danger: "bg-danger/14 text-danger",
        info: "bg-info/14 text-info",
        outline: "border border-line text-fg-secondary",
      },
      size: {
        sm: "h-[18px] px-1.5 text-[10px]",
        md: "h-5 px-2 text-2xs",
        lg: "h-6 px-2.5 text-xs",
      },
    },
    defaultVariants: { tone: "neutral", size: "md" },
  },
);
