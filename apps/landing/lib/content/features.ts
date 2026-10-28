import { planConfig } from "../plans";
import type { VignetteId } from "./capabilities";

export type FeatureSlug =
  | "ai"
  | "templates"
  | "brand"
  | "workflows"
  | "collaboration"
  | "self-hosting";
export type FeatureVisual = VignetteId | "collab" | "selfhost" | "gallery";

export interface FeatureSection {
  title: string;
  body: string;
  points?: string[];
  visual?: FeatureVisual;
}

export interface FeaturePage {
  slug: FeatureSlug;
  nav: string;
  summary: string;
  eyebrow: string;
  title: [string, string, string?];
  intro: string;
  visual: FeatureVisual;
  sections: FeatureSection[];
  /** Which plans include it, stated plainly. */
  availability: string;
}

const { free, pro } = planConfig.plans;
const cost = planConfig.creditCosts;

export const FEATURES: FeaturePage[] = [
  {
    slug: "ai",
    nav: "AI that edits layers",
    summary:
      "Generate whole designs, edit them by talking, and let the AI read the canvas like a designer.",
    eyebrow: "AI",
    title: ["An AI that works in ", "layers.", ""],
    intro:
      "Most AI design tools hand you a picture. Desyn's agent builds and edits the design itself: text you can retype, shapes you can move, images you can swap. It plans, builds, looks at what it made, and fixes what is off.",
    visual: "generate",
    availability: `Included with Pro (${pro.limits.creditsPerMonth} credits a month) and every self-hosted install. Not part of the Free plan.`,
    sections: [
      {
        title: "Generate complete designs",
        body: `Describe what you need. The agent chooses a size, writes the copy, picks a palette and type pairing, generates images in parallel and assembles everything as layers. Then it renders a preview, critiques it and fixes what it finds. A full design costs ${cost["ai.generateDesign"]} credits.`,
        points: [
          "Posters, social posts, stories, decks, menus, résumés, invitations and more",
          "Starts from a matching template when there is one",
          "Every element named and given a role",
        ],
        visual: "generate",
      },
      {
        title: "Edit by talking",
        body: `Ask for a change in your own words. The agent touches only the layers it needs to, and the whole change is a single undo step. Each turn costs ${cost["agent.turn"]} credit.`,
        points: [
          "“Make it more premium”, “move the product right”, “warmer”",
          "Works on your selection or the whole page",
          "Collaborators see AI edits live, like anyone else’s",
        ],
        visual: "talk",
      },
      {
        title: "Understands the canvas",
        body: "Before it edits, the agent reads a structured description of the page: hierarchy, type sizes, spacing rhythm, alignment, colour use and what each element is for. It also runs a design lint for low contrast, tiny text, overflow and uneven spacing, and can fix what it finds.",
        visual: "understand",
      },
      {
        title: "Assets in place",
        body: `Generate images (${cost["ai.image"]} credits) and SVG illustrations (${cost["ai.svg"]} credit), remove backgrounds, inpaint and outpaint, upscale for print and place designs in mockups, without leaving the canvas.`,
        points: [
          "Stock photos with attribution",
          "Icons from Lucide, Phosphor and Tabler",
          "The full Google Fonts library",
        ],
        visual: "assets",
      },
      {
        title: "Your models, your keys",
        body: "Choose a provider and model for each task. Use our hosted models, your own keys for Anthropic, OpenAI, Google, Mistral, Groq, Replicate or Fal, or a local model through Ollama, LM Studio or any OpenAI-compatible server. Requests with your own keys do not use credits.",
      },
      {
        title: "Agents outside the app",
        body: "The same tools the built-in agent uses are available through a REST API and an MCP server, so your own agents can create and edit Desyn designs too.",
      },
    ],
  },
  {
    slug: "templates",
    nav: "Templates",
    summary: "Hundreds of real, layered templates you can search by describing what you need.",
    eyebrow: "Templates",
    title: ["Templates worth ", "starting", " from."],
    intro:
      "Every Desyn template is a real design made of layers with named slots, never a flat image. Search by describing what you need, then change it by hand or ask the AI to remix it.",
    visual: "gallery",
    availability:
      "Basic templates on every plan. Premium templates with Pro and on self-hosted installs.",
    sections: [
      {
        title: "Built to be edited",
        body: "Headlines, photos, logos and prices are marked as slots, so filling a template in, by hand or with AI, keeps the layout intact.",
        points: [
          "Social posts, stories, posters, flyers, thumbnails, banners and ads",
          "Presentations, documents, résumés, menus, invitations, certificates",
          "Business cards, book covers, newsletters, one-page websites",
        ],
        visual: "gallery",
      },
      {
        title: "Search by describing it",
        body: "Type “a poster for a pottery open studio” and get templates ranked by fit, not just by keyword.",
      },
      {
        title: "Remix with AI",
        body: "Start from a template and say what it is for. The agent rewrites the copy, swaps the imagery and adapts the palette, and the layout stays the one you picked.",
        visual: "talk",
      },
    ],
  },
  {
    slug: "brand",
    nav: "Brand memory",
    summary: "Save your logos, colours, fonts and voice once. Every design starts on brand.",
    eyebrow: "Brand memory",
    title: ["It remembers ", "your", " brand."],
    intro:
      "Teach Desyn your brand once: logos, colours, type, tone of voice and the rules you care about. New designs start on brand, and “make this match my brand” restyles anything in a single step.",
    visual: "brand",
    availability: `Pro includes ${pro.limits.brandKits} brand kits. Self-hosted installs have no limit. The Free plan does not include brand kits.`,
    sections: [
      {
        title: "Brand kits",
        body: "Logos in every variant, a palette with names, heading and body fonts, and your voice. Pull a starting point from an existing site or document and refine it.",
        visual: "brand",
      },
      {
        title: "“Make this match my brand”",
        body: "Point the agent at any design, even one made before you had a kit, and it maps colours, fonts, logos and copy onto your brand without wrecking the layout.",
        points: [
          "Keeps contrast accessible while recolouring",
          "Rewrites copy in your tone of voice",
          "One undo step if you change your mind",
        ],
      },
      {
        title: "Several brands, no mixing",
        body: "Agencies and freelancers can keep a kit per client, and each design remembers which brand it follows.",
      },
    ],
  },
  {
    slug: "workflows",
    nav: "Workflows",
    summary: "Campaigns, variants, magic resize, localisation and bulk creation from one design.",
    eyebrow: "Workflows",
    title: ["One design, ", "every", " size."],
    intro:
      "Most design work is the same design again: another size, another language, another version to test. Desyn's workflows do that part for you and keep every result editable.",
    visual: "workflows",
    availability: `Included with Pro and every self-hosted install. Credits per output: campaign design ${cost["workflow.campaignDesign"]}, resized variant ${cost["workflow.resizeVariant"]}, localised variant ${cost["workflow.localizeVariant"]}.`,
    sections: [
      {
        title: "Campaigns",
        body: "Write a brief once. Desyn proposes a concept, then produces the set of designs you need for it, consistent in type, colour and voice.",
        visual: "workflows",
      },
      {
        title: "Magic resize",
        body: "Turn a post into a story, a banner, a slide or a print flyer. Layout is reflowed for each format rather than stretched, and text is re-measured so nothing overflows.",
      },
      {
        title: "Localise",
        body: "Translate a design into other languages with length-aware relayout and right-to-left support, so German and Arabic versions look designed, not squeezed.",
      },
      {
        title: "Variants and bulk create",
        body: "Make A/B variants for testing, or fill a template from a spreadsheet to produce hundreds of personalised designs, then export them as one bundle.",
      },
    ],
  },
  {
    slug: "collaboration",
    nav: "Collaboration",
    summary: "Real-time editing, comments, share links and version history.",
    eyebrow: "Collaboration",
    title: ["Design ", "together,", " live."],
    intro:
      "Invite people into a design and work on it at the same time. Everyone sees cursors, selections and edits as they happen, including the AI’s.",
    visual: "collab",
    availability: `View-only share links on every plan. Live editing, comments, edit links and version history with Pro (up to ${pro.limits.collaboratorsPerDesign} collaborators per design, ${pro.limits.versionHistoryDays} days of history) and without limits when self-hosted.`,
    sections: [
      {
        title: "Real time, conflict free",
        body: "Changes sync as you make them. Two people can edit the same page without overwriting each other, and the AI’s edits arrive the same way.",
        visual: "collab",
      },
      {
        title: "Comments in place",
        body: "Pin a comment to a layer or a spot on the page, mention people and resolve threads when they are done.",
      },
      {
        title: "Roles and sharing",
        body: "Owners, admins, editors, commenters and viewers. Share a view link, an edit link or a password-protected link with an expiry date.",
        points: [
          `${free.name}: view-only links`,
          `${pro.name}: edit links, comments and live collaboration`,
        ],
      },
      {
        title: "Version history",
        body: "Every change is recorded. Name important versions, compare them and restore any earlier state in one click.",
      },
    ],
  },
  {
    slug: "self-hosting",
    nav: "Self-hosting",
    summary: "Every feature on your own servers, free for non-commercial use.",
    eyebrow: "Self-hosting",
    title: ["Every feature, on ", "your", " servers."],
    intro:
      "The self-hosted edition is the same software as desyn.app with everything unlocked: no plans, no credits, no limits. You run it on your own infrastructure with your own AI providers, and telemetry stays off unless you turn it on.",
    visual: "selfhost",
    availability:
      "Free for non-commercial use: personal projects, education, research and non-profit organisations. Commercial use needs a commercial licence.",
    sections: [
      {
        title: "What you run",
        body: "A Next.js web app, a Convex backend for data and realtime sync, a Rust render worker for exports and previews, S3-compatible object storage and an email sender (SMTP or Amazon SES). Docker images and a Compose setup come with the source.",
        visual: "selfhost",
      },
      {
        title: "Your AI, or none",
        body: "Bring keys for OpenRouter, Fal or any provider you like, or point Desyn at local models through Ollama, LM Studio or an OpenAI-compatible server. Everything else works without AI.",
      },
      {
        title: "Commercial use",
        body: "Running Desyn inside a company, or offering it to customers, is commercial use under the licence and needs a separate commercial licence. Write to us and we will find something fair.",
      },
    ],
  },
];

export function featureBySlug(slug: string): FeaturePage | undefined {
  return FEATURES.find((f) => f.slug === slug);
}
