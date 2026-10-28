import { AlertTriangle, CircleAlert, Info, Lightbulb, OctagonAlert } from "lucide-react";
import type { ReactNode } from "react";

const VARIANTS = {
  note: { icon: Info, label: "Note" },
  tip: { icon: Lightbulb, label: "Tip" },
  important: { icon: CircleAlert, label: "Important" },
  warning: { icon: AlertTriangle, label: "Warning" },
  danger: { icon: OctagonAlert, label: "Danger" },
} as const;

type Variant = keyof typeof VARIANTS;

export function Callout({
  type = "note",
  title,
  children,
}: {
  type?: Variant;
  title?: string;
  children: ReactNode;
}) {
  const variant = VARIANTS[type] ?? VARIANTS.note;
  const Icon = variant.icon;
  return (
    <aside className="callout" data-type={type} aria-label={title ?? variant.label}>
      <Icon className="callout-icon" size={18} aria-hidden />
      <div className="callout-body">
        <p className="callout-title">{title ?? variant.label}</p>
        {children}
      </div>
    </aside>
  );
}
