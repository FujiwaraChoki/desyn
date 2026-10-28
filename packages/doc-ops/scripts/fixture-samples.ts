// Node / paint / effect samples (spec/fixtures/nodes) and canonical JSON pairs (spec/fixtures/canonical).
import {
  createAudio,
  createBoolean,
  createChart,
  createEllipse,
  createFrame,
  createGroup,
  createImage,
  createLine,
  createPage,
  createPath,
  createPolygon,
  createQr,
  createRect,
  createRoot,
  createStar,
  createSvg,
  createTable,
  createText,
  createVideo,
  defaultImageAdjust,
  defaultParagraph,
  defaultStroke,
  defaultTextStyle,
  type Node,
} from "@desyn/schema";
import { ASSET, baseDesign } from "./fixture-base";

export interface Sample {
  name: string;
  /** Exported zod schema name in @desyn/schema (without the "Schema" suffix), e.g. "RectNode". */
  schema: string;
  valid: boolean;
  description: string;
  value: unknown;
}

const P = "page00000001";
const id = (n: number) => `node${String(n).padStart(8, "0")}`;
const common = { parent: P, x: 100, y: 120, rotation: 0 };

const nodes: [string, string, Node][] = [
  ["root", "RootNode", createRoot({ children: [P] })],
  [
    "page",
    "PageNode",
    createPage({
      id: P,
      name: "Slide 1",
      width: 1920,
      height: 1080,
      children: [id(1)],
      background: [{ type: "solid", color: "#0a0a0a" }],
      durationMs: 6000,
      transition: { kind: "fade", durationMs: 400 },
      grid: { columns: 12, gutter: 24, margin: 96, baseline: 8 },
      guides: [
        { axis: "x", pos: 960 },
        { axis: "y", pos: 540 },
      ],
      notes: "Open with the question.",
    }),
  ],
  [
    "frame",
    "FrameNode",
    createFrame({
      id: id(2),
      ...common,
      name: "Card",
      width: 360,
      height: 480,
      children: [id(3)],
      clip: true,
      cornerRadius: [24, 24, 8, 8],
      cornerSmoothing: 0.6,
      layout: {
        mode: "column",
        gap: 16,
        padding: [24, 24, 24, 24],
        mainAlign: "start",
        crossAlign: "stretch",
      },
      effects: [{ type: "dropShadow", x: 0, y: 20, blur: 60, spread: -40, color: "#ffb02e66" }],
      sizing: { h: "fixed", v: "hug" },
      role: "product-card",
    }),
  ],
  [
    "group",
    "GroupNode",
    createGroup({
      id: id(4),
      ...common,
      name: "Logo lockup",
      width: 240,
      height: 64,
      children: [id(5), id(6)],
    }),
  ],
  [
    "boolean",
    "BooleanNode",
    createBoolean({
      id: id(7),
      ...common,
      name: "Crescent",
      op: "subtract",
      width: 120,
      height: 120,
      children: [id(8), id(9)],
    }),
  ],
  [
    "rect",
    "RectNode",
    createRect({
      id: id(10),
      ...common,
      name: "Button",
      width: 200,
      height: 56,
      cornerRadius: 999,
      fills: [{ type: "solid", color: "#ffb02e" }],
      strokes: [
        defaultStroke({
          width: 1,
          align: "inside",
          fills: [{ type: "solid", color: "#ffffff33" }],
        }),
      ],
      constraints: { h: "center", v: "bottom" },
      link: "https://desyn.app",
      role: "button",
      meta: { slot: "cta" },
    }),
  ],
  [
    "ellipse",
    "EllipseNode",
    createEllipse({
      id: id(11),
      ...common,
      name: "Ring",
      width: 200,
      height: 200,
      arc: { start: -90, end: 180, inner: 0.8 },
    }),
  ],
  [
    "polygon",
    "PolygonNode",
    createPolygon({ id: id(12), ...common, name: "Hexagon", sides: 6, rotation: 30 }),
  ],
  [
    "star",
    "StarNode",
    createStar({ id: id(13), ...common, name: "Burst", points: 12, innerRatio: 0.7, flipX: true }),
  ],
  [
    "line",
    "LineNode",
    createLine({
      id: id(14),
      ...common,
      name: "Arrow",
      width: 320,
      height: 0,
      rotation: 45,
      startCap: "circle",
      endCap: "arrow",
      strokes: [
        defaultStroke({
          width: 3,
          cap: "round",
          dash: [8, 6],
          fills: [{ type: "solid", color: "#ededed" }],
        }),
      ],
    }),
  ],
  [
    "path",
    "PathNode",
    createPath({
      id: id(15),
      ...common,
      name: "Wave",
      width: 400,
      height: 100,
      paths: [
        { d: "M0 50C100 0 100 100 200 50S300 0 400 50L400 100L0 100Z", fillRule: "nonzero" },
        { d: "M10 10h20v20h-20z", fillRule: "evenodd" },
      ],
    }),
  ],
  [
    "text",
    "TextNode",
    createText({
      id: id(16),
      ...common,
      name: "Headline",
      width: 800,
      height: 192,
      runs: [
        { text: "design at the speed of " },
        {
          text: "light",
          style: {
            fontStyle: "italic",
            fills: [{ type: "solid", color: { $var: "brand.primary" } }],
          },
        },
        {
          text: "\nA second paragraph.",
          style: { fontSize: 24, fontFamily: "Instrument Sans", link: "https://desyn.app" },
        },
      ],
      style: defaultTextStyle({
        fontFamily: "Instrument Serif",
        fontSize: 80,
        letterSpacing: -0.02,
        features: ["liga", "ss01"],
        variations: { wght: 400 },
      }),
      paragraph: defaultParagraph({
        align: "center",
        lineHeight: { unit: "percent", value: 110 },
        list: "none",
      }),
      autoResize: "height",
      maxLines: 3,
      verticalAlign: "middle",
      role: "headline",
      styleRef: "tstyle000001",
    }),
  ],
  [
    "image",
    "ImageNode",
    createImage({
      id: id(17),
      ...common,
      name: "Hero photo",
      assetId: ASSET,
      width: 600,
      height: 400,
      fit: "crop",
      crop: { x: 0.1, y: 0.05, w: 0.8, h: 0.9, zoom: 1.2 },
      cornerRadius: 12,
      shape: "ellipse",
      adjust: defaultImageAdjust({
        brightness: 0.1,
        contrast: 0.05,
        duotone: ["#0a0a0a", "#ffb02e"],
        filter: "warm",
      }),
      maskAssetId: "matte0000001",
      alt: "Sunrise over hills",
      role: "photo",
    }),
  ],
  [
    "svg",
    "SvgNode",
    createSvg({
      id: id(18),
      ...common,
      name: "Icon",
      width: 48,
      height: 48,
      markup:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="#000000"/></svg>',
      recolor: { "#000000": "#ffb02e" },
      role: "icon",
    }),
  ],
  [
    "video",
    "VideoNode",
    createVideo({
      id: id(19),
      ...common,
      name: "Clip",
      assetId: "video0000001",
      trimStartMs: 500,
      trimEndMs: 4500,
      muted: true,
      loop: true,
      posterAssetId: ASSET,
    }),
  ],
  [
    "audio",
    "AudioNode",
    createAudio({
      id: id(20),
      ...common,
      name: "Soundtrack",
      assetId: "audio0000001",
      startMs: 0,
      trimStartMs: 0,
      volume: 0.8,
      fadeInMs: 300,
      fadeOutMs: 1200,
    }),
  ],
  [
    "chart",
    "ChartNode",
    createChart({
      id: id(21),
      ...common,
      name: "Revenue",
      chart: "stacked-column",
      data: {
        labels: ["Q1", "Q2", "Q3", "Q4"],
        series: [
          { name: "Pro", values: [12, 18.5, 22, 30], color: "#ffb02e" },
          { name: "Free", values: [40, 42, 47, 51] },
        ],
      },
      options: {
        legend: true,
        grid: false,
        labels: true,
        palette: ["#ffb02e", "#ff6a1f"],
        fontFamily: "Instrument Sans",
        fontSize: 14,
        textColor: "#ededed",
        min: 0,
        max: 100,
        unit: "k$",
      },
      role: "chart",
    }),
  ],
  [
    "table",
    "TableNode",
    (() => {
      const t = createTable({ id: id(22), ...common, name: "Pricing", rows: 2, cols: 3 });
      t.cells = [
        { r: 0, c: 0, text: "Plan", style: { fontWeight: 600 } },
        { r: 0, c: 1, text: "Price", align: "right" },
        { r: 0, c: 2, text: "" },
        { r: 1, c: 0, text: "Pro", colspan: 2, fill: { type: "solid", color: "#ffb02e33" } },
        { r: 1, c: 2, text: "$8" },
      ];
      t.stripe = true;
      return t;
    })(),
  ],
  [
    "qr",
    "QrNode",
    createQr({
      id: id(23),
      ...common,
      name: "QR",
      data: "https://desyn.app/s/abc",
      errorCorrection: "Q",
      rounded: true,
    }),
  ],
];

