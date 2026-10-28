// Credit accounting helpers. The ledger itself lives in Convex (reserve -> commit/refund, idempotent by refId);
// this module maps AI actions to `config/plans.json` creditCosts, estimates runs before they start (so Convex
// can reserve) and meters what was actually used (so Convex can settle).
import { type CreditAction, creditCost, PLANS } from "@desyn/schema";
import type { AiTask } from "./models";
import type { Billing } from "./providers/types";

/** Billable operations the AI package performs. */
export type BillableAction =
  | "agent.turn"
  | "generateDesign"
  | "image"
  | "svg"
  | "trace"
  | "bgRemove"
  | "upscale"
  | "inpaint"
  | "outpaint"
  | "mockup"
  | "copy"
  | "translate"
  | "video"
  | "speech"
  | "campaignDesign"
  | "resizeVariant"
  | "localizeVariant";

/**
 * plans.json has no dedicated keys for tracing and speech: tracing is priced like SVG generation (one vector
 * asset) and a voiceover like an image (similar provider cost). Everything else maps 1:1.
 */
export const CREDIT_ACTION: Readonly<Record<BillableAction, CreditAction>> = {
  "agent.turn": "agent.turn",
  generateDesign: "ai.generateDesign",
  image: "ai.image",
  svg: "ai.svg",
  trace: "ai.svg",
  bgRemove: "ai.removeBackground",
  upscale: "ai.upscale",
  inpaint: "ai.inpaint",
  outpaint: "ai.outpaint",
  mockup: "ai.mockup",
  copy: "ai.copy",
  translate: "ai.translate",
  video: "ai.videoClip",
  speech: "ai.image",
  campaignDesign: "workflow.campaignDesign",
  resizeVariant: "workflow.resizeVariant",
  localizeVariant: "workflow.localizeVariant",
};

/** Credit action for a routed media/text task, when the task is billed per call. */
export const TASK_ACTION: Readonly<Partial<Record<AiTask, BillableAction>>> = {
  image: "image",
  imageText: "image",
  vector: "image",
  svg: "svg",
  trace: "trace",
  bgRemove: "bgRemove",
  upscale: "upscale",
  inpaint: "inpaint",
  outpaint: "outpaint",
  mockup: "mockup",
  copy: "copy",
  translate: "translate",
  video: "video",
  speech: "speech",
};

export function creditsFor(action: BillableAction, count = 1): number {
  return creditCost(CREDIT_ACTION[action]) * Math.max(0, count);
}

export interface EstimateItem {
  action: BillableAction;
  count?: number;
  /** Billing of the provider that will run it; BYOK and local calls are free when fair use says so. */
  billing?: Billing;
}

export interface EstimateLine {
  action: BillableAction;
  creditAction: CreditAction;
  count: number;
  unit: number;
  subtotal: number;
  free: boolean;
}

export interface CreditEstimate {
  total: number;
  lines: EstimateLine[];
}

function isFree(billing: Billing | undefined): boolean {
  return billing === "local" || (billing === "byok" && PLANS.fairUse.byokBypassesCredits);
}

export function estimateCredits(items: readonly EstimateItem[]): CreditEstimate {
  const lines = items.map((item): EstimateLine => {
    const count = item.count ?? 1;
    const unit = creditCost(CREDIT_ACTION[item.action]);
    const free = isFree(item.billing);
    return {
      action: item.action,
      creditAction: CREDIT_ACTION[item.action],
      count,
      unit,
      subtotal: free ? 0 : unit * count,
      free,
    };
  });
  return { total: lines.reduce((s, l) => s + l.subtotal, 0), lines };
}

/** Estimate for an agent run: `maxSteps` turns plus the assets it is expected to make. */
export function estimateAgentRun(options: {
  maxSteps: number;
  billing?: Billing;
  expectedAssets?: EstimateItem[];
  generateDesign?: boolean;
}): CreditEstimate {
  const items: EstimateItem[] = [
    {
      action: "agent.turn",
      count: options.maxSteps,
      ...(options.billing ? { billing: options.billing } : {}),
    },
    ...(options.expectedAssets ?? []),
  ];
  if (options.generateDesign) {
    items.push({
      action: "generateDesign",
      ...(options.billing ? { billing: options.billing } : {}),
    });
  }
  return estimateCredits(items);
}

export interface Settlement {
  /** Credits to commit (actual use). */
  charge: number;
  /** Reserved credits to release. */
  release: number;
  /**
   * Use beyond the reservation. It is still passed to `commitCredits` as part of `charge`; the Convex ledger
   * charges only what fits in the monthly pool and records the rest as fair-use overage (never billed).
   */
  overage: number;
}

/** Splits actual use against a reservation for `commitCredits` / `refundCredits` in Convex. */
export function settleCredits(reserved: number, actual: number): Settlement {
  const charge = Math.max(0, actual);
  return {
    charge,
    release: Math.max(0, reserved - charge),
    overage: Math.max(0, charge - reserved),
  };
}

export interface MeterEntry {
  action: BillableAction;
  credits: number;
  billing: Billing;
  ref?: string;
  at: number;
}

/**
 * Running total of credits used by a run. `limit` (credits) turns into a hard cap: `wouldExceed` lets callers
 * refuse an operation before spending, `charge` records it.
 */
export class CreditMeter {
  private readonly entries: MeterEntry[] = [];

  constructor(
    readonly limit: number | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  get used(): number {
    return this.entries.reduce((s, e) => s + e.credits, 0);
  }

  get remaining(): number | null {
    return this.limit === null ? null : Math.max(0, this.limit - this.used);
  }

  costOf(action: BillableAction, billing: Billing, count = 1): number {
    return isFree(billing) ? 0 : creditsFor(action, count);
  }

  wouldExceed(action: BillableAction, billing: Billing, count = 1): boolean {
    return this.limit !== null && this.used + this.costOf(action, billing, count) > this.limit;
  }

  charge(
    action: BillableAction,
    billing: Billing,
    options: { count?: number; ref?: string } = {},
  ): number {
    const credits = this.costOf(action, billing, options.count ?? 1);
    const entry: MeterEntry = { action, credits, billing, at: this.now() };
    if (options.ref) entry.ref = options.ref;
    this.entries.push(entry);
    return credits;
  }

  history(): readonly MeterEntry[] {
    return this.entries;
  }

  /** Totals per credit action (for run summaries and the usage dashboard). */
  breakdown(): Partial<Record<CreditAction, number>> {
    const out: Partial<Record<CreditAction, number>> = {};
    for (const e of this.entries) {
      const key = CREDIT_ACTION[e.action];
      out[key] = (out[key] ?? 0) + e.credits;
    }
    return out;
  }
}
