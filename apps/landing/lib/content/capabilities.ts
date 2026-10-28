export type VignetteId = "generate" | "talk" | "understand" | "assets" | "brand" | "workflows";

export interface Capability {
  id: VignetteId;
  index: string;
  label: string;
  title: [string, string, string?];
  body: string;
  points: string[];
  href: string;
}

/** The six things Desyn's AI does. Titles are [before, italic word, after]. */
export const CAPABILITIES: Capability[] = [
  {
    id: "generate",
    index: "01",
    label: "Generate",
    title: ["Whole designs from ", "one", " sentence."],
    body: "Ask for a menu, a deck or a launch campaign. Desyn plans the layout, writes the copy, picks type and colour, generates the images and builds it all as editable layers.",
    points: [
      "Posters, posts, stories, decks, menus, résumés and more",
      "Real text, shapes and images, never a flattened picture",
      "Starts from a template when one fits",
    ],
    href: "/features/ai",
  },
  {
    id: "talk",
    index: "02",
    label: "Edit by talking",
    title: ["Say it. ", "Done.", ""],
    body: "“Make it more premium.” “Move the product right.” “Warmer.” The agent changes exactly what you asked and leaves everything else alone. Every edit is one undo step.",
    points: [
      "Touches only the layers you meant",
      "Live on the canvas, visible to collaborators",
      "Undo any AI step like your own",
    ],
    href: "/features/ai",
  },
  {
    id: "understand",
    index: "03",
    label: "Understands the canvas",
    title: ["It sees what ", "you", " see."],
    body: "Desyn reads the whole page: structure, hierarchy, type sizes, spacing, alignment and what each element is for. It notices low contrast, cramped margins and orphaned lines, and offers to fix them.",
    points: [
      "Knows a headline from a caption",
      "Finds alignment and spacing problems",
      "Works on your selection or the whole page",
    ],
    href: "/features/ai",
  },
  {
    id: "assets",
    index: "04",
    label: "Assets",
    title: ["Images that ", "fit", " the layout."],
    body: "Generate photos, illustrations and SVG artwork. Remove backgrounds, extend a photo past its edges, fix a detail, upscale for print or place a design in a mockup, all without leaving the canvas.",
    points: [
      "Image and SVG generation",
      "Background removal, inpaint, outpaint, upscale",
      "Stock photos with attribution, icons and fonts built in",
    ],
    href: "/features/ai",
  },
  {
    id: "brand",
    index: "05",
    label: "Brand memory",
    title: ["It remembers ", "your", " brand."],
    body: "Save your logo, colours, fonts and tone of voice once. Every design after that starts on brand, and “make this match my brand” restyles anything in one step.",
    points: [
      "Brand kits with logos, palettes, type and voice",
      "Applies brand rules to new and existing designs",
      "Several kits for several clients",
    ],
    href: "/features/brand",
  },
  {
    id: "workflows",
    index: "06",
    label: "Workflows",
    title: ["One design, ", "every", " size."],
    body: "Turn one design into a whole campaign: resize it for every platform with smart reflow, translate it into other languages, make A/B variants or fill it from a spreadsheet.",
    points: [
      "Campaigns, variants and magic resize",
      "Localisation with right-to-left support",
      "Bulk create from CSV, export in bundles",
    ],
    href: "/features/workflows",
  },
];