const fills: [string, unknown][] = [
  ["solid", { type: "solid", color: "#ffb02e" }],
  [
    "solid-alpha-blend",
    { type: "solid", color: "#ffb02e80", opacity: 0.5, visible: true, blend: "screen" },
  ],
  ["solid-var", { type: "solid", color: { $var: "brand.primary" } }],
  ["solid-style", { type: "solid", color: { $style: "color0000001" } }],
  [
    "linear",
    {
      type: "linear",
      angle: 135,
      stops: [
        { pos: 0, color: "#ffd66b" },
        { pos: 0.5, color: "#ffb02e" },
        { pos: 1, color: { $var: "brand.ember" } },
      ],
    },
  ],
  [
    "radial",
    {
      type: "radial",
      cx: 0.5,
      cy: 0.4,
      rx: 0.6,
      ry: 0.5,
      stops: [
        { pos: 0, color: "#ffb02eff" },
        { pos: 1, color: "#ffb02e00" },
      ],
      blend: "lighten",
    },
  ],
  [
    "conic",
    {
      type: "conic",
      cx: 0.5,
      cy: 0.5,
      angle: 90,
      stops: [
        { pos: 0, color: "#ff6a1f" },
        { pos: 1, color: "#ffd66b" },
      ],
    },
  ],
  [
    "image",
    {
      type: "image",
      assetId: ASSET,
      mode: "tile",
      scale: 0.5,
      offsetX: 10,
      offsetY: -10,
      rotation: 15,
      opacity: 0.9,
      adjust: { grayscale: 1, grain: 0.2 },
    },
  ],
];

