import { axiomEnabled, axiomRequest, parseVital, type VitalSample } from "@/lib/vitals";

export const dynamic = "force-dynamic";

function axiomEnv() {
  return {
    AXIOM_TOKEN: process.env.AXIOM_TOKEN,
    AXIOM_DATASET: process.env.AXIOM_DATASET,
    AXIOM_URL: process.env.AXIOM_URL,
    AXIOM_ORG_ID: process.env.AXIOM_ORG_ID,
  };
}

/** Lets the browser know whether to report at all (cached for an hour). */
export function GET(): Response {
  return Response.json(
    { enabled: axiomEnabled(axiomEnv()) },
    { headers: { "cache-control": "private, max-age=3600" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const env = axiomEnv();
  if (!axiomEnabled(env)) return new Response(null, { status: 204 });
  const text = await request.text();
  if (text.length > 16_384) return new Response(null, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const items = Array.isArray(body) ? body.slice(0, 20) : [body];
  const samples = items.map(parseVital).filter((s): s is VitalSample => s !== null);
  const req = axiomRequest(env, samples);
  if (req) {
    try {
      await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(5000) });
    } catch {
      // Telemetry must never fail the page; a lost batch is acceptable.
    }
  }
  return new Response(null, { status: 204 });
}
