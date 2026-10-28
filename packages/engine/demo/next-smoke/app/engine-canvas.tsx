"use client";

import { EngineClient } from "@desyn/engine";
import type { Design } from "@desyn/schema";
import { useEffect, useRef, useState } from "react";
import social from "../../../../../spec/fixtures/render/social.json";

// Fixture asset bytes, emitted by Turbopack as static files (an app resolves Convex / S3 URLs instead).
const ASSETS: Record<string, string> = {
  photo0000001: new URL(
    "../../../../../spec/fixtures/render/assets/photo0000001.jpg",
    import.meta.url,
  ).href,
  icon00000001: new URL(
    "../../../../../spec/fixtures/render/assets/icon00000001.svg",
    import.meta.url,
  ).href,
};

export function EngineCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("starting");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let client: EngineClient | null = null;
    let cancelled = false;
    (async () => {
      // A canvas can hand its control to a worker only once; StrictMode mounts twice, so use a fresh element.
      const fresh = canvas.cloneNode() as HTMLCanvasElement;
      canvas.replaceWith(fresh);
      canvasRef.current = fresh;
      client = await EngineClient.create({
        canvas: fresh,
        render: { background: "#0e0e0e", pageShadow: true },
        resolveAsset: (asset) => ASSETS[asset.id] ?? asset.url,
      });
      if (cancelled) {
        client.dispose();
        return;
      }
      await client.load(social as unknown as Design);
      client.fit(undefined, 48);
      await client.flush();
      setStatus(`ready · ${client.mode} · ${client.info.formats.join(" ")}`);
      Object.assign(window, { desynSmoke: client });
    })().catch((e) => setStatus(`failed: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      cancelled = true;
      client?.dispose();
    };
  }, []);

  return (
    <div style={{ position: "relative" }}>
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />
      <output
        data-status={status}
        style={{ position: "absolute", left: 16, bottom: 16, fontSize: 12, opacity: 0.7 }}
      >
        {status}
      </output>
    </div>
  );
}