const effects: [string, unknown][] = [
  ["drop-shadow", { type: "dropShadow", x: 0, y: 12, blur: 32, spread: -8, color: "#00000040" }],
  [
    "inner-shadow",
    { type: "innerShadow", x: 0, y: -2, blur: 4, spread: 0, color: "#ffffff26", visible: true },
  ],
  ["layer-blur", { type: "layerBlur", radius: 8 }],
  ["background-blur", { type: "backgroundBlur", radius: 20, visible: false }],
  ["noise", { type: "noise", amount: 0.15, scale: 1.5, mono: true }],
  ["glow", { type: "glow", radius: 48, strength: 0.7, color: "#ffb02e" }],
];

const others: Sample[] = [
  {
    name: "stroke",
    schema: "Stroke",
    valid: true,
    description: "a dashed gradient stroke",
    value: {
      fills: [
        {
          type: "linear",
          angle: 0,
          stops: [
            { pos: 0, color: "#ffd66b" },
            { pos: 1, color: "#ff6a1f" },
          ],
        },
      ],
      width: 2,
      align: "outside",
      dash: [4, 2],
      cap: "round",
      join: "round",
      miterLimit: 4,
      visible: true,
    },
  },
  {
    name: "animation",
    schema: "Animation",
    valid: true,
    description: "entrance animation",
    value: {
      id: "anim00000001",
      preset: "typewriter",
      phase: "in",
      startMs: 200,
      durationMs: 1200,
      easing: "spring",
    },
  },
  {
    name: "text-style",
    schema: "TextStyle",
    valid: true,
    description: "full text style",
    value: {
      ...defaultTextStyle({
        highlight: "#ffd66b80",
        link: "page:page00000002",
        textCase: "upper",
        decoration: "underline",
      }),
    },
  },
  {
    name: "paragraph-style",
    schema: "ParagraphStyle",
    valid: true,
    description: "paragraph style with px line height and bullets",
    value: defaultParagraph({
      align: "justify",
      direction: "rtl",
      lineHeight: { unit: "px", value: 28 },
      spacing: 12,
      indent: 16,
      list: "bullet",
    }),
  },
  {
    name: "asset-image",
    schema: "AssetRef",
    valid: true,
    description: "AI-generated image asset",
    value: {
      id: ASSET,
      kind: "image",
      mime: "image/png",
      storageKey: "u/abc/assets/asset0000001.png",
      bytes: 524288,
      width: 1024,
      height: 1024,
      hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      name: "sun.png",
      source: "ai",
      ai: { provider: "fal", model: "flux", prompt: "a warm sun over hills", seed: 42 },
      attribution: { author: "Desyn AI", license: "owned" },
    },
  },
  {
    name: "asset-font",
    schema: "AssetRef",
    valid: true,
    description: "custom font asset",
    value: {
      id: "font00000001",
      kind: "font",
      mime: "font/woff2",
      family: "Brand Sans",
      weight: 700,
      style: "italic",
      source: "brand",
    },
  },
  {
    name: "design",
    schema: "Design",
    valid: true,
    description: "the base design used by the ops fixtures",
    value: baseDesign(),
  },
  {
    name: "transaction",
    schema: "Transaction",
    valid: true,
    description: "an AI transaction with actor",
    value: {
      id: "tx0000000001",
      label: "AI: make it more premium",
      ops: [
        { op: "update", id: "text00000001", set: { name: "Headline" } },
        { op: "patch", id: "ell000000001", path: ["fills", 0, "color"], value: "#ffd66b" },
        { op: "doc", set: { name: "Premium" }, unset: ["brandKitId"] },
      ],
      source: "ai",
      actor: { userId: "user_1", runId: "run_1", agent: "desyn-agent" },
      ts: 1760000000000,
    },
  },
  // Rejections
  {
    name: "invalid-rect-opacity",
    schema: "RectNode",
    valid: false,
    description: "opacity above 1",
    value: { ...createRect({ id: id(30), parent: P }), opacity: 1.2 },
  },
  {
    name: "invalid-rect-uppercase-color",
    schema: "RectNode",
    valid: false,
    description: "uppercase hex color",
    value: createRect({ id: id(31), parent: P, fills: [{ type: "solid", color: "#FFB02E" }] }),
  },
  {
    name: "invalid-rect-short-id",
    schema: "RectNode",
    valid: false,
    description: "ids are exactly 12 chars",
    value: createRect({ id: "rect1", parent: P }),
  },
  {
    name: "invalid-page-parent",
    schema: "PageNode",
    valid: false,
    description: "a page's parent is always root",
    value: createPage({ id: id(32), parent: id(2) }),
  },
  {
    name: "invalid-svg-no-source",
    schema: "SvgNode",
    valid: false,
    description: "svg needs assetId or markup",
    value: (() => {
      const n = createSvg({ id: id(33), parent: P, markup: "<svg/>" }) as unknown as Record<
        string,
        unknown
      >;
      delete n.markup;
      return n;
    })(),
  },
  {
    name: "invalid-polygon-sides",
    schema: "PolygonNode",
    valid: false,
    description: "polygons have at least 3 integer sides",
    value: createPolygon({ id: id(34), parent: P, sides: 2.5 }),
  },
  {
    name: "invalid-fill-stop-pos",
    schema: "Fill",
    valid: false,
    description: "stop positions are within [0, 1]",
    value: { type: "linear", angle: 0, stops: [{ pos: 1.5, color: "#000000" }] },
  },
  {
    name: "invalid-fill-named-color",
    schema: "Fill",
    valid: false,
    description: "named colors are not allowed",
    value: { type: "solid", color: "red" },
  },
  {
    name: "invalid-effect-type",
    schema: "Effect",
    valid: false,
    description: "unknown effect type",
    value: { type: "bevel", depth: 2 },
  },
  {
    name: "invalid-text-autoresize",
    schema: "TextNode",
    valid: false,
    description: "autoResize is none | height | width",
    value: { ...createText({ id: id(35), parent: P }), autoResize: "both" },
  },
  {
    name: "invalid-root-parent",
    schema: "RootNode",
    valid: false,
    description: "root.parent is null",
    value: { ...createRoot(), parent: P },
  },
];

