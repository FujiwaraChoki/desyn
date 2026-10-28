"use client";

import { Avatar, Button, cn, Kbd } from "@desyn/ui";
import { ArrowUp, AtSign } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { MentionableMember } from "../backend.ts";
import { useCollab } from "../state.ts";
import {
  filterCandidates,
  insertMention,
  type MentionQuery,
  mentionQuery,
  mentionsInBody,
} from "./mentions.ts";

const cache = new WeakMap<object, Promise<MentionableMember[]>>();

/** Workspace members that can be @mentioned (loaded once per editor). */
export function useMentionable(): MentionableMember[] {
  const { backend } = useCollab();
  const [members, setMembers] = useState<MentionableMember[]>([]);
  useEffect(() => {
    let alive = true;
    let p = cache.get(backend);
    if (!p) {
      const loading = backend.comments.mentionable().catch(() => {
        // Not cached: a transient failure (offline, session still starting) retries next time.
        cache.delete(backend);
        return [] as MentionableMember[];
      });
      p = loading;
      cache.set(backend, loading);
    }
    void p.then((m) => {
      if (alive) setMembers(m);
    });
    return () => {
      alive = false;
    };
  }, [backend]);
  return members;
}

export interface ComposerProps {
  placeholder: string;
  submitLabel: string;
  /** Initial text (editing). */
  initial?: string;
  initialMentions?: MentionableMember[];
  autoFocus?: boolean;
  compact?: boolean;
  onSubmit: (body: string, mentions: string[]) => Promise<boolean>;
  onCancel?: () => void;
}

/**
 * Comment text box with @mention autocomplete (workspace members), Enter to send, Shift+Enter for a new
 * line, Escape to cancel. The mentioned ids sent are the picked members still named in the text.
 */
export function Composer({
  placeholder,
  submitLabel,
  initial = "",
  initialMentions = [],
  autoFocus,
  compact,
  onSubmit,
  onCancel,
}: ComposerProps) {
  const members = useMentionable();
  const [text, setText] = useState(initial);
  const [picked, setPicked] = useState<MentionableMember[]>(initialMentions);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  /** Caret to restore right after React writes a programmatic text change (before the next keystroke). */
  const pendingCaret = useRef<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [listPos, setListPos] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const listId = useId();

  const options = useMemo(
    () => (query ? filterCandidates(members, query.query, 6) : []),
    [members, query],
  );
  const open = query !== null && options.length > 0;

  // The suggestions float above everything (cards and panels clip their content): fixed, under the box or
  // above it when there is no room below.
  useLayoutEffect(() => {
    if (!open) {
      setListPos(null);
      return;
    }
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    setListPos(
      below > 230 || below > r.top
        ? { left: r.left, width: r.width, top: r.bottom + 4 }
        : { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 4 },
    );
  }, [open]);

  useEffect(() => {
    if (!autoFocus) return;
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  // Grow with the content up to a few lines; restore the caret after programmatic edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the text changes
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    const caret = pendingCaret.current;
    if (caret !== null) {
      pendingCaret.current = null;
      el.focus();
      el.setSelectionRange(caret, caret);
    }
  }, [text]);

  const refreshQuery = (value: string, caret: number) => {
    const q = mentionQuery(value, caret);
    setQuery(q);
    setActive(0);
  };

  const pick = (m: MentionableMember) => {
    const el = area.current;
    if (!el || !query) return;
    const next = insertMention(text, query, el.selectionStart, m.name);
    setText(next.text);
    setPicked((p) => (p.some((x) => x.id === m.id) ? p : [...p, m]));
    setQuery(null);
    pendingCaret.current = next.caret;
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const ok = await onSubmit(body, mentionsInBody(body, picked));
      if (ok) {
        setText("");
        setPicked([]);
      }
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % options.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const m = options[active];
        if (m) pick(m);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  const startMention = () => {
    const el = area.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = text.slice(0, caret);
    const prefix = before && !/\s$/.test(before) ? " @" : "@";
    const next = before + prefix + text.slice(caret);
    setText(next);
    const at = caret + prefix.length;
    pendingCaret.current = at;
    refreshQuery(next, at);
  };

  return (
    <div className="relative" ref={box}>
      <div
        className={cn(
          "rounded-[10px] border border-line bg-surface-2 transition-colors focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/25",
          compact ? "p-1.5" : "p-2",
        )}
      >
        <textarea
          ref={area}
          value={text}
          rows={1}
          maxLength={5000}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            refreshQuery(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onClick={(e) => refreshQuery(text, e.currentTarget.selectionStart)}
          onBlur={() => setTimeout(() => setQuery(null), 120)}
          className="block w-full resize-none bg-transparent px-1 py-0.5 text-[13px] leading-5 text-fg outline-none placeholder:text-fg-muted"
        />
        <div className="mt-1 flex items-center gap-1">
          {members.length > 0 ? (
            <button
              type="button"
              aria-label="Mention someone"
              onMouseDown={(e) => e.preventDefault()}
              onClick={startMention}
              className="grid size-7 place-items-center rounded-[6px] text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg"
            >
              <AtSign className="size-3.5" />
            </button>
          ) : null}
          <span
            className={cn(
              "ml-1 hidden text-[11px] whitespace-nowrap text-fg-muted",
              !onCancel && !compact && "sm:inline",
            )}
          >
            <Kbd size="sm">Enter</Kbd> to send
          </span>
          <div className="flex-1" />
          {onCancel ? (
            <Button variant="ghost" size="sm" className="h-7" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            className="h-7"
            disabled={!text.trim()}
            loading={busy}
            aria-label={submitLabel}
            onClick={() => void submit()}
            leadingIcon={<ArrowUp />}
          >
            {compact ? null : submitLabel}
          </Button>
        </div>
      </div>
      {open && listPos
        ? createPortal(
            <div
              id={listId}
              role="listbox"
              aria-label="People"
              className="fixed z-[1300] overflow-hidden rounded-[10px] border border-line bg-surface-1/95 p-1 text-fg shadow-popover backdrop-blur-xl"
              style={listPos}
            >
              {options.map((m, i) => (
                <div
                  key={m.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(m)}
                  onKeyDown={() => {}}
                  className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] text-fg aria-selected:bg-accent-tint"
                >
                  <Avatar name={m.name} src={m.image} size="xs" />
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  <span className="text-[11px] capitalize text-fg-muted">{m.role}</span>
                </div>
              ))}
            </div>,
            portalTarget(box.current),
          )
        : null}
    </div>
  );
}

/** Portals stay inside a themed scope (ThemeScope) so they keep its colors; otherwise the body. */
function portalTarget(el: HTMLElement | null): HTMLElement {
  const scope = el?.closest<HTMLElement>("[data-theme]");
  return scope && scope !== document.documentElement ? scope : document.body;
}
