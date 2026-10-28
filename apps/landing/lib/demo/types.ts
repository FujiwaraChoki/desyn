/**
 * The landing-page demo works on a small, faithful subset of the Desyn document model
 * (docs/DOCUMENT_MODEL.md): real layers with ids, names, roles and geometry in design pixels on a
 * 1080x1350 page. It is scripted (no model call), but every edit is a real transformation of
 * layer properties, and untouched layers stay exactly as they were.
 */

export const ARTBOARD = { width: 1080, height: 1350 } as const;

export type DemoRole =
  | "background"
  | "decoration"
  | "photo"
  | "eyebrow"
  | "headline"
  | "subhead"
  | "cta";
export type DemoKind = "rect" | "ellipse" | "image" | "text" | "button";
export type ArtId = "cup" | "vinyl" | "hills";

export interface DemoLayer {
  id: string;
  name: string;
  kind: DemoKind;
  role: DemoRole;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  /** Solid fill (rect/ellipse/button). Background uses fill + fill2 as a vertical gradient. */
  fill?: string;
  fill2?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  text?: string;
  font?: "serif" | "sans";
  fontSize?: number;
  italic?: boolean;
  color?: string;
  align?: "left" | "center" | "right";
  letterSpacing?: number;
  upper?: boolean;
  lineHeight?: number;
  art?: ArtId;
  /** Recolourable illustration palette: [main, shade, accent]. */
  artColors?: [string, string, string];
}

export type EditId = "premium" | "move-right" | "bigger-headline" | "sunset" | "french";

export interface Blueprint {
  id: "product" | "night" | "retreat";
  label: string;
  /** A one-line description of what the AI "planned", shown in the run log. */
  plan: string;
  layers: DemoLayer[];
  edits: EditId[];
  french: Partial<Record<DemoRole, string>>;
}

export interface DemoDesign {
  blueprint: Blueprint["id"];
  layers: DemoLayer[];
  /** Headline came from the visitor's own prompt (so translation leaves it alone). */
  customHeadline: boolean;
}

export interface EditResult {
  design: DemoDesign;
  touched: string[];
  label: string;
  summary: string;
}