export const SAMPLES: Sample[] = [
  ...nodes.map(([name, schema, value]) => ({
    name: `node-${name}`,
    schema,
    valid: true,
    description: `canonical example of a ${name} node`,
    value,
  })),
  ...fills.map(([name, value]) => ({
    name: `fill-${name}`,
    schema: "Fill",
    valid: true,
    description: `${name} fill`,
    value,
  })),
  ...effects.map(([name, value]) => ({
    name: `effect-${name}`,
    schema: "Effect",
    valid: true,
    description: `${name} effect`,
    value,
  })),
  ...others,
];

export interface CanonicalCase {
  name: string;
  description: string;
  /** Raw JSON text (kept as text so -0, exponents and spacing survive). */
  inputText: string;
  /** Expected canonical JSON. */
  canonical: string;
}

export const CANONICAL_CASES: CanonicalCase[] = [
  {
    name: "sorted-keys",
    description: "object keys sorted recursively; array order kept",
    inputText: '{"b":1,"a":2,"c":{"z":1,"y":[3,{"k":1,"j":2}]}}',
    canonical: '{"a":2,"b":1,"c":{"y":[3,{"j":2,"k":1}],"z":1}}',
  },
  {
    name: "whitespace",
    description: "insignificant whitespace removed, string content kept",
    inputText: '{ "a" : [ 1 , 2 ] ,\n\t"b" : "x  y" }',
    canonical: '{"a":[1,2],"b":"x  y"}',
  },
  {
    name: "negative-zero",
    description: "-0 is written as 0",
    inputText: '{"a":-0,"b":-0.0,"c":[-0]}',
    canonical: '{"a":0,"b":0,"c":[0]}',
  },
  {
    name: "round-to-six-decimals",
    description: "numbers keep at most 6 decimals",
    inputText: "[0.1234564,0.1234566,1.0000004,1.0000006,3.14159265358979]",
    canonical: "[0.123456,0.123457,1,1.000001,3.141593]",
  },
  {
    name: "round-half-away-from-zero",
    description: "x.5 at the 7th decimal rounds away from zero (on the IEEE product |x| * 1e6)",
    inputText: "[0.0000005,-0.0000005,0.0000025,-0.0000025]",
    canonical: "[0.000001,-0.000001,0.000003,-0.000003]",
  },
  {
    name: "tiny-to-zero",
    description: "values that round to zero become 0 (never -0)",
    inputText: "[1e-7,-1e-7,4.9e-7,-0.0000004]",
    canonical: "[0,0,0,0]",
  },
  {
    name: "integers",
    description: "integers are written without a fraction",
    inputText: "[0,1,-1,42,9007199254740991,-9007199254740991]",
    canonical: "[0,1,-1,42,9007199254740991,-9007199254740991]",
  },
  {
    name: "exponent-input",
    description: "exponent notation in the input is normalized to plain decimals",
    inputText: "[1e2,1E3,1.5e1,2e-3,-1e-2,1.25E+2]",
    canonical: "[100,1000,15,0.002,-0.01,125]",
  },
  {
    name: "large-numbers",
    description: "numbers >= 1e21 are written out in full, never with an exponent",
    inputText: "[1e21,1.5e22,-1e21,123456789012345680000]",
    canonical:
      "[1000000000000000000000,15000000000000000000000,-1000000000000000000000,123456789012345680000]",
  },
  {
    name: "trailing-zeros",
    description: "no trailing zeros or trailing decimal point",
    inputText: "[1.50,2.000,0.10,-1.0,10.10,1e0]",
    canonical: "[1.5,2,0.1,-1,10.1,1]",
  },
  {
    name: "large-fraction",
    description: "rounding applies to large values too",
    inputText: "[12345.6789012345,-98765.4321098765]",
    canonical: "[12345.678901,-98765.43211]",
  },
  {
    name: "shortest-representation",
    description: "the shortest decimal that round-trips the rounded double",
    inputText: "[0.1,0.2,0.30000000000000004,100.000001,0.000001]",
    canonical: "[0.1,0.2,0.3,100.000001,0.000001]",
  },
  {
    name: "string-escapes",
    description:
      'only ", \\ and control characters are escaped (\\b \\f \\n \\r \\t short forms, others \\u00xx lowercase)',
    inputText:
      '["quote\\" backslash\\\\ slash/ nl\\n tab\\t cr\\r bs\\b ff\\f", "\\u0001\\u001F\\u007f", "\\u2028\\u2029", "é😀"]',
    canonical:
      '["quote\\" backslash\\\\ slash/ nl\\n tab\\t cr\\r bs\\b ff\\f","\\u0001\\u001f\u007f","  ","é😀"]',
  },
  {
    name: "unicode-key-order",
    description: "keys sort by Unicode code point (UTF-8 byte order), not UTF-16 code units",
    inputText: '{"😀":6,"ｚ":5,"é":4,"z":3,"a":2,"Z":1}',
    canonical: '{"Z":1,"a":2,"z":3,"é":4,"ｚ":5,"😀":6}',
  },
  {
    name: "empty-containers",
    description: "empty objects, arrays and strings",
    inputText: '{"c":"","b":[],"a":{}}',
    canonical: '{"a":{},"b":[],"c":""}',
  },
  {
    name: "literals",
    description: "true, false, null",
    inputText: "[true , false , null]",
    canonical: "[true,false,null]",
  },
  {
    name: "nested-mixed",
    description: "objects inside arrays inside objects",
    inputText: '[[3,2,1],{"b":[{"d":1,"c":2}],"a":[[{"y":0,"x":-0}]]}]',
    canonical: '[[3,2,1],{"a":[[{"x":0,"y":0}]],"b":[{"c":2,"d":1}]}]',
  },
  {
    name: "half-integer-large",
    description: "a large non-integer keeps its fraction without exponent",
    inputText: "[4503599627370495.5]",
    canonical: "[4503599627370495.5]",
  },
  {
    name: "node-snippet",
    description: "a typical node",
    inputText:
      '{"type":"rect","id":"rect00000001","x":10.0000001,"y":-0,"width":100.5,"height":50,"rotation":-45.1234567,"fills":[{"color":"#ffb02e","type":"solid"}]}',
    canonical:
      '{"fills":[{"color":"#ffb02e","type":"solid"}],"height":50,"id":"rect00000001","rotation":-45.123457,"type":"rect","width":100.5,"x":10,"y":0}',
  },
  {
    name: "key-prefix-order",
    description: "a key sorts before longer keys it prefixes",
    inputText: '{"ab":1,"a":2,"abc":3,"b":4,"A":5}',
    canonical: '{"A":5,"a":2,"ab":1,"abc":3,"b":4}',
  },
];
