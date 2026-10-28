import { DESIGN_KIND_INFO } from "@desyn/schema/kinds";
import {
  Award,
  BookOpen,
  ChartColumn,
  Clapperboard,
  File,
  FileText,
  Frame,
  Globe,
  Hexagon,
  IdCard,
  Image,
  type LucideIcon,
  MailOpen,
  Megaphone,
  MonitorSmartphone,
  Newspaper,
  PanelTop,
  Presentation,
  Ruler,
  Smartphone,
  Square,
  Sticker,
  UserRound,
  Utensils,
} from "lucide-react";

/** Lucide components for the kebab-case icon names in DESIGN_KIND_INFO (static: no full icon bundle). */
const ICONS: Record<string, LucideIcon> = {
  square: Square,
  smartphone: Smartphone,
  frame: Frame,
  "file-text": FileText,
  image: Image,
  "panel-top": PanelTop,
  megaphone: Megaphone,
  presentation: Presentation,
  "chart-column": ChartColumn,
  "id-card": IdCard,
  "user-round": UserRound,
  "mail-open": MailOpen,
  utensils: Utensils,
  hexagon: Hexagon,
  newspaper: Newspaper,
  file: File,
  globe: Globe,
  clapperboard: Clapperboard,
  "book-open": BookOpen,
  award: Award,
  sticker: Sticker,
  "monitor-smartphone": MonitorSmartphone,
  ruler: Ruler,
};

export function kindLabel(kind: string): string {
  return (
    (DESIGN_KIND_INFO as Record<string, { label: string } | undefined>)[kind]?.label ?? "Design"
  );
}

export function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const info = (DESIGN_KIND_INFO as Record<string, { icon: string } | undefined>)[kind];
  const Icon = (info && ICONS[info.icon]) ?? Square;
  return <Icon aria-hidden className={className} />;
}
