"use client";

import { CornerDownLeft, FileText, Hash, Loader2, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DocsSearch,
  type SearchHit,
  type SearchIndexFile,
  type Segment,
} from "@/lib/search-engine";
import { withBasePath } from "@/lib/site";

export const OPEN_SEARCH_EVENT = "desyn:open-search";

const SUGGESTIONS = [
  { href: "/quickstart", title: "Quickstart", section: "Get started" },
  { href: "/editor/keyboard-shortcuts", title: "Keyboard shortcuts", section: "Editor" },
  { href: "/ai/agent", title: "The agent", section: "AI" },
  {
    href: "/self-hosting/docker-compose",
    title: "Docker Compose quickstart",
    section: "Self-hosting",
  },
  {
    href: "/self-hosting/configuration",
    title: "Configuration reference",
    section: "Self-hosting",
  },
  { href: "/developers/api", title: "Agent API (v1)", section: "Developers" },
];

let enginePromise: Promise<DocsSearch> | null = null;

/** Fetch the static index once per page load and build the engine. */
export function loadSearchEngine(): Promise<DocsSearch> {
  if (!enginePromise) {
    enginePromise = fetch(withBasePath("/search-index.json"))
      .then((res) => {
        if (!res.ok) throw new Error(`Search index request failed (${res.status})`);
        return res.json() as Promise<SearchIndexFile>;
      })
      .then((file) => new DocsSearch(file.records))
      .catch((error: unknown) => {
        enginePromise = null;
        throw error;
      });
  }
  return enginePromise;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function SearchDialog() {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [engine, setEngine] = useState<DocsSearch | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [active, setActive] = useState(0);
  const listId = useId();

  const show = useCallback(() => {
    setOpen(true);
    if (!engine) {
      setStatus("loading");
      loadSearchEngine()
        .then((e) => {
          setEngine(e);
          setStatus("ready");
        })
        .catch(() => setStatus("error"));
    }
  }, [engine]);

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        show();
      } else if (event.key === "/" && !mod && !isTypingTarget(event.target)) {
        event.preventDefault();
        show();
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SEARCH_EVENT, show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SEARCH_EVENT, show);
    };
  }, [show]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      inputRef.current?.select();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Searching is synchronous and takes about a millisecond, so results always match the input and
  // Enter can never open a result from a previous query.
  const hits: SearchHit[] = useMemo(
    () => (engine && query.trim() ? engine.search(query, 14) : []),
    [engine, query],
  );

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const items = query.trim() ? hits.map((h) => h.record.href) : SUGGESTIONS.map((s) => s.href);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  function onInputKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Escape") {
      // A search input would otherwise swallow the first Escape to clear itself.
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Enter") {
      const href = items[active];
      if (href) {
        event.preventDefault();
        go(href);
      }
    }
  }

  const activeId = items.length ? `${listId}-opt-${active}` : undefined;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: clicking the backdrop closes; Escape is native to <dialog>
    <dialog
      ref={dialogRef}
      className="search-dialog"
      aria-label="Search documentation"
      onClose={() => setOpen(false)}
      onClick={(event) => {
        if (event.target === dialogRef.current) setOpen(false);
      }}
    >
      <div className="search-panel">
        <div className="search-field">
          <Search size={18} aria-hidden className="search-field-icon" />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            placeholder="Search the docs"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
            spellCheck={false}
            autoComplete="off"
          />
          {status === "loading" ? (
            <Loader2 size={16} className="spin" aria-label="Loading index" />
          ) : null}
          <button
            type="button"
            className="icon-button"
            onClick={() => setOpen(false)}
            aria-label="Close search"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="search-results">
          {status === "error" ? (
            <p className="search-empty">
              The search index could not be loaded. Check your connection and try again.
            </p>
          ) : query.trim() && status === "ready" && hits.length === 0 ? (
            <p className="search-empty">
              No results for “{query.trim()}”. Try a shorter or different word.
            </p>
          ) : null}

          {!query.trim() ? <p className="search-group-label">Popular pages</p> : null}
          <div id={listId} role="listbox" ref={listRef} aria-label="Results">
            {query.trim()
              ? hits.map((hit, i) => (
                  <Option
                    key={hit.record.id}
                    id={`${listId}-opt-${i}`}
                    index={i}
                    active={i === active}
                    onHover={setActive}
                    onChoose={() => go(hit.record.href)}
                    icon={hit.record.heading === hit.record.page ? "page" : "section"}
                    title={hit.record.heading}
                    page={hit.record.heading !== hit.record.page ? hit.record.page : undefined}
                    snippet={hit.snippet}
                    section={hit.record.section}
                  />
                ))
              : SUGGESTIONS.map((s, i) => (
                  <Option
                    key={s.href}
                    id={`${listId}-opt-${i}`}
                    index={i}
                    active={i === active}
                    onHover={setActive}
                    onChoose={() => go(s.href)}
                    icon="page"
                    title={s.title}
                    section={s.section}
                  />
                ))}
          </div>
        </div>

        <div className="search-footer" aria-hidden>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={11} />
            </kbd>{" "}
            open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </dialog>
  );
}

interface OptionProps {
  id: string;
  index: number;
  active: boolean;
  onHover: (index: number) => void;
  onChoose: () => void;
  icon: "page" | "section";
  title: string;
  page?: string | undefined;
  snippet?: Segment[];
  section: string;
}

/**
 * One result. Options follow the combobox pattern: focus stays in the input and the active option
 * is announced through aria-activedescendant, so options themselves are not focusable.
 */
function Option({
  id,
  index,
  active,
  onHover,
  onChoose,
  icon,
  title,
  page,
  snippet,
  section,
}: OptionProps) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the combobox input
    // biome-ignore lint/a11y/useFocusableInteractive: aria-activedescendant pattern, focus stays in the input
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-index={index}
      className="search-option"
      onMouseMove={() => onHover(index)}
      onClick={onChoose}
    >
      <span className="hit-icon" aria-hidden>
        {icon === "page" ? <FileText size={16} /> : <Hash size={16} />}
      </span>
      <span className="hit-body">
        <span className="hit-title">
          {title}
          {page ? <span className="hit-page"> · {page}</span> : null}
        </span>
        {snippet ? <Snippet segments={snippet} /> : null}
      </span>
      <span className="hit-section">{section}</span>
    </div>
  );
}

function Snippet({ segments }: { segments: Segment[] }) {
  let offset = 0;
  return (
    <span className="hit-snippet">
      {segments.map((seg) => {
        const key = offset;
        offset += seg.text.length;
        return seg.match ? <mark key={key}>{seg.text}</mark> : <span key={key}>{seg.text}</span>;
      })}
    </span>
  );
}
