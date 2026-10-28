# Desyn

**The source-available Canva alternative, built around AI.**

Describe what you need and Desyn builds it as real, editable layers: text you can retype, shapes you can move, images you can swap. Keep talking and every change lands on the canvas, not in a new picture. Run it on desyn.app or on your own server.

[desyn.app](https://desyn.app) · [Self-hosting guide](deploy/SELFHOST.md) · [Spec](docs/SPEC.md) · [Licence](LICENSE)

> **Source-available, free for non-commercial use.** You can read, modify and self-host every feature for personal, educational and non-profit use. Commercial use needs a licence: see [`COMMERCIAL.md`](COMMERCIAL.md).

## Why Desyn instead of Canva

| | Desyn | Canva |
|---|---|---|
| Source code you can read and change | Yes | No |
| Self-host on your own server | Yes, every feature | No |
| Bring your own AI keys | Yes: Anthropic, OpenAI, Google, Mistral, Groq, Replicate, Fal and more | No |
| Run AI on local models | Yes: Ollama, LM Studio or any OpenAI-compatible server | No |
| Pick a different model for each task | Yes | No |

Desyn Pro is $8 a month or $80 a year, with every feature and 600 AI credits a month. The Free plan has no time limit. See [Pricing](#pricing).

## What you can make

Social posts, stories, posters, flyers, thumbnails, banners, ads, presentations, infographics, business cards, resumes, invitations, menus, logos, newsletters, documents, whiteboards, one-page websites, videos, book covers and certificates. Start from a template or from a sentence.

## The editor

- **A full design canvas.** Pages and frames, rich and curved text, shapes, a vector pen, boolean operations, auto-layout, masks, gradients, effects, blend modes and image adjustments.
- **Content blocks.** Charts, tables, QR codes, icons, stickers, stock photos, video and animation, with presenter mode for slides.
- **Precision.** Rulers, guides, snapping, alignment, distribution and a grid. Every action has a shortcut, and everything is in the command palette (⌘K).
- **Work together.** Real-time collaboration, comments and version history.
- **Templates.** Hundreds of templates across every design kind, stored as real layers, searchable by describing what you want, and remixable with AI.
- **Assets.** Google Fonts and your own fonts, icon sets, stock photos from Unsplash and Pexels, illustrations, mockup scenes and your uploads.
- **Export.** PNG, JPG, PDF, PPTX and MP4.

## AI that works on layers

- **Generate whole designs** as editable layers, not flat images.
- **Edit by talking.** Ask for a change and Desyn edits only the layers it needs to, leaving the rest alone.
- **It reads the canvas.** Structure, typography, spacing, hierarchy and your current selection.
- **Make and change assets.** Image generation, SVG generation, background removal, inpaint, outpaint, upscale, mockups and tracing.
- **Brand kits.** Save your colours, fonts and logos, then ask Desyn to make any design match them.
- **Multi-step work.** Campaigns, variants, resizing, translation and bulk export in one request.
- **Agent API.** A public REST API and an MCP server let your own agents work on your projects with the same tools.

## Platforms

| Platform | Status |
|---|---|
| Web | Available at [desyn.app](https://desyn.app) |
| macOS, Windows, Linux (Rust, GPUI) | In development |
| iPhone and iPad (SwiftUI) | In development |

## Pricing

| Plan | Price | What you get |
|---|---|---|
| Free | $0 | The editor, 20 designs, basic templates, Google Fonts, and PNG, JPG and PDF export. No AI. |
| Pro | $8 a month or $80 a year | Every feature, 600 AI credits a month, unlimited designs, 100 GB of storage, brand kits, live collaboration, version history and every export format. Your own API keys do not use credits. |
| Self-hosted | Free, for non-commercial use | Every feature with no limits, on your own hardware. No telemetry. |

When you run out of AI credits, requests slow down until the next month. You are never charged extra.

## Self-host it

```sh
cp deploy/compose/.env.example deploy/compose/.env
cp deploy/compose/convex.selfhost.env.example deploy/compose/convex.env
docker compose -f deploy/compose/desyn.selfhost.yml up -d --build
```

Fill in the secrets first. The full steps, including the Convex admin key and storage setup, are in [`deploy/SELFHOST.md`](deploy/SELFHOST.md). Add the `ollama` profile to run AI on local models.

## Repository map

```
desyn/
├─ apps/
│  ├─ web/        The editor, dashboard and settings (Next.js)
│  ├─ desktop/    Desktop app (Rust, GPUI)
│  ├─ ios/        iPhone and iPad app (SwiftUI)
│  ├─ landing/    Marketing site (Next.js)
│  └─ docs/       Documentation site
├─ convex/        Backend schema and functions
├─ crates/        Rust engine, render worker and shared core
├─ packages/      Shared TypeScript: schema, AI, UI
├─ templates/     Template pipeline
├─ config/        plans.json, the single source of plan limits
├─ deploy/        Docker, Compose, nginx, systemd, runbooks
└─ docs/          Spec, document model, design system
```

Start with [`docs/SPEC.md`](docs/SPEC.md), then [`docs/DOCUMENT_MODEL.md`](docs/DOCUMENT_MODEL.md) and [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md).

## Licence

Desyn is source-available, free for non-commercial use, under the Desyn Non-Commercial Source License ([`LICENSE`](LICENSE)).

| You may | You may not, without a commercial licence |
|---|---|
| Read, run and modify the source | Use it inside a for-profit business |
| Self-host every feature for personal, educational and non-profit use | Host it as a service for others |
| Contribute improvements back | Sell it, resell it or bundle it with a paid product |

Commercial licensing: [`COMMERCIAL.md`](COMMERCIAL.md). Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md).

Canva is a trademark of Canva Pty Ltd. Desyn is not affiliated with or endorsed by Canva.
