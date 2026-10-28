export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  summary: string;
  items: string[];
}

/** Newest first. Only things that exist go here. */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "Preview",
    date: "October 2026",
    title: "Building in the open",
    summary:
      "Desyn is in private preview while we finish the first release. This page will list every release from here on, with what changed and why.",
    items: [
      "The document model that every Desyn app shares is frozen: designs are real layers with names, roles and properties.",
      "The editor, the AI agent, templates, brand kits, workflows and the web, desktop and iOS apps are being built on that model in parallel.",
      "The source is available under the Desyn Non-Commercial Source License, and self-hosting is free for non-commercial use.",
    ],
  },
];
