// The imagery catalog: every photo a template uses is generated for this library (no stock, no people who exist),
// with its prompt kept as provenance in templates/assets/manifest.json. `npm run imagery` generates what is missing.

export interface ImagerySpec {
  key: string;
  /** what the photo shows (becomes the image's alt text) */
  alt: string;
  prompt: string;
  ratio: "3:2" | "4:5" | "1:1" | "16:9" | "2:3";
}

const STYLE =
  "Editorial photograph, natural light, shallow depth of field, rich but true-to-life color, professional color grading, no text, no logos, no watermarks.";

const p = (key: string, ratio: ImagerySpec["ratio"], alt: string, scene: string): ImagerySpec => ({
  key,
  alt,
  ratio,
  prompt: `${scene} ${STYLE}`,
});

export const IMAGERY: readonly ImagerySpec[] = [
  p(
    "coffee-pour",
    "4:5",
    "Barista pouring latte art into a ceramic cup",
    "Close-up of a barista's hands pouring a rosetta of latte art into a speckled ceramic cup on a walnut counter, morning sun from a window, steam rising.",
  ),
  p(
    "coffee-shop",
    "3:2",
    "Warm, sunlit neighborhood coffee shop interior",
    "Interior of a small neighborhood coffee shop with exposed brick, wooden counter, glass jars of coffee beans and hanging plants, warm late-morning light, empty and inviting.",
  ),
  p(
    "bakery-bread",
    "3:2",
    "Rustic sourdough loaves on a wooden board",
    "Several rustic sourdough loaves with deep caramel crusts and flour dusting on a linen-covered wooden board, a bread knife beside them, soft side light.",
  ),
  p(
    "bakery-pastries",
    "4:5",
    "Croissants and pastries on a marble counter",
    "Golden butter croissants, pain au chocolat and cardamom buns arranged on a pale marble counter in a bakery, crumbs and parchment paper, soft daylight.",
  ),
  p(
    "restaurant-dish",
    "4:5",
    "Plate of fresh tagliatelle with ragù",
    "Overhead view of a plate of handmade tagliatelle with slow-cooked ragù and shaved parmigiano on a dark ceramic plate, linen napkin, glass of red wine, candlelit restaurant table.",
  ),
  p(
    "restaurant-table",
    "3:2",
    "Candlelit restaurant dining room",
    "Intimate Italian restaurant dining room at night, candlelit tables with white linen, a glowing wood-fired oven in the background, warm amber light, no people in focus.",
  ),
  p(
    "fitness-training",
    "4:5",
    "Athlete training with a kettlebell in a gym",
    "Athletic woman mid-swing with a kettlebell in a modern gym with concrete floors and large windows, dramatic side light, sweat and motion, focused expression.",
  ),
  p(
    "fitness-runner",
    "3:2",
    "Runner on an early-morning city trail",
    "Runner in motion on a lakeside city trail at sunrise, low angle, golden backlight, city skyline softly blurred in the distance.",
  ),
  p(
    "yoga-pose",
    "4:5",
    "Woman in a calm yoga pose in a sunlit studio",
    "Woman in a serene warrior pose on a cork mat in a minimal sunlit yoga studio with plants and pale wooden floors, soft morning light, peaceful mood.",
  ),
  p(
    "wellness-spa",
    "3:2",
    "Spa still life with stones, towels and eucalyptus",
    "Calm spa still life: rolled linen towels, smooth river stones, a sprig of eucalyptus and a ceramic bowl of water on a stone surface, diffused light, sage and sand tones.",
  ),
  p(
    "realestate-house",
    "3:2",
    "Modern family house exterior at dusk",
    "Architectural photo of a modern family house with large windows glowing at dusk, landscaped garden and lawn, warm interior light, clear blue twilight sky.",
  ),
  p(
    "realestate-interior",
    "4:5",
    "Bright living room with original moldings",
    "Bright, styled living room in a restored brownstone with tall windows, crown moldings, a linen sofa, oak floors and plants, afternoon sun.",
  ),
  p(
    "tech-workspace",
    "3:2",
    "Modern workspace with laptop and charts",
    "Clean modern desk with a laptop showing abstract colorful charts, a notebook, coffee and a plant, in a bright office with soft blue morning light, shallow depth of field.",
  ),
  p(
    "tech-abstract",
    "1:1",
    "Abstract glowing data visualization",
    "Abstract 3D render of flowing translucent ribbons and glowing particles forming a data landscape, deep navy background with electric blue and teal light, elegant and minimal.",
  ),
  p(
    "podcast-studio",
    "3:2",
    "Podcast studio with microphones",
    "Cozy podcast studio with two broadcast microphones on boom arms, headphones, acoustic panels and warm lamp light, empty chairs, inviting atmosphere.",
  ),
  p(
    "podcast-host",
    "4:5",
    "Podcast host speaking into a microphone",
    "Portrait of a smiling podcast host in their thirties speaking into a broadcast microphone, wearing headphones, warm studio light and a softly blurred bookshelf behind.",
  ),
  p(
    "wedding-florals",
    "4:5",
    "Garden wedding flower arrangement",
    "Lush wedding floral arrangement of garden roses, peonies, ranunculus and trailing greenery in soft blush and ivory tones, on a rustic table at a vineyard, golden hour.",
  ),
  p(
    "wedding-couple",
    "3:2",
    "Couple walking through a vineyard at golden hour",
    "Wedding couple seen from behind walking hand in hand between vineyard rows at golden hour, flowing dress, warm hazy light, romantic and candid.",
  ),
  p(
    "party-balloons",
    "4:5",
    "Colorful balloons and streamers",
    "Bunch of glossy pastel and bright balloons with curling ribbons and confetti against a soft pink wall, playful birthday party mood, bright even light.",
  ),
  p(
    "party-cake",
    "1:1",
    "Birthday cake with sprinkles and candles",
    "Colorful layered birthday cake with rainbow sprinkles and lit candles on a cake stand, confetti on the table, cheerful bright light.",
  ),
  p(
    "festival-crowd",
    "3:2",
    "Festival crowd at sunset with hands raised",
    "Silhouettes of a happy festival crowd with raised hands in front of an outdoor stage at sunset, golden haze, stage lights and confetti in the air.",
  ),
  p(
    "concert-stage",
    "4:5",
    "Concert stage with dramatic lights",
    "Outdoor concert stage at night with dramatic orange and magenta beams of light cutting through haze, guitarist silhouetted, energetic mood.",
  ),
  p(
    "skincare-bottles",
    "4:5",
    "Glass skincare bottles on a stone plinth",
    "Minimal product still life of amber and frosted glass skincare dropper bottles and a cream jar on travertine stone blocks, soft shadows, blush and sand tones, unbranded.",
  ),
  p(
    "skincare-model",
    "4:5",
    "Woman with glowing skin applying serum",
    "Close beauty portrait of a woman with glowing, natural skin gently applying facial serum, soft diffused light, minimal makeup, neutral background.",
  ),
  p(
    "fashion-model",
    "2:3",
    "Model in a camel wool coat on a city street",
    "Fashion editorial: model in an oversized camel wool coat and knit sweater walking on a Paris street, autumn light, film-like tones, confident stride.",
  ),
  p(
    "fashion-rack",
    "3:2",
    "Boutique clothing rack in earthy tones",
    "Minimal boutique interior with a clothing rack of wool coats and knitwear in earthy tones, wooden hangers, white walls and a single plant, soft daylight.",
  ),
  p(
    "travel-coast",
    "3:2",
    "Colorful cliffside village above the sea",
    "Colorful cliffside village above a turquoise Mediterranean sea with small boats, lemon trees in the foreground, bright summer light.",
  ),
  p(
    "travel-mountains",
    "4:5",
    "Hiker overlooking a mountain lake",
    "Hiker with a backpack standing on a rocky ridge overlooking a turquoise mountain lake and jagged peaks, dramatic clouds, epic scale.",
  ),
  p(
    "volunteers",
    "3:2",
    "Volunteers packing food boxes together",
    "Diverse group of smiling volunteers packing boxes of fresh produce in a bright community food bank warehouse, candid, warm and hopeful.",
  ),
  p(
    "community-garden",
    "4:5",
    "Hands holding freshly harvested vegetables",
    "Close-up of hands holding a crate of freshly harvested vegetables in a community garden, carrots, greens and tomatoes, morning light.",
  ),
  p(
    "study-desk",
    "3:2",
    "Student studying with a laptop and notes",
    "Young adult studying at a sunny desk with a laptop, open notebook with sketches of app wireframes and a cup of tea, focused and calm, shallow depth of field.",
  ),
  p(
    "classroom",
    "3:2",
    "Modern workshop classroom with learners",
    "Modern bright workshop space with adult learners collaborating around a table with laptops and sticky notes, candid, natural window light.",
  ),
  p(
    "photo-portrait",
    "4:5",
    "Natural light portrait of a woman",
    "Natural-light studio portrait of a woman with freckles and loose curls looking softly at the camera, linen backdrop, warm tones, film-like grain.",
  ),
  p(
    "photo-landscape",
    "3:2",
    "Misty forest at sunrise",
    "Misty evergreen forest at sunrise with sunbeams cutting through the trees, quiet and atmospheric, muted greens and golds.",
  ),
  p(
    "office-meeting",
    "3:2",
    "Professionals in a calm meeting room",
    "Professionals in a calm, modern meeting room with glass walls, reviewing documents together, natural light, understated and trustworthy.",
  ),
  p(
    "office-building",
    "4:5",
    "Modern office building facade",
    "Looking up at a modern office building facade of glass and stone against a clear blue sky, clean geometric lines.",
  ),
  p(
    "dental-clinic",
    "3:2",
    "Bright, modern dental clinic",
    "Bright, modern, welcoming dental clinic treatment room with a white dental chair, soft teal accents and natural light, spotless and calm.",
  ),
  p(
    "smile-portrait",
    "4:5",
    "Smiling person with a bright smile",
    "Portrait of a cheerful middle-aged man with a bright natural smile outdoors, soft background, fresh and friendly.",
  ),
  p(
    "gaming-setup",
    "3:2",
    "Gaming setup with neon lighting",
    "Gaming desk setup with a curved monitor, mechanical keyboard and headset, neon purple and cyan ambient lighting, dark room, no on-screen text.",
  ),
  p(
    "neon-city",
    "16:9",
    "Neon-lit city street at night",
    "Futuristic neon-lit city street at night in the rain, reflections on wet asphalt, magenta and cyan signs without readable text, cinematic.",
  ),
  p(
    "flowers-bouquet",
    "4:5",
    "Loose seasonal bouquet wrapped in paper",
    "Loose, garden-style bouquet of seasonal flowers (peonies, cosmos, ranunculus, grasses) wrapped in kraft paper, held against a soft plaster wall.",
  ),
  p(
    "flower-shop",
    "3:2",
    "Florist shop full of buckets of flowers",
    "Charming florist shop front with zinc buckets of fresh flowers on the sidewalk, morning light, rustic wooden shelves.",
  ),
  p(
    "conference-stage",
    "3:2",
    "Speaker on a conference stage",
    "Speaker on a modern conference stage with a large warm-gradient screen behind them, audience silhouettes in the foreground, stage lighting.",
  ),
  p(
    "conference-crowd",
    "3:2",
    "Attendees networking at a tech conference",
    "Attendees networking in a bright conference hall with coffee, lanyards and laptops, candid smiles, airy venue with large windows.",
  ),
  p(
    "dog-portrait",
    "4:5",
    "Happy freshly groomed dog",
    "Studio portrait of a happy, freshly groomed golden doodle with a bandana, tongue out, against a soft yellow backdrop, crisp and joyful.",
  ),
  p(
    "cat-portrait",
    "1:1",
    "Fluffy cat portrait",
    "Portrait of a fluffy grey cat with green eyes sitting regally against a soft teal backdrop, crisp studio light.",
  ),
  p(
    "architecture-facade",
    "4:5",
    "Minimal timber house by a fjord",
    "Minimal Scandinavian timber house with large glass walls on the edge of a calm fjord, overcast soft light, quiet and serene.",
  ),
  p(
    "interior-minimal",
    "3:2",
    "Minimal Scandinavian interior",
    "Minimal Scandinavian interior with oak furniture, a linen sofa, a large window framing trees, soft diffused daylight, calm neutral palette.",
  ),
  p(
    "portrait-woman",
    "4:5",
    "Professional portrait of a woman",
    "Professional headshot of a confident woman in her thirties with short dark hair, wearing a simple black top, soft studio light, neutral warm grey backdrop.",
  ),
  p(
    "portrait-man",
    "4:5",
    "Professional portrait of a man",
    "Professional headshot of a friendly man in his late twenties with glasses and a denim shirt, soft daylight, blurred office background.",
  ),
  p(
    "portrait-woman-2",
    "4:5",
    "Portrait of a smiling woman",
    "Portrait of a smiling woman in her forties with long grey-streaked hair, wearing a camel blazer, outdoor soft light, green bokeh.",
  ),
  p(
    "portrait-man-2",
    "4:5",
    "Portrait of a man outdoors",
    "Portrait of a man in his fifties with a trimmed beard and navy sweater, smiling warmly, soft window light, simple backdrop.",
  ),
  p(
    "abstract-warm",
    "1:1",
    "Abstract warm gradient with soft shapes",
    "Abstract soft-focus image of overlapping translucent amber, coral and gold glass shapes with gentle light refraction, minimal and warm.",
  ),
  p(
    "abstract-cool",
    "1:1",
    "Abstract cool gradient with soft shapes",
    "Abstract soft-focus image of overlapping translucent blue, teal and lilac glass shapes with gentle light refraction, minimal and calm.",
  ),
];

export function imagery(key: string): ImagerySpec {
  const s = IMAGERY.find((x) => x.key === key);
  if (!s) throw new Error(`unknown imagery key ${key}`);
  return s;
}
