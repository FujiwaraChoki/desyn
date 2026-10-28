"use client";

import { Button, cn, IconButton, SunSpinner, useHotkeys } from "@desyn/ui";
import { useConvexAuth, useQuery } from "convex/react";
import { ChevronLeft, ChevronRight, Grid2x2, Maximize, Minimize, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Rich } from "@/components/rich";
import { api, type Id } from "@/lib/convex-api";
import { useT } from "@/lib/i18n";
import { loginUrl } from "@/lib/routes";
import { shareArg } from "@/lib/share-access";
import { slideIndexFromParam } from "@/lib/slides";
import { useSlides } from "./use-slides";

const IDLE_MS = 2500;

/** Fullscreen presenter: one slide at a time, keyboard and touch navigation, grid overview, blackout. */
export function Presenter({ designId }: { designId: Id<"designs"> }) {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("share");
  const [share, setShare] = useState<ReturnType<typeof shareArg>>(token ? { token } : undefined);
  useEffect(() => setShare(shareArg(token)), [token]);
  // Wait for the session before reading: a signed-in member would otherwise briefly look like a
  // stranger (NOT_FOUND).
  const { isLoading: authLoading } = useConvexAuth();
  const design = useQuery(
    api.designs.designs.get,
    authLoading ? "skip" : { designId, ...(share ? { share } : {}) },
  );
  const state = useSlides(designId, share);
  const [index, setIndex] = useState(() => slideIndexFromParam(params.get("slide")));
  const [grid, setGrid] = useState(false);
  const [black, setBlack] = useState(false);
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const touchX = useRef<number | null>(null);
  const count = state.status === "ready" ? state.slides.length : (design?.pageCount ?? 0);
  // A `?slide=` past the end (the deck got shorter) lands on the last slide.
  useEffect(() => {
    if (count > 0) setIndex((i) => Math.min(i, count - 1));
  }, [count]);
  const exitHref = token ? `/share/${encodeURIComponent(token)}` : `/design/${designId}`;

  const go = useCallback(
    (delta: number) => {
      setBlack(false);
      setIndex((i) => Math.min(Math.max(0, i + delta), Math.max(0, count - 1)));
    },
    [count],
  );

  // Keep the slide number in the URL so a reload (or a shared link) lands on the same slide.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("slide", String(index + 1));
    window.history.replaceState(null, "", url);
  }, [index]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    let timer = setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), IDLE_MS);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  // Preload the neighbours so moving between slides is instant.
  useEffect(() => {
    if (state.status !== "ready") return;
    for (const i of [index + 1, index - 1, index + 2]) {
      const slide = state.slides[i];
      if (slide) new Image().src = slide.url;
    }
  }, [state, index]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen?.().catch(() => {});
  };
  const exit = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    router.push(exitHref);
  };

  useHotkeys({
    "arrowright, arrowdown, pagedown, space, enter, n, l": () => (grid ? undefined : go(1)),
    "arrowleft, arrowup, pageup, backspace, p, h, shift+space": () => (grid ? undefined : go(-1)),
    home: () => setIndex(0),
    end: () => setIndex(Math.max(0, count - 1)),
    g: () => setGrid((g) => !g),
    b: () => setBlack((b) => !b),
    period: () => setBlack((b) => !b),
    f: toggleFullscreen,
    escape: () => {
      if (grid) setGrid(false);
      else if (black) setBlack(false);
      else if (!document.fullscreenElement) exit();
    },
  });

  const chrome = cn(
    "transition-opacity duration-500",
    idle && !grid ? "pointer-events-none opacity-0" : "opacity-100",
  );

  return (
    <div
      ref={root}
      className={cn(
        "fixed inset-0 select-none bg-black text-white",
        idle && !grid && "cursor-none",
      )}
      onTouchStart={(e) => {
        touchX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const start = touchX.current;
        const end = e.changedTouches[0]?.clientX;
        touchX.current = null;
        if (start === null || end === undefined || Math.abs(end - start) < 40) return;
        go(end < start ? 1 : -1);
      }}
    >
      {state.status === "loading" ? (
        <div className="grid h-full place-items-center">
          <div className="flex flex-col items-center gap-4 text-[#ffb02e]">
            <SunSpinner size={32} label={t("present.loading")} />
            <p className="text-sm text-white/70">{t("present.loading")}</p>
          </div>
        </div>
      ) : state.status === "error" ? (
        <div className="grid h-full place-items-center px-6 text-center">
          <div className="max-w-md">
            <p className="rich-title font-serif text-[36px] leading-tight text-white">
              <Rich text={t("common.errors.crashTitle")} />
            </p>
            <p className="mt-3 text-sm text-white/70">
              {state.code === "UNAUTHENTICATED"
                ? t("present.signIn")
                : state.message || t("present.renderUnavailable")}
            </p>
            <div className="mt-6 flex justify-center gap-2">
              {state.code === "UNAUTHENTICATED" ? (
                <Button asChild variant="primary">
                  <Link
                    href={loginUrl(
                      `/present/${designId}${token ? `?share=${encodeURIComponent(token)}` : ""}`,
                    )}
                  >
                    {t("auth.login.submit")}
                  </Link>
                </Button>
              ) : null}
              <Button variant="secondary" onClick={exit}>
                {t("present.exit")}
              </Button>
            </div>
          </div>
        </div>
      ) : state.slides.length === 0 ? (
        <div className="grid h-full place-items-center text-white/70">{t("present.empty")}</div>
      ) : grid ? (
        <div className="h-full overflow-y-auto p-6 pt-20 sm:p-12 sm:pt-24">
          <ol className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-5">
            {state.slides.map((s, i) => (
              <li key={s.pageId ?? i}>
                <button
                  type="button"
                  onClick={() => {
                    setIndex(i);
                    setGrid(false);
                  }}
                  className={cn(
                    "block w-full cursor-pointer overflow-hidden rounded-[10px] border-2 bg-[#111] transition-colors focus-visible:outline-2 focus-visible:outline-[#ffb02e]",
                    i === index ? "border-[#ffb02e]" : "border-transparent hover:border-white/30",
                  )}
                >
                  {/* biome-ignore lint/performance/noImgElement: rendered slides on signed storage URLs */}
                  <img
                    src={s.url}
                    alt={t("present.slide", { current: i + 1, total: state.slides.length })}
                    className="block aspect-video w-full object-contain"
                  />
                </button>
                <p className="mt-1.5 text-center text-xs text-white/60 tabular-nums">{i + 1}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="relative grid h-full place-items-center" aria-live="polite">
          {state.slides.map((s, i) =>
            Math.abs(i - index) <= 1 ? (
              // biome-ignore lint/performance/noImgElement: rendered slides on signed storage URLs
              <img
                key={s.pageId ?? i}
                src={s.url}
                alt={t("present.slide", { current: i + 1, total: state.slides.length })}
                aria-hidden={i !== index}
                draggable={false}
                className={cn(
                  "absolute inset-0 m-auto max-h-full max-w-full object-contain transition-opacity duration-300 ease-out",
                  i === index && !black ? "opacity-100" : "opacity-0",
                )}
              />
            ) : null,
          )}
          <button
            type="button"
            aria-label={t("present.previous")}
            className="absolute inset-y-0 left-0 w-1/4 cursor-w-resize"
            onClick={() => go(-1)}
            tabIndex={-1}
          />
          <button
            type="button"
            aria-label={t("present.next")}
            className="absolute inset-y-0 right-0 w-3/4 cursor-e-resize"
            onClick={() => go(1)}
            tabIndex={-1}
          />
        </div>
      )}

      <div
        className={cn(
          "absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 py-3",
          chrome,
        )}
      >
        <IconButton
          label={t("present.exit")}
          onClick={exit}
          className="text-white/80 hover:bg-white/10 hover:text-white"
        >
          <X />
        </IconButton>
        <p className="min-w-0 flex-1 truncate font-serif text-lg text-white/90">
          {design?.name ?? ""}
        </p>
        <IconButton
          label={t("present.grid")}
          active={grid}
          onClick={() => setGrid((g) => !g)}
          className="text-white/80 hover:bg-white/10 hover:text-white"
        >
          <Grid2x2 />
        </IconButton>
        <IconButton
          label={fullscreen ? t("present.exitFullscreen") : t("present.fullscreen")}
          onClick={toggleFullscreen}
          className="text-white/80 hover:bg-white/10 hover:text-white"
        >
          {fullscreen ? <Minimize /> : <Maximize />}
        </IconButton>
      </div>

      {state.status === "ready" && !grid && count > 0 ? (
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/70 to-transparent px-4 pt-10 pb-4",
            chrome,
          )}
        >
          <div className="flex items-center justify-center gap-3">
            <IconButton
              label={t("present.previous")}
              disabled={index === 0}
              onClick={() => go(-1)}
              className="text-white/80 hover:bg-white/10 hover:text-white"
            >
              <ChevronLeft />
            </IconButton>
            <span className="min-w-24 text-center text-sm text-white/80 tabular-nums">
              {t("present.slide", { current: index + 1, total: count })}
            </span>
            <IconButton
              label={t("present.next")}
              disabled={index >= count - 1}
              onClick={() => go(1)}
              className="text-white/80 hover:bg-white/10 hover:text-white"
            >
              <ChevronRight />
            </IconButton>
          </div>
          <div
            className="mx-auto h-0.5 w-full max-w-xl overflow-hidden rounded-full bg-white/15"
            aria-hidden
          >
            <div
              className="h-full bg-[#ffb02e] shadow-[0_0_10px_#ffb02e] transition-[width] duration-500 ease-out"
              style={{ width: `${((index + 1) / count) * 100}%` }}
            />
          </div>
          <p className="hidden text-center text-2xs text-white/45 sm:block">{t("present.help")}</p>
        </div>
      ) : null}
    </div>
  );
}
