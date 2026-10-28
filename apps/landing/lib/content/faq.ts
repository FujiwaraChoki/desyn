import { planConfig } from "../plans";

const pro = planConfig.plans.pro;
const free = planConfig.plans.free;

export interface FaqItem {
  q: string;
  a: string;
}

/** Answers are plain text so they can also feed FAQPage structured data. */
export const FAQ: FaqItem[] = [
  {
    q: "Is Desyn really free?",
    a: `The Free plan costs nothing and has no time limit. It includes the editor, ${free.limits.designs} designs, basic templates, Google Fonts and PNG, JPG and PDF export. It does not include AI features; those come with Pro or with a self-hosted install.`,
  },
  {
    q: "What do I get with Pro?",
    a: `Every feature, ${pro.limits.creditsPerMonth} AI credits a month, unlimited designs, ${Math.round((pro.limits.storageMb ?? 0) / 1024)} GB of storage, brand kits, live collaboration, version history and every export format. It is $${pro.priceMonthly} a month or $${pro.priceYearly} a year.`,
  },
  {
    q: "What happens when I run out of AI credits?",
    a: "AI requests slow down until your credits refresh at the start of the next month. You are never charged extra. If you add your own API keys, requests made with them do not use credits at all.",
  },
  {
    q: "Does the AI make pictures or real designs?",
    a: "Real designs. Everything it creates is made of editable layers: text you can retype, shapes you can move, images you can swap. When you ask for a change, it edits those layers and leaves the rest alone.",
  },
  {
    q: "Can I use my own AI models?",
    a: "Yes. Pro and self-hosted installs can use your own keys for providers such as Anthropic, OpenAI, Google, Mistral, Groq, Replicate and Fal, or local models through Ollama, LM Studio or any OpenAI-compatible server. You can pick a different model for each task.",
  },
  {
    q: "Is Desyn open source?",
    a: "It is source-available and free for non-commercial use. The full source is public under the Desyn Non-Commercial Source License: you can read it, modify it and self-host it with every feature for personal, educational and non-profit use. Commercial use needs a separate licence from us.",
  },
  {
    q: "Can my company self-host Desyn?",
    a: "Not under the free licence. Using Desyn inside a for-profit business, or hosting it for customers, is commercial use and needs a commercial licence. Write to us and we will find something fair.",
  },
  {
    q: "Who owns what I design?",
    a: "You do. Your designs, uploads and generated assets are yours. We only process them to run the service for you.",
  },
  {
    q: "Where is my data stored?",
    a: "The hosted service runs on our own servers at Hetzner, with files in S3-compatible object storage. Product analytics use PostHog's EU cloud and only set cookies if you allow them. Self-hosted installs keep everything on your own infrastructure.",
  },
  {
    q: "Which platforms does Desyn run on?",
    a: "The web app runs in any modern browser. Native apps for macOS, Windows and Linux and for iPhone and iPad are in development; the download page shows where each one stands.",
  },
];
