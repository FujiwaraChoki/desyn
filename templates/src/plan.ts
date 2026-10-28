// How many templates of each kind the library ships, and from which archetypes (319 in total).
import { DECKS, INFOGRAPHICS, WHITEBOARDS } from "./archetypes/deck";
import {
  BOOK_COVERS,
  BUSINESS_CARDS,
  CERTIFICATES,
  DOCUMENTS,
  FLYERS,
  INVITATIONS,
  MENUS,
  NEWSLETTERS,
  POSTERS,
  RESUMES,
} from "./archetypes/print";
import { SOCIAL, STORIES } from "./archetypes/social";
import { ADS, BANNERS, EMAIL, LOGOS, THUMBNAILS } from "./archetypes/web";
import { planCatalog, type TemplateSpec } from "./catalog";

export function PLAN(): TemplateSpec[] {
  return planCatalog([
    { archetypes: SOCIAL, count: 77 },
    { archetypes: STORIES, count: 30 },
    { archetypes: THUMBNAILS, count: 20 },
    { archetypes: DECKS, count: 14 },
    { archetypes: POSTERS, count: 20 },
    { archetypes: FLYERS, count: 18 },
    {
      archetypes: RESUMES,
      count: 10,
      niches: [
        "personal",
        "tech",
        "education",
        "architecture",
        "photography",
        "law",
        "fitness",
        "saas-conference",
        "realestate",
        "skincare",
      ],
    },
    { archetypes: BUSINESS_CARDS, count: 14 },
    { archetypes: INVITATIONS, count: 12 },
    { archetypes: MENUS, count: 9 },
    {
      archetypes: CERTIFICATES,
      count: 8,
      niches: [
        "education",
        "nonprofit",
        "fitness",
        "yoga",
        "saas-conference",
        "law",
        "tech",
        "photography",
      ],
    },
    { archetypes: LOGOS, count: 14 },
    { archetypes: EMAIL, count: 8 },
    { archetypes: NEWSLETTERS, count: 6 },
    { archetypes: INFOGRAPHICS, count: 8 },
    { archetypes: DOCUMENTS, count: 8 },
    { archetypes: BANNERS, count: 16 },
    { archetypes: ADS, count: 16 },
    { archetypes: BOOK_COVERS, count: 9 },
    { archetypes: WHITEBOARDS, count: 2, niches: ["tech", "saas-conference", "education"] },
  ]);
}
