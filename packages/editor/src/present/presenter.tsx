"use client";

import { EngineClient } from "@desyn/engine";
import type { AssetRef, Design } from "@desyn/schema";
import { cn, IconButton, Kbd, SunSpinner, ThemeScope, Tooltip } from "@desyn/ui";
import {
  ChevronLeft,
  ChevronRight,
  Grid3X3,
  Maximize,
  Minimize,
  MonitorPlay,
  Pause,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  exitDuration,
  exitTime,
  formatClock,
  holdTime,
  initialNav,
  type NavAction,
  navigate,
  presentationSlides,
  presenterKey,
  type SlideTiming,
} from "./timeline.ts";
import { runTransition } from "./transitions.ts";

export interface PresenterProps {
  design: Design;
  /** URL (or bytes) of an asset; the editor passes its signed-URL service. */
  resolveAsset: (asset: AssetRef) => Promise<string | null> | string | null;
  /** First slide (0-based index among visible pages). */
  startIndex?: number;
  onExit: () => void;
  onSlideChange?: (index: number) => void;
  /** Start in presenter view (notes, timer, next slide). */
  presenterView?: boolean;
}

const HIDE_CONTROLS_MS = 2600;
const THUMB_WIDTH = 360;

/** Thumbnails of the slides (PNG object URLs) rendered by the presenter's engine when it is idle. */
function useThumbnails(
  client: EngineClient | null,
  slides: SlideTiming[],
  design: Design,
  wanted: boolean,
) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!client || !wanted) return;
    let alive = true;
    const made: string[] = [];
    void (async () => {
      for (const s of slides) {
        if (!alive) return;
        const page = design.nodes[s.pageId];
        if (!page || page.width <= 0) continue;
        try {
          const { bytes } = await client.export({
            format: "png",
            pageId: s.pageId,
            scale: Math.min(1, THUMB_WIDTH / page.width),
          });
          if (!alive) return;
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
          made.push(url);
          setUrls((u) => ({ ...u, [s.pageId]: url }));
        } catch {
          // A slide that fails to render keeps its placeholder.
        }
      }
    })();
    return () => {
      alive = false;
      for (const u of made) URL.revokeObjectURL(u);
    };
  }, [client, slides, design, wanted]);
  return urls;
}

function useNow(active: boolean, everyMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs]);
  return now;
}

/**
 * Full-screen presentation of a design: slides with their transitions and entrance / exit / loop animations
 * (rendered by the engine with an animation clock), keyboard and clicker navigation, auto-advance for timed
 * pages, black / white screens, slide overview, and a presenter view with notes, timer, clock and the next
 * slide. Used by the editor (`present.start`) and by apps/web `/present/[id]` through `PresentDesign`.
 */
