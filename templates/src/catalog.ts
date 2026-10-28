// The library plan: which archetype is built for which niche, palette, type pairing and page size. Everything is
// derived deterministically from the slug, so the catalog is stable across runs and machines.
import { DESIGN_KIND_INFO, getPreset } from "@desyn/schema";
import type { Archetype, Ctx } from "./archetypes/common";
import { NICHES, type Niche } from "./copy/niches";
import type { Doc } from "./lib/doc";
import { palette } from "./lib/palettes";
import { hash32, rng } from "./lib/rand";
import { pickPair } from "./lib/type";

export interface TemplateSpec {
  slug: string;
  title: string;
  description: string;
  kind: Ctx["kind"];
  preset: string;
  category: string;
  categories: string[];
  tags: string[];
  premium: boolean;
  collections: string[];
  niche: string;
  archetype: string;
  palette: string;
  pair: string;
  build: () => Doc;
}

export interface PlanRow {
  archetypes: Archetype[];
  /** how many templates to make from this group */
  count: number;
  /** restrict to these niches */
  niches?: string[];
}

const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (m) => m.toUpperCase());
}

export function planCatalog(rows: PlanRow[]): TemplateSpec[] {
  const out: TemplateSpec[] = [];
  const used = new Set<string>();
  for (const row of rows) {
    const niches = (row.niches ? NICHES.filter((n) => row.niches?.includes(n.id)) : NICHES).slice();
    let made = 0;
    let i = 0;
    let guard = 0;
    while (made < row.count && guard < row.count * 40) {
      guard++;
      // Cycle through every niche; each full pass shifts which archetype a niche gets, so a row covers all
      // subjects before repeating one and neighbors differ in both subject and layout.
      const pass = Math.floor(i / niches.length);
      const niche = niches[i % niches.length] as Niche;
      const arch = row.archetypes[(i + pass) % row.archetypes.length] as Archetype;
      const presetId = arch.presets[(i + pass) % arch.presets.length] as string;
      i++;
      if (arch.fits && !arch.fits(niche)) continue;
      const preset = getPreset(presetId);
      if (!preset) throw new Error(`unknown preset ${presetId}`);
      const base = `${niche.id}-${arch.id}`;
      let slug = kebab(
        `${base}-${preset.id.replace(/^(instagram|facebook|linkedin|threads|x)-/, "")}`,
      );
      if (used.has(slug)) {
        let k = 2;
        while (used.has(`${slug}-${k}`)) k++;
        slug = `${slug}-${k}`;
      }
      used.add(slug);
      const seed = rng(slug);
      const v = hash32(slug) % 97;
      const candidates = niche.palettes
        .map(palette)
        .filter((p) => !arch.wants || arch.wants === "any" || (arch.wants === "dark") === p.dark);
      const pal =
        candidates[v % Math.max(1, candidates.length)] ?? palette(niche.palettes[0] as string);
      const pair = pickPair(seed, niche.moods, (t) =>
        arch.typeFilter
          ? arch.typeFilter(t)
          : !t.script || niche.moods.includes("wedding") || niche.moods.includes("kids"),
      );
      const kindLabel = DESIGN_KIND_INFO[arch.kind].label;
      const title = titleCase(`${pal.name} ${niche.name} ${preset.label}`).replace(
        /\bAnd\b/g,
        "and",
      );
      const ctx: Ctx = {
        slug,
        title,
        kind: arch.kind,
        preset: preset.id,
        niche,
        palette: pal,
        type: pair,
        r: seed,
        v,
      };
      out.push({
        slug,
        title,
        description: `${arch.label} ${kindLabel.toLowerCase()} for a ${niche.name.toLowerCase()}, set in ${pair.heading} and ${pair.body} on the ${pal.name} palette.`,
        kind: arch.kind,
        preset: preset.id,
        category: niche.category,
        categories: [niche.category, kindLabel],
        tags: [
          ...new Set([
            niche.id,
            kebab(niche.name),
            arch.id,
            pal.id,
            kebab(pair.heading),
            ...niche.moods,
            ...pal.mood,
            kebab(kindLabel),
            kebab(preset.label),
          ]),
        ],
        premium: hash32(`premium:${slug}`) % 10 < 4,
        collections: [kebab(kindLabel), kebab(niche.category)],
        niche: niche.id,
        archetype: arch.id,
        palette: pal.id,
        pair: pair.id,
        build: () => arch.build(ctx),
      });
      made++;
    }
    if (made < row.count)
      throw new Error(
        `plan row ${row.archetypes.map((a) => a.id).join(",")} made ${made}/${row.count}`,
      );
  }
  return out;
}
