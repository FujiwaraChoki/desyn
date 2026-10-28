import type { FeatureKey } from "@desyn/schema";

/**
 * Plan gating for AI features. The server enforces every check (FEATURE_UNAVAILABLE); the dock only decides
 * what to offer: an action the plan lacks shows the PRO badge and an upgrade call to action instead of
 * failing after the click. Feature lists mirror convex/lib/ai_access.ts and lib/ai_start.ts.
 */

export type TaskModels = Record<string, { provider: string; model: string }>;

/** The subset of `accounts/profiles:me` the AI dock reads. */
export interface AccountView {
  userId: string;
  emailVerified: boolean;
  edition: "hosted" | "selfhost";
  plan: string;
  planName: string;
  features: Record<string, boolean>;
  aiSettings: {
    keyMode?: "server" | "local";
    preferByok?: boolean;
    ollamaBaseUrl?: string;
    taskModels?: TaskModels;
  } | null;
  defaultWorkspaceId: string | null;
}

export type AiAction =
  | "agent.edit"
  | "agent.generate"
  | "agent.critique"
  | "image"
  | "svg"
  | "removeBackground"
  | "inpaint"
  | "outpaint"
  | "upscale"
  | "mockup"
  | "trace"
  | "copy"
  | "translate"
  | "brand"
  | "workflow.campaign"
  | "workflow.variants"
  | "workflow.resize"
  | "workflow.localize"
  | "workflow.bulk"
  | "run.local"
  | "run.byok";

export const FEATURES_FOR: Readonly<Record<AiAction, readonly FeatureKey[]>> = {
  "agent.edit": ["ai.agent"],
  "agent.generate": ["ai.agent", "ai.generateDesign"],
  "agent.critique": ["ai.agent"],
  image: ["ai.images"],
  svg: ["ai.svg"],
  removeBackground: ["ai.removeBackground"],
  inpaint: ["ai.inpaint"],
  outpaint: ["ai.outpaint"],
  upscale: ["ai.upscale"],
  mockup: ["ai.mockup"],
  trace: ["ai.svg"],
  // Text actions run through the agent (rewrite_text / translate_text tools).
  copy: ["ai.agent", "ai.copy"],
  translate: ["ai.agent", "ai.translate"],
  brand: ["ai.agent", "brandKit"],
  "workflow.campaign": ["workflows", "campaign", "ai.agent"],
  "workflow.variants": ["workflows", "ai.agent"],
  "workflow.resize": ["workflows", "magicResize"],
  "workflow.localize": ["workflows", "localize", "ai.translate"],
  "workflow.bulk": ["workflows", "bulkCreate"],
  "run.local": ["ai.local"],
  "run.byok": ["ai.byok"],
};

export type Gate =
  | { state: "ok" }
  | { state: "loading" }
  | { state: "signed-out" }
  | { state: "unverified" }
  /** The plan lacks `feature`; Pro has every feature. */
  | { state: "upgrade"; feature: FeatureKey };

/**
 * Whether `account` may use `action`. `undefined` = the account is still loading, `null` = signed out (share
 * links). Server runs need a verified email (the backend requires it to start runs and workflows).
 */
export function gate(account: AccountView | null | undefined, action: AiAction): Gate {
  if (account === undefined) return { state: "loading" };
  if (account === null) return { state: "signed-out" };
  for (const feature of FEATURES_FOR[action]) {
    if (account.features[feature] !== true) return { state: "upgrade", feature };
  }
  if (!account.emailVerified && !action.startsWith("run.")) return { state: "unverified" };
  return { state: "ok" };
}

export const allowed = (g: Gate): boolean => g.state === "ok";

/** True when no AI action at all is available on this plan (the dock shows the upgrade card). */
export function aiLocked(account: AccountView | null | undefined): boolean {
  return !!account && account.features["ai.agent"] !== true;
}

/** Where the upgrade call to action leads (apps/web route). */
export const UPGRADE_HREF = "/settings/billing";

const FEATURE_LABELS: Partial<Record<FeatureKey, string>> = {
  "ai.agent": "The AI agent",
  "ai.generateDesign": "Generating whole designs",
  "ai.images": "Image generation",
  "ai.svg": "Vector generation",
  "ai.removeBackground": "Background removal",
  "ai.inpaint": "Inpainting",
  "ai.outpaint": "Expanding images",
  "ai.upscale": "Upscaling",
  "ai.mockup": "Mockups",
  "ai.copy": "AI copywriting",
  "ai.translate": "Translation",
  "ai.byok": "Your own API keys",
  "ai.local": "Local models",
  brandKit: "Brand kits",
  workflows: "AI workflows",
  campaign: "Campaigns",
  magicResize: "Magic resize",
  localize: "Localization",
  bulkCreate: "Bulk create",
};

/** Sentence for an upgrade prompt: "Background removal is part of Pro." */
export function upgradeMessage(feature: FeatureKey): string {
  return `${FEATURE_LABELS[feature] ?? "This feature"} is part of Pro.`;
}

/** Parses the `me` query result defensively (unknown shapes from other owners never crash the dock). */
export function toAccountView(raw: unknown): AccountView | null {
  if (!raw || typeof raw !== "object") return null;
  const me = raw as Record<string, unknown>;
  if (typeof me.userId !== "string") return null;
  const features: Record<string, boolean> = {};
  if (me.features && typeof me.features === "object") {
    for (const [k, v] of Object.entries(me.features as Record<string, unknown>)) {
      features[k] = v === true;
    }
  }
  const settings =
    me.aiSettings && typeof me.aiSettings === "object"
      ? (me.aiSettings as Record<string, unknown>)
      : null;
  const taskModels: TaskModels = {};
  if (settings?.taskModels && typeof settings.taskModels === "object") {
    for (const [task, ref] of Object.entries(settings.taskModels as Record<string, unknown>)) {
      const r = ref as { provider?: unknown; model?: unknown } | null;
      if (r && typeof r.provider === "string" && typeof r.model === "string") {
        taskModels[task] = { provider: r.provider, model: r.model };
      }
    }
  }
  return {
    userId: me.userId,
    emailVerified: me.emailVerified !== false,
    edition: me.edition === "selfhost" ? "selfhost" : "hosted",
    plan: typeof me.plan === "string" ? me.plan : "free",
    planName: typeof me.planName === "string" ? me.planName : "Free",
    features,
    aiSettings: settings
      ? {
          ...(settings.keyMode === "local" || settings.keyMode === "server"
            ? { keyMode: settings.keyMode }
            : {}),
          ...(typeof settings.preferByok === "boolean" ? { preferByok: settings.preferByok } : {}),
          ...(typeof settings.ollamaBaseUrl === "string"
            ? { ollamaBaseUrl: settings.ollamaBaseUrl }
            : {}),
          taskModels,
        }
      : null,
    defaultWorkspaceId: typeof me.defaultWorkspaceId === "string" ? me.defaultWorkspaceId : null,
  };
}