export function Presenter({
  design,
  resolveAsset,
  startIndex = 0,
  onExit,
  onSlideChange,
  presenterView: initialPresenterView = false,
}: PresenterProps) {
  const slides = useMemo(() => presentationSlides(design), [design]);
  const [nav, dispatch] = useReducer(
    (s: ReturnType<typeof initialNav>, a: NavAction) => navigate(s, a, slides.length),
    undefined,
    () => initialNav(startIndex, slides.length),
  );
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLImageElement>(null);
  const [client, setClient] = useState<EngineClient | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<"none" | "black" | "white">("none");
  const [presenterView, setPresenterView] = useState(initialPresenterView);
  const [overview, setOverview] = useState(false);
  const [controls, setControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [ended, setEnded] = useState(false);
  const [autoplay, setAutoplay] = useState(true);
  const [digits, setDigits] = useState("");
  const [timer, setTimer] = useState({
    start: Date.now(),
    pausedAt: null as number | null,
    offset: 0,
  });
  const busy = useRef(false);
  const holdStart = useRef(performance.now());
  const lastTime = useRef(0);
  const slide = slides[nav.index];
  const next = slides[nav.index + 1];
  const thumbs = useThumbnails(client, slides, design, presenterView || overview);
  const now = useNow(presenterView);

  // Engine ------------------------------------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: one engine per presented design
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 block size-full";
    canvas.setAttribute("aria-hidden", "true");
    el.appendChild(canvas);
    let disposed = false;
    let created: EngineClient | null = null;
    void (async () => {
      try {
        const c = await EngineClient.create({
          canvas,
          render: { background: "#000000", pageShadow: false, budgetMs: 12 },
          resolveAsset: (asset) => resolveAsset(asset),
        });
        if (disposed) {
          c.dispose();
          return;
        }
        created = c;
        await c.load(design);
        const first = slides[nav.index];
        if (first) {
          c.setRenderOptions({ pageId: first.pageId, ...(first.animated ? { timeMs: 0 } : {}) });
          c.fit(first.pageId, 0);
        }
        await c.flush(2500);
        if (disposed) return;
        holdStart.current = performance.now();
        setClient(c);
        setStatus("ready");
      } catch (e) {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("failed");
      }
    })();
    return () => {
      disposed = true;
      created?.dispose();
      canvas.remove();
    };
  }, [design]);

  // Keep the slide fitted when the stage resizes (presenter view, window, fullscreen).
  useEffect(() => {
    const el = host.current;
    if (!el || !client || !slide) return;
    const ro = new ResizeObserver(() => client.fit(slide.pageId, 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [client, slide]);

  // Slide changes: transition from the previous frame, then play the entrance.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the navigation serial
  useEffect(() => {
    if (!client || !slide || nav.from === null) return;
    let cancelled = false;
    void (async () => {
      busy.current = true;
      let snapshot: string | null = null;
      try {
        const png = await client.capture();
        snapshot = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
      } catch {
        snapshot = null;
      }
      if (cancelled) return;
      const img = ghost.current;
      if (img && snapshot) {
        img.src = snapshot;
        img.style.visibility = "visible";
        await img.decode().catch(() => {});
      }
      client.setRenderOptions({
        pageId: slide.pageId,
        ...(slide.animated ? { timeMs: 0 } : { timeMs: undefined }),
      });
      client.fit(slide.pageId, 0);
      lastTime.current = 0;
      await client.flush(700);
      if (cancelled) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      holdStart.current = performance.now();
      await runTransition({
        kind: reduce && slide.transition.kind !== "none" ? "fade" : slide.transition.kind,
        durationMs: reduce
          ? Math.min(200, slide.transition.durationMs)
          : slide.transition.durationMs,
        direction: nav.direction,
        incoming: host.current,
        outgoing: snapshot ? img : null,
      });
      if (img) {
        img.style.visibility = "hidden";
        img.removeAttribute("src");
      }
      if (snapshot) URL.revokeObjectURL(snapshot);
      holdStart.current = performance.now();
      busy.current = false;
      dispatch({ type: "settled" });
    })();
    return () => {
      cancelled = true;
      busy.current = false;
    };
  }, [nav.serial, client]);

  // Report slide changes only (hosts pass inline callbacks; a changed identity is not a new slide).
  const slideChanged = useRef(onSlideChange);
  slideChanged.current = onSlideChange;
  useEffect(() => {
    slideChanged.current?.(nav.index);
  }, [nav.index]);

  // Animation clock while a slide is shown.
  useEffect(() => {
    if (!client || !slide?.animated || nav.from !== null) return;
    let raf = 0;
    const tick = () => {
      const t = Math.round(holdTime(slide, performance.now() - holdStart.current));
      if (t !== lastTime.current) {
        lastTime.current = t;
        client.setRenderOptions({ timeMs: t });
      }
      const settled = !slide.loops && t >= slide.inEnd;
      if (!settled) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [client, slide, nav.from]);

  // Leaving a slide: play its exit animations first.
  const leave = useCallback(
    async (action: NavAction) => {
      if (!client || !slide || busy.current) return;
      const from = lastTime.current;
      const duration = exitDuration(slide, from);
      if (
        duration > 0 &&
        (action.type === "next" || action.type === "goto" || action.type === "last")
      ) {
        busy.current = true;
        const start = performance.now();
        await new Promise<void>((resolve) => {
          const step = () => {
            const t = exitTime(slide, performance.now() - start, from) ?? from;
            client.setRenderOptions({ timeMs: Math.round(t) });
            if (performance.now() - start < duration) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        });
        busy.current = false;
      }
      dispatch(action);
    },
    [client, slide],
  );

  const goNext = useCallback(() => {
    if (screen !== "none") {
      setScreen("none");
      return;
    }
    if (ended) {
      onExit();
      return;
    }
    if (nav.index >= slides.length - 1) {
      setEnded(true);
      return;
    }
    void leave({ type: "next" });
  }, [screen, ended, nav.index, slides.length, leave, onExit]);

  const goPrev = useCallback(() => {
    if (screen !== "none") {
      setScreen("none");
      return;
    }
    if (ended) {
      setEnded(false);
      return;
    }
    if (!busy.current) dispatch({ type: "prev" });
  }, [screen, ended]);

  const goTo = useCallback((index: number) => {
    setEnded(false);
    setOverview(false);
    setScreen("none");
    if (!busy.current) dispatch({ type: "goto", index });
  }, []);

  // Auto-advance (timed pages).
  useEffect(() => {
    if (
      !autoplay ||
      !slide?.autoAdvanceMs ||
      nav.from !== null ||
      screen !== "none" ||
      overview ||
      ended
    )
      return;
    const t = setTimeout(goNext, slide.autoAdvanceMs);
    return () => clearTimeout(t);
  }, [autoplay, slide, nav.from, screen, overview, ended, goNext]);

  // Fullscreen.
  const toggleFullscreen = useCallback(() => {
    const el = root.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  }, []);
  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement !== null);
    on();
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const exit = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    onExit();
  }, [onExit]);

  // Keyboard and clickers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = presenterKey(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      switch (action.type) {
        case "next":
          setDigits("");
          goNext();
          break;
        case "prev":
          setDigits("");
          goPrev();
          break;
        case "first":
        case "last":
          goTo(action.type === "first" ? 0 : slides.length - 1);
          break;
        case "goto":
          goTo(action.index);
          break;
        case "exit":
          if (overview) setOverview(false);
          else if (screen !== "none") setScreen("none");
          else exit();
          break;
        case "black":
          setScreen((s) => (s === "black" ? "none" : "black"));
          break;
        case "white":
          setScreen((s) => (s === "white" ? "none" : "white"));
          break;
        case "fullscreen":
          toggleFullscreen();
          break;
        case "presenterView":
          setPresenterView((v) => !v);
          break;
        case "overview":
          setOverview((v) => !v);
          break;
        case "digit":
          setDigits((d) => `${d}${action.digit}`.slice(-4));
          break;
        case "commitDigits":
          if (digits) {
            goTo(Number(digits) - 1);
            setDigits("");
          } else goNext();
          break;
        case "settled":
          break;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [goNext, goPrev, goTo, exit, toggleFullscreen, overview, screen, digits, slides.length]);

  // Keyboard focus moves into the presentation (and back afterwards): keys then target this dialog, which the
  // editor's canvas and shortcut handlers leave alone, and nothing behind it keeps a focused input.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  // Controls fade out while the pointer rests.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const wake = () => {
      setControls(true);
      clearTimeout(t);
      t = setTimeout(() => setControls(false), HIDE_CONTROLS_MS);
    };
    wake();
    window.addEventListener("pointermove", wake);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointermove", wake);
    };
  }, []);

  // Touch swipes.
  const swipe = useRef<{ x: number; y: number } | null>(null);

  const elapsed = (timer.pausedAt ?? now) - timer.start - timer.offset;
  const total = slides.length;

  return (
    <ThemeScope theme="dark" className="contents">
      <div
        ref={root}
        tabIndex={-1}
        className={cn(
          "fixed inset-0 z-[200] flex bg-black text-fg outline-none select-none",
          !controls && !presenterView && "cursor-none",
        )}
        role="dialog"
        aria-modal="true"
        aria-label={`Presentation, slide ${nav.index + 1} of ${total}`}
      >
        {/* Stage */}
        <div
          className={cn(
            "relative min-w-0 flex-1",
            presenterView && "m-4 overflow-hidden rounded-panel border border-white/10",
          )}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: click / swipe to advance; keyboard handled globally */}
          <div
            ref={host}
            className="absolute inset-0 overflow-hidden will-change-transform"
            onPointerDown={(e) => {
              swipe.current = { x: e.clientX, y: e.clientY };
            }}
            onPointerUp={(e) => {
              const s = swipe.current;
              swipe.current = null;
              if (!s || overview) return;
              const dx = e.clientX - s.x;
              const dy = e.clientY - s.y;
              if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
                if (dx < 0) goNext();
                else goPrev();
              } else if (Math.abs(dx) < 6 && Math.abs(dy) < 6 && e.button === 0) {
                goNext();
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              goPrev();
            }}
          />
          <img
            ref={ghost}
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 size-full object-fill"
            style={{ visibility: "hidden" }}
          />
          {status !== "ready" ? (
            <div className="absolute inset-0 grid place-items-center">
              {status === "loading" ? (
                <SunSpinner size="lg" label="Preparing the presentation" />
              ) : (
                <p className="max-w-md px-6 text-center text-sm text-white/70">
                  The presentation could not start{error ? ` (${error})` : ""}.
                </p>
              )}
            </div>
          ) : null}
          {screen !== "none" ? (
            <div
              className={cn("absolute inset-0", screen === "black" ? "bg-black" : "bg-white")}
              aria-hidden
            />
          ) : null}
          {ended ? (
            <div className="absolute inset-0 grid place-items-center bg-black">
              <div className="flex flex-col items-center gap-3 text-center">
                <p className="font-serif text-4xl text-white">
                  the <em className="text-accent">end</em>
                </p>
                <p className="text-sm text-white/60">Click or press → to leave, ← to go back.</p>
              </div>
            </div>
          ) : null}
          {digits ? (
            <div className="absolute top-6 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 font-mono text-lg text-white tabular-nums backdrop-blur">
              {digits}
              <span className="ml-2 text-xs text-white/50">Enter</span>
            </div>
          ) : null}

          {/* Controls */}
          <div
            className={cn(
              "absolute inset-x-0 bottom-0 flex justify-center p-4 transition-opacity duration-300",
              controls || presenterView ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            <div className="flex items-center gap-1 rounded-full border border-white/10 bg-black/60 p-1 text-white shadow-popover backdrop-blur-xl">
              <IconButton
                label="Previous slide"
                shortcut="arrowleft"
                size="sm"
                variant="ghost"
                onClick={goPrev}
                disabled={nav.index === 0 && !ended}
              >
                <ChevronLeft />
              </IconButton>
              <span className="min-w-16 text-center text-xs tabular-nums text-white/80">
                {nav.index + 1} / {total}
              </span>
              <IconButton
                label="Next slide"
                shortcut="arrowright"
                size="sm"
                variant="ghost"
                onClick={goNext}
              >
                <ChevronRight />
              </IconButton>
              <div className="mx-1 h-4 w-px bg-white/15" />
              <IconButton
                label="Slide overview"
                shortcut="g"
                size="sm"
                variant="ghost"
                active={overview}
                onClick={() => setOverview((v) => !v)}
              >
                <Grid3X3 />
              </IconButton>
              <IconButton
                label="Presenter view"
                shortcut="s"
                size="sm"
                variant="ghost"
                active={presenterView}
                onClick={() => setPresenterView((v) => !v)}
              >
                <MonitorPlay />
              </IconButton>
              <IconButton
                label={fullscreen ? "Exit full screen" : "Full screen"}
                shortcut="f"
                size="sm"
                variant="ghost"
                onClick={toggleFullscreen}
              >
                {fullscreen ? <Minimize /> : <Maximize />}
              </IconButton>
              <IconButton
                label="End presentation"
                shortcut="escape"
                size="sm"
                variant="ghost"
                onClick={exit}
              >
                <X />
              </IconButton>
            </div>
          </div>
        </div>

        {/* Presenter view */}
        {presenterView ? (
          <aside className="flex w-[min(420px,38vw)] shrink-0 flex-col gap-4 overflow-y-auto border-l border-white/10 bg-[#0d0d0d] p-5 text-white">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[11px] text-white/50">Elapsed</p>
                <p className="font-serif text-5xl leading-none tabular-nums text-accent">
                  {formatClock(elapsed)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[11px] text-white/50">Clock</p>
                <p className="text-xl tabular-nums text-white/80">
                  {new Date(now).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <IconButton
                label={timer.pausedAt ? "Resume timer" : "Pause timer"}
                size="sm"
                variant="ghost"
                onClick={() =>
                  setTimer((t) =>
                    t.pausedAt
                      ? { ...t, offset: t.offset + (Date.now() - t.pausedAt), pausedAt: null }
                      : { ...t, pausedAt: Date.now() },
                  )
                }
              >
                {timer.pausedAt ? <Play /> : <Pause />}
              </IconButton>
              <IconButton
                label="Reset timer"
                size="sm"
                variant="ghost"
                onClick={() => setTimer({ start: Date.now(), pausedAt: null, offset: 0 })}
              >
                <RotateCcw />
              </IconButton>
              <div className="flex-1" />
              {slides.some((s) => s.autoAdvanceMs) ? (
                <Tooltip content="Advance timed slides automatically">
                  <button
                    type="button"
                    aria-pressed={autoplay}
                    onClick={() => setAutoplay((v) => !v)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                      autoplay ? "border-accent/50 text-accent" : "border-white/15 text-white/60",
                    )}
                  >
                    Auto-advance {autoplay ? "on" : "off"}
                  </button>
                </Tooltip>
              ) : null}
            </div>
            <section>
              <p className="mb-1.5 text-[11px] text-white/50">
                Slide {nav.index + 1} of {total}
                {slide?.name ? ` · ${slide.name}` : ""}
              </p>
              <div className="min-h-32 rounded-card border border-white/10 bg-white/[0.03] p-4">
                {slide?.notes ? (
                  <p className="text-[17px] leading-relaxed whitespace-pre-wrap text-white/90">
                    {slide.notes}
                  </p>
                ) : (
                  <p className="text-sm text-white/40">No speaker notes for this slide.</p>
                )}
              </div>
            </section>
            <section>
              <p className="mb-1.5 text-[11px] text-white/50">Next</p>
              {next ? (
                <button
                  type="button"
                  onClick={goNext}
                  className="group block w-full overflow-hidden rounded-card border border-white/10 bg-black text-left transition-colors hover:border-accent/50"
                >
                  {thumbs[next.pageId] ? (
                    <img src={thumbs[next.pageId]} alt={next.name} className="block w-full" />
                  ) : (
                    <div className="grid aspect-video place-items-center text-xs text-white/40">
                      {next.name}
                    </div>
                  )}
                </button>
              ) : (
                <p className="rounded-card border border-white/10 p-4 text-sm text-white/40">
                  This is the last slide.
                </p>
              )}
            </section>
            <p className="mt-auto flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/40">
              <span>
                <Kbd>→</Kbd> next
              </span>
              <span>
                <Kbd>←</Kbd> back
              </span>
              <span>
                <Kbd>B</Kbd> black
              </span>
              <span>
                <Kbd>G</Kbd> overview
              </span>
              <span>
                <Kbd>3</Kbd> <Kbd>Enter</Kbd> go to 3
              </span>
            </p>
          </aside>
        ) : null}

        {/* Overview */}
        {overview ? (
          <div className="absolute inset-0 z-10 overflow-y-auto bg-black/90 p-8 backdrop-blur-sm">
            <div className="mx-auto grid max-w-6xl grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
              {slides.map((s, i) => (
                <button
                  key={s.pageId}
                  type="button"
                  onClick={() => goTo(i)}
                  className={cn(
                    "group flex flex-col gap-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring",
                  )}
                >
                  <span
                    className={cn(
                      "block overflow-hidden rounded-card border bg-[#111] transition-[border-color,box-shadow]",
                      i === nav.index
                        ? "border-accent"
                        : "border-white/10 group-hover:border-white/30",
                    )}
                  >
                    {thumbs[s.pageId] ? (
                      <img src={thumbs[s.pageId]} alt="" className="block w-full" />
                    ) : (
                      <span className="grid aspect-video place-items-center">
                        <SunSpinner size="sm" label="Rendering" />
                      </span>
                    )}
                  </span>
                  <span className="truncate text-xs text-white/70">
                    <span className="mr-1.5 tabular-nums text-white/40">{i + 1}</span>
                    {s.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </ThemeScope>
  );
}
