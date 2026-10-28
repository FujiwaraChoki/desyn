"use client";

import {
  Avatar,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Tooltip,
} from "@desyn/ui";
import { Eye } from "lucide-react";
import type { SlotProps } from "../../shell/extensions.ts";
import { useCollab, useCollabStore } from "../state.ts";
import { usePeople } from "./hooks.ts";
import type { PersonPresence } from "./reduce.ts";

const MAX_SHOWN = 4;

/**
 * Collaborator avatars in the top bar (`topbar.presence`). Each ring has the person's cursor color; clicking
 * follows their viewport (click again to stop). More than four people collapse into a "+N" menu.
 */
export function PresenceAvatars(_props: SlotProps) {
  const { store } = useCollab();
  const people = usePeople();
  const following = useCollabStore((s) => s.following);
  if (people.length === 0) return null;

  const toggle = (p: PersonPresence) => {
    const active = p.sessions.some((s) => s.sessionId === following);
    store.setState({ following: active ? null : p.primary.sessionId });
  };
  const shown = people.slice(0, MAX_SHOWN);
  const extra = people.slice(MAX_SHOWN);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add form semantics to the top bar
    <div
      role="group"
      aria-label={`${people.length} ${people.length === 1 ? "person" : "people"} here`}
      className="mr-1 flex items-center pl-1 max-sm:hidden"
    >
      <div className="flex items-center -space-x-1">
        {shown.map((p) => {
          const active = p.sessions.some((s) => s.sessionId === following);
          return (
            <Tooltip
              key={p.key}
              content={
                <span className="flex flex-col">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-fg-muted">
                    {active ? "Following · click to stop" : "Click to follow"}
                  </span>
                </span>
              }
            >
              <button
                type="button"
                aria-pressed={active}
                aria-label={active ? `Stop following ${p.name}` : `Follow ${p.name}`}
                onClick={() => toggle(p)}
                className={cn(
                  "relative rounded-full transition-transform duration-200 ease-out hover:z-10 hover:-translate-y-px focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  active && "z-10",
                )}
              >
                <Avatar name={p.name} src={p.image} size="sm" ring={p.color} />
                {active ? (
                  <span
                    className="absolute -right-0.5 -bottom-0.5 grid size-3.5 place-items-center rounded-full text-[#111] ring-2 ring-surface-1"
                    style={{ background: p.color }}
                  >
                    <Eye className="size-2.5" strokeWidth={2.5} />
                  </span>
                ) : null}
              </button>
            </Tooltip>
          );
        })}
      </div>
      {extra.length > 0 ? (
        <DropdownMenu>
          <Tooltip content={`${extra.length} more`}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`${extra.length} more collaborators`}
                className="ml-1 grid h-6 min-w-6 place-items-center rounded-full bg-surface-3 px-1.5 text-[10px] font-semibold text-fg-secondary ring-2 ring-surface-1 transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
              >
                +{extra.length}
              </button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel>Also here</DropdownMenuLabel>
            {people.map((p) => {
              const active = p.sessions.some((s) => s.sessionId === following);
              return (
                <DropdownMenuItem key={p.key} onSelect={() => toggle(p)}>
                  <Avatar name={p.name} src={p.image} size="xs" ring={p.color} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="text-xs text-fg-muted">{active ? "Following" : "Follow"}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
