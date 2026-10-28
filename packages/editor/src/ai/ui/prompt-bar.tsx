"use client";

import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  SunSpinner,
  Tooltip,
} from "@desyn/ui";
import {
  ArrowUp,
  Camera,
  ChevronDown,
  Cloud,
  Coins,
  ImagePlus,
  Laptop,
  Paperclip,
  Square,
  Stamp,
  X,
} from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEditorStore } from "../../context.tsx";
import { executionLabel } from "../core/execution.ts";
import { aiLocked } from "../core/gating.ts";
import {
  creditsFor,
  type DockMode,
  formatCredits,
  MODES,
  modeInfo,
  parseSlash,
  type SlashCommand,
  slashSuggestions,
} from "../core/prompt.ts";
import { isActive } from "../core/reduce.ts";
import { useAi, useAiSession, useAiShallow } from "./hooks.ts";
import { COMMAND_ICONS } from "./icons.tsx";

function ModeMenu({ disabled }: { disabled: boolean }) {
  const session = useAiSession();
  const mode = useAi((s) => s.prompt.mode);
  const hasSelection = useEditorStore((s) => s.selection.length > 0);
  const canEdit = useEditorStore((s) => s.mode === "edit");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-fg/6 pr-2 pl-2.5 text-xs font-medium text-fg-secondary outline-none transition-colors hover:bg-fg/10 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-fg/10"
          aria-label={`Mode: ${modeInfo(mode).label}`}
        >
          {modeInfo(mode).label}
          <ChevronDown className="size-3.5 text-fg-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-72">
        <DropdownMenuLabel>What should the AI do?</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode} onValueChange={(v) => session.setMode(v as DockMode)}>
          {MODES.map((m) => {
            const unavailable =
              (m.id === "edit-selection" && !hasSelection) || (m.agent !== "critique" && !canEdit);
            return (
              <DropdownMenuRadioItem
                key={m.id}
                value={m.id}
                disabled={unavailable}
                className="h-auto py-1.5"
              >
                <span className="flex flex-col">
                  <span className="text-sm text-fg">{m.label}</span>
                  <span className="text-2xs text-fg-muted">
                    {m.id === "edit-selection" && !hasSelection ? "Select layers first" : m.hint}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ExecutionMenu() {
  const session = useAiSession();
  const { current, choices } = useAiShallow((s) => s.execution);
  if (choices.length < 2 && current.where === "server") return null;
  const Icon = current.where === "browser" ? Laptop : Cloud;
  const chip = (
    <span className="inline-flex h-7 max-w-44 items-center gap-1.5 rounded-full px-2 text-2xs text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg-secondary">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{executionLabel(current)}</span>
    </span>
  );
  if (choices.length < 2) {
    return (
      <Tooltip content="This run uses a local model on your machine">
        <button
          type="button"
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {chip}
        </button>
      </Tooltip>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Runs on ${executionLabel(current)}`}
        >
          {chip}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-72">
        <DropdownMenuLabel>Where the AI runs</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current.where}
          onValueChange={(v) => session.setPreferExecution(v as "browser" | "server")}
        >
          {choices.map((c) => (
            <DropdownMenuRadioItem key={c.where} value={c.where} className="h-auto py-1.5">
              <span className="flex flex-col">
                <span className="text-sm text-fg">{executionLabel(c)}</span>
                <span className="text-2xs text-fg-muted">
                  {c.where === "server"
                    ? "Runs in the cloud with your plan's credits"
                    : "Runs in this tab with keys that never leave your browser. No credits."}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Credits the next send is expected to use (server runs), or "free" for browser runs. */
function EstimateChip({ text }: { text: string }) {
  const where = useAi((s) => s.execution.current.where);
  const mode = useAi((s) => s.prompt.mode);
  const estimate = useAi((s) => s.estimates[modeInfo(s.prompt.mode).agent]);
  const remaining = useAi((s) => s.credits?.remaining ?? null);
  const throttled = useAi((s) => s.credits?.throttled ?? false);
  const slash = parseSlash(text);
  let label: string | null = null;
  if (slash?.command.credits) label = `~${formatCredits(creditsFor(slash.command.credits))}`;
  else if (!slash && where === "server" && estimate !== undefined)
    label = `up to ${formatCredits(estimate)}`;
  else if (!slash && where === "browser") label = "free";
  if (!label) return null;
  const tip = throttled
    ? "You are past this month's credits. Requests are slowed down, never billed extra."
    : remaining !== null
      ? `${remaining} credits left this month · ${modeInfo(mode).label}`
      : modeInfo(mode).label;
  return (
    <Tooltip content={tip}>
      <button
        type="button"
        aria-label={`Estimate: ${label}`}
        className={cn(
          "inline-flex h-7 shrink-0 cursor-default items-center gap-1 rounded-full px-2 text-2xs text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring",
          throttled && "text-accent-text",
        )}
      >
        <Coins className="size-3" aria-hidden />
        {label}
      </button>
    </Tooltip>
  );
}

function SlashMenu({
  items,
  active,
  onPick,
  onHover,
}: {
  items: SlashCommand[];
  active: number;
  onPick: (c: SlashCommand) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div
      id="ai-slash-menu"
      role="listbox"
      aria-label="Commands"
      className="dsn-ai-enter absolute inset-x-0 bottom-[calc(100%+8px)] max-h-80 overflow-y-auto rounded-card border border-line-subtle bg-surface-1/[0.97] p-1 shadow-popover backdrop-blur-[20px] backdrop-saturate-[1.2]"
    >
      {items.length === 0 ? (
        <p className="px-3 py-2 text-xs text-fg-muted">No command matches.</p>
      ) : (
        items.map((c, i) => {
          const Icon = COMMAND_ICONS[c.id];
          return (
            <div
              key={c.id}
              id={`ai-slash-${c.id}`}
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(c);
              }}
              onMouseEnter={() => onHover(i)}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-[8px] px-2.5 py-2 text-sm",
                i === active ? "bg-fg/8 text-fg" : "text-fg-secondary",
              )}
            >
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-[7px] bg-fg/[0.04]",
                  i === active ? "bg-accent-tint text-accent" : "bg-fg/4 text-fg-muted",
                )}
                aria-hidden
              >
                {Icon ? <Icon className="size-3.5" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-fg">/{c.id}</span>
                  <span className="truncate text-2xs text-fg-placeholder">{c.args}</span>
                </span>
                <span className="block truncate text-xs text-fg-muted">{c.description}</span>
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

function Attachments() {
  const session = useAiSession();
  const attachments = useAi((s) => s.prompt.attachments);
  if (attachments.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5 px-3 pt-2.5" aria-label="Attachments">
      {attachments.map((a) => (
        <li
          key={a.id}
          className={cn(
            "group relative flex h-9 items-center gap-2 rounded-[9px] border bg-surface-2/80 pr-1 pl-1 text-xs",
            a.status === "failed" ? "border-danger/50" : "border-line-subtle",
          )}
          title={a.error ?? a.name}
        >
          <span className="relative size-7 overflow-hidden rounded-[6px]">
            <img src={a.previewUrl} alt="" className="size-full object-cover" />
            {a.status === "uploading" ? (
              <span className="absolute inset-0 grid place-items-center bg-black/45">
                <SunSpinner size={12} label="Uploading" />
              </span>
            ) : null}
          </span>
          <span className="max-w-28 truncate text-fg-secondary">
            {a.kind === "snapshot" ? "Snapshot" : a.name}
          </span>
          <IconButton
            label={`Remove ${a.name}`}
            size="xs"
            tooltip={false}
            onClick={() => session.removeAttachment(a.id)}
          >
            <X />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

/** The prompt bar: mode, text with slash commands, attachments, brand toggle, estimate, send / stop. */
export function PromptBar({ autoFocus = false }: { autoFocus?: boolean }) {
  const session = useAiSession();
  const text = useAi((s) => s.prompt.text);
  const mode = useAi((s) => s.prompt.mode);
  const sending = useAi((s) => s.sending);
  const brandKit = useAi((s) => s.brandKit);
  const brand = useAi((s) => s.prompt.brand);
  const account = useAi((s) => s.account);
  const running = useAi((s) =>
    s.turns.some((t) => (t.run && isActive(t.run)) || t.media?.status === "running"),
  );
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const compact = useEditorStore((s) => s.compact);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const suggestions = useMemo(
    () => (menuClosed ? null : slashSuggestions(text)),
    [text, menuClosed],
  );
  const locked = aiLocked(account);

  useEffect(() => {
    const focus = () => textarea.current?.focus();
    window.addEventListener("desyn:ai-focus", focus);
    if (autoFocus) focus();
    return () => window.removeEventListener("desyn:ai-focus", focus);
  }, [autoFocus]);

  // The highlighted command stays within the current suggestions as the list narrows.
  const activeIndex = suggestions?.length ? Math.min(active, suggestions.length - 1) : 0;

  const pick = (c: SlashCommand) => {
    session.setText(`/${c.id} `);
    setMenuClosed(true);
    textarea.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions && suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setActive((activeIndex + d + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pick(suggestions[activeIndex] as SlashCommand);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuClosed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void session.submit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      textarea.current?.blur();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    session.addFiles(files);
  };

  const info = modeInfo(mode);
  const placeholder = !canEdit
    ? "Ask the AI to critique this design…"
    : locked
      ? "Ask desyn to design, edit or critique…"
      : compact
        ? info.placeholder
        : `${info.placeholder}   Type / for tools`;
  // A half-typed command ("/", "/re") is not a prompt yet.
  const partialCommand = text.trim().startsWith("/") && !parseSlash(text);
  const canSend = text.trim().length > 0 && !sending && !partialCommand;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for image files; keyboard users attach through the Attach menu
    <div
      className={cn(
        "relative rounded-[18px] border border-line-subtle bg-surface-1/[0.92] shadow-popover backdrop-blur-[20px] backdrop-saturate-[1.2] transition-shadow duration-300",
        "focus-within:border-accent/30 focus-within:shadow-[var(--shadow-popover)]",
        running && "dsn-ai-running",
      )}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files];
        if (files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        session.addFiles(files);
      }}
    >
      {suggestions ? (
        <SlashMenu items={suggestions} active={activeIndex} onPick={pick} onHover={setActive} />
      ) : null}
      <Attachments />
      <textarea
        ref={textarea}
        value={text}
        onChange={(e) => {
          session.setText(e.target.value);
          setMenuClosed(false);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        rows={1}
        placeholder={placeholder}
        aria-label="Ask the AI"
        aria-autocomplete="list"
        aria-controls={suggestions ? "ai-slash-menu" : undefined}
        aria-activedescendant={
          suggestions?.[activeIndex] ? `ai-slash-${suggestions[activeIndex]?.id}` : undefined
        }
        className="block max-h-40 min-h-[44px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[14px] leading-6 text-fg outline-none placeholder:text-fg-placeholder [field-sizing:content]"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        <ModeMenu disabled={false} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label="Attach" size="sm" tooltip="Attach an image or a snapshot">
              <Paperclip />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-60">
            <DropdownMenuItem icon={<ImagePlus />} onSelect={() => file.current?.click()}>
              Upload images…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Camera />} onSelect={() => void session.addSnapshot()}>
              Snapshot of the selection
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input
          ref={file}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            session.addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        {brandKit ? (
          <IconButton
            label={brand ? `Following ${brandKit.name}` : `Not following ${brandKit.name}`}
            tooltip={
              brand ? `Follows your brand kit “${brandKit.name}”` : "Brand kit off for this request"
            }
            size="sm"
            aria-pressed={brand}
            onClick={() => session.setBrand(!brand)}
          >
            <Stamp />
          </IconButton>
        ) : null}
        <div className="ml-auto flex min-w-0 items-center gap-0.5">
          <ExecutionMenu />
          <EstimateChip text={text} />
          {running ? (
            <IconButton
              label="Stop"
              variant="secondary"
              shape="round"
              size="md"
              tooltip="Stop"
              onClick={() => void session.stopAll()}
            >
              <Square className="fill-current" />
            </IconButton>
          ) : (
            <IconButton
              label="Send"
              variant="primary"
              shape="round"
              size="md"
              tooltip={false}
              disabled={!canSend}
              loading={sending}
              onClick={() => void session.submit()}
            >
              <ArrowUp strokeWidth={2.25} />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}
