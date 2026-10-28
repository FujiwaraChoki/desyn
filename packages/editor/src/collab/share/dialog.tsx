"use client";

import { can, type FeatureKey, isPlanId } from "@desyn/schema";
import {
  Avatar,
  Badge,
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Input,
  ProBadge,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@desyn/ui";
import {
  Check,
  Clock,
  Code2,
  Copy,
  Link2,
  Lock,
  MoreHorizontal,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import type {
  DesignSummary,
  ShareLink,
  SharePermission,
  WorkspaceRole,
  WorkspaceView,
} from "../backend.ts";
import { copyText } from "../clipboard.ts";
import { errorCode, errorMessage, type LiveState, useLive } from "../live.ts";
import { useCollab } from "../state.ts";
import type { ModalProps } from "../ui.ts";
import { buildEmbedCode, EXPIRY_PRESETS, parseEmails } from "./embed.ts";

const PERMISSIONS: { value: SharePermission; label: string; feature: FeatureKey; hint: string }[] =
  [
    {
      value: "view",
      label: "Can view",
      feature: "share.viewLink",
      hint: "See the design and present it",
    },
    {
      value: "comment",
      label: "Can comment",
      feature: "collab.comments",
      hint: "View and leave comments (signed in)",
    },
    {
      value: "edit",
      label: "Can edit",
      feature: "share.editLink",
      hint: "Change the design (signed in)",
    },
  ];

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  commenter: "Commenter",
  viewer: "Viewer",
};

function planAllows(ws: WorkspaceView | undefined, feature: FeatureKey): boolean | null {
  if (!ws || !isPlanId(ws.plan)) return null;
  return can(ws.plan, feature);
}

function useCopy() {
  const editor = useEditor();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (key: string, text: string, title = "Link copied") => {
    if (await copyText(text)) {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
      editor.notify({ kind: "success", title });
    } else {
      editor.notify({ kind: "error", title: "Couldn't copy", description: text });
    }
  };
  return { copied, copy };
}

function useAction() {
  const editor = useEditor();
  return async <T,>(title: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      const code = errorCode(e);
      editor.notify({
        kind: code === "FEATURE_UNAVAILABLE" ? "info" : "error",
        title: code === "FEATURE_UNAVAILABLE" ? "That needs Desyn Pro" : title,
        description: errorMessage(e),
      });
      return null;
    }
  };
}

function expiryLabel(link: ShareLink): string {
  if (link.expired) return "Expired";
  if (!link.expiresAt) return "Never expires";
  const days = Math.ceil((link.expiresAt - Date.now()) / 86_400_000);
  if (days <= 1) {
    const hours = Math.max(1, Math.ceil((link.expiresAt - Date.now()) / 3_600_000));
    return `Expires in ${hours} h`;
  }
  return `Expires in ${days} days`;
}

// ---------------------------------------------------------------------------------------------------------
// People

function PeopleTab({
  design,
  ws,
}: {
  design: DesignSummary | undefined;
  ws: LiveState<WorkspaceView>;
}) {
  const { backend } = useCollab();
  const editor = useEditor();
  const run = useAction();
  const workspace = ws.data;
  const members = useLive(workspace ? `members:${workspace.id}` : null, () =>
    workspace ? backend.members.list(workspace.id) : null,
  );
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<Exclude<WorkspaceRole, "owner">>("editor");
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseEmails(emails), [emails]);

  if (design?.via === "share") {
    return (
      <EmptyState
        size="sm"
        icon={<Users />}
        title={
          <>
            shared with <em className="text-accent">you</em>
          </>
        }
        description="You opened this design through a link. Only members of its workspace can invite people."
      />
    );
  }
  if (!workspace) {
    return ws.error ? (
      <p className="py-6 text-center text-sm text-fg-muted">{ws.error}</p>
    ) : (
      <div className="flex flex-col gap-3 py-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  const isAdmin = workspace.role === "owner" || workspace.role === "admin";
  const teams = planAllows(workspace, "teams") !== false && workspace.teamsEnabled;
  const roles: { value: Exclude<WorkspaceRole, "owner">; label: string }[] = [
    ...(workspace.role === "owner" ? [{ value: "admin" as const, label: "Admin" }] : []),
    { value: "editor", label: "Editor" },
    { value: "commenter", label: "Commenter" },
    { value: "viewer", label: "Viewer" },
  ];

  const invite = async () => {
    if (parsed.valid.length === 0) return;
    setBusy(true);
    const res = await run("Couldn't send the invites", () =>
      backend.members.invite(workspace.id, parsed.valid.slice(0, 20), role),
    );
    setBusy(false);
    if (!res) return;
    setEmails("");
    const skipped = res.skipped.length;
    editor.notify({
      kind: "success",
      title:
        res.invited.length > 0
          ? `Invited ${res.invited.length} ${res.invited.length === 1 ? "person" : "people"}`
          : "Nobody new to invite",
      ...(skipped > 0
        ? { description: `${skipped} already ${skipped === 1 ? "is a member" : "are members"}.` }
        : {}),
    });
    editor.telemetry("share_invite", { count: res.invited.length, role });
  };

  return (
    <div className="flex flex-col gap-4">
      {workspace.kind === "personal" ? (
        <div className="rounded-card bg-surface-2/60 p-3 text-sm text-fg-secondary">
          <p className="font-medium text-fg">This design is in your personal workspace.</p>
          <p className="mt-0.5 text-[13px]">
            Move it to a team workspace to invite people with a role, or share a link instead.
          </p>
        </div>
      ) : !teams ? (
        <div className="flex items-start gap-2.5 rounded-card bg-accent-wash p-3 text-[13px] text-fg-secondary">
          <ProBadge />
          <span>Inviting teammates with roles is part of Desyn Pro.</span>
        </div>
      ) : isAdmin ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <Textarea
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="Emails, separated by commas"
              aria-label="Email addresses to invite"
              rows={1}
              className="min-h-9 flex-1 resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void invite();
                }
              }}
            />
            <Select
              options={roles}
              value={role}
              onValueChange={setRole}
              aria-label="Role"
              className="sm:w-36"
            />
            <Button
              variant="primary"
              leadingIcon={<UserPlus />}
              loading={busy}
              disabled={parsed.valid.length === 0}
              onClick={() => void invite()}
            >
              Invite
            </Button>
          </div>
          {parsed.invalid.length > 0 ? (
            <p className="text-xs text-danger">
              Not an email address: {parsed.invalid.slice(0, 3).join(", ")}
            </p>
          ) : (
            <p className="text-xs text-fg-muted">
              People join <span className="text-fg-secondary">{workspace.name}</span> and see its
              designs with the role you pick. Invites expire after 7 days.
            </p>
          )}
        </div>
      ) : (
        <p className="text-[13px] text-fg-muted">
          Ask an admin of {workspace.name} to invite people, or share a link.
        </p>
      )}

      <div>
        <p className="mb-1 text-[11px] font-medium text-fg-muted">People with access</p>
        {!members.data ? (
          <div className="flex flex-col gap-2 py-1">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <ul className="flex max-h-64 flex-col overflow-y-auto">
            {members.data.map((m) => (
              <li key={m.userId} className="flex items-center gap-3 rounded-[8px] px-1 py-1.5">
                <Avatar name={m.name} src={m.image} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg">
                    {m.name}
                    {m.isYou ? <span className="text-fg-muted"> (you)</span> : null}
                  </p>
                  {m.email ? <p className="truncate text-xs text-fg-muted">{m.email}</p> : null}
                </div>
                <span className="text-xs text-fg-secondary">{ROLE_LABEL[m.role]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Links

function PermissionSelect({
  value,
  onChange,
  ws,
  disabled,
}: {
  value: SharePermission;
  onChange: (p: SharePermission) => void;
  ws: WorkspaceView | undefined;
  disabled?: boolean;
}) {
  return (
    <Select
      size="sm"
      aria-label="Link permission"
      value={value}
      {...(disabled ? { disabled } : {})}
      onValueChange={onChange}
      options={PERMISSIONS.map((p) => {
        const allowed = planAllows(ws, p.feature) !== false;
        return {
          value: p.value,
          label: (
            <span className="flex items-center gap-2">
              {p.label}
              {allowed ? null : <ProBadge />}
            </span>
          ),
          textValue: p.label,
          description: p.hint,
          disabled: !allowed,
        };
      })}
      className="w-[148px]"
    />
  );
}

function PasswordEditor({
  onSave,
  onCancel,
  busy,
}: {
  onSave: (password: string) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [pw, setPw] = useState("");
  const valid = pw.length >= 4 && pw.length <= 200;
  return (
    <div className="flex items-center gap-2">
      <Input
        size="sm"
        type="password"
        autoComplete="new-password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder="At least 4 characters"
        aria-label="Link password"
        leading={<Lock className="size-3.5" />}
        className="flex-1"
        onKeyDown={(e) => {
          if (e.key === "Enter" && valid) onSave(pw);
        }}
        autoFocus
      />
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button
        size="sm"
        variant="primary"
        disabled={!valid}
        loading={busy}
        onClick={() => onSave(pw)}
      >
        Set
      </Button>
    </div>
  );
}

function LinkRow({ link, ws }: { link: ShareLink; ws: WorkspaceView | undefined }) {
  const { backend } = useCollab();
  const run = useAction();
  const { copied, copy } = useCopy();
  const [editingPw, setEditingPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const update = async (patch: Omit<Parameters<typeof backend.shares.set>[0], "permission">) => {
    setBusy(true);
    await run("Couldn't update the link", () =>
      backend.shares.set({ shareId: link.id, permission: link.permission, ...patch }),
    );
    setBusy(false);
  };
  return (
    <li className="flex flex-col gap-2 rounded-card bg-surface-2/40 p-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-[8px]",
            link.expired ? "bg-fg/6 text-fg-muted" : "bg-accent-tint text-accent",
          )}
        >
          <Link2 className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] text-fg">{link.label || "Share link"}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-fg-muted">
            <span className={cn(link.expired && "text-danger")}>{expiryLabel(link)}</span>
            {link.hasPassword ? (
              <span className="inline-flex items-center gap-0.5">
                <Lock className="size-3" />
                Password
              </span>
            ) : null}
            {link.lastUsedAt ? (
              <span>Used {new Date(link.lastUsedAt).toLocaleDateString()}</span>
            ) : null}
          </p>
        </div>
        <PermissionSelect
          value={link.permission}
          ws={ws}
          disabled={busy}
          onChange={(permission) => {
            setBusy(true);
            void run("Couldn't change the permission", () =>
              backend.shares.set({ shareId: link.id, permission }),
            ).finally(() => setBusy(false));
          }}
        />
        <IconButton
          label={copied === link.id ? "Copied" : "Copy link"}
          size="sm"
          variant="ghost"
          disabled={link.expired}
          onClick={() => void copy(link.id, link.url)}
        >
          {copied === link.id ? <Check className="text-success" /> : <Copy />}
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label="Link settings" tooltip={false} size="sm" variant="ghost">
              <MoreHorizontal />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem icon={<Lock />} onSelect={() => setEditingPw(true)}>
              {link.hasPassword ? "Change password" : "Add a password"}
            </DropdownMenuItem>
            {link.hasPassword ? (
              <DropdownMenuItem onSelect={() => void update({ password: null })} inset>
                Remove password
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            {EXPIRY_PRESETS.map((p) => (
              <DropdownMenuItem
                key={p.value}
                icon={p.value === "never" ? <Clock /> : undefined}
                inset={p.value !== "never"}
                onSelect={() =>
                  void update({ expiresAt: p.ms === null ? null : Date.now() + p.ms })
                }
              >
                {p.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={<Trash2 />}
              destructive
              onSelect={() =>
                void run("Couldn't revoke the link", () => backend.shares.revoke(link.id))
              }
            >
              Revoke link
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {editingPw ? (
        <PasswordEditor
          busy={busy}
          onCancel={() => setEditingPw(false)}
          onSave={(password) => {
            void update({ password }).then(() => setEditingPw(false));
          }}
        />
      ) : null}
    </li>
  );
}

function NewLinkForm({ ws }: { ws: WorkspaceView | undefined }) {
  const { backend } = useCollab();
  const editor = useEditor();
  const run = useAction();
  const { copy } = useCopy();
  const [permission, setPermission] = useState<SharePermission>("view");
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState("never");
  const [busy, setBusy] = useState(false);
  const passwordOk = !usePassword || (password.length >= 4 && password.length <= 200);

  const create = async () => {
    const preset = EXPIRY_PRESETS.find((p) => p.value === expiry);
    setBusy(true);
    const res = await run("Couldn't create the link", () =>
      backend.shares.set({
        permission,
        ...(usePassword ? { password } : {}),
        ...(preset?.ms ? { expiresAt: Date.now() + preset.ms } : {}),
      }),
    );
    setBusy(false);
    if (!res) return;
    setPassword("");
    setUsePassword(false);
    editor.telemetry("share_link_created", { permission, password: usePassword, expiry });
    await copy(res.shareId, res.url, "Link created and copied");
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-fg-secondary">Anyone with the link</span>
        <PermissionSelect value={permission} onChange={setPermission} ws={ws} />
        <Select
          size="sm"
          aria-label="Link expiry"
          value={expiry}
          onValueChange={setExpiry}
          options={EXPIRY_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
          className="w-[164px]"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Switch
          size="sm"
          checked={usePassword}
          onCheckedChange={setUsePassword}
          label="Require a password"
        />
        {usePassword ? (
          <Input
            size="sm"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 4 characters"
            aria-label="Password for the new link"
            className="min-w-40 flex-1"
          />
        ) : null}
        <div className="flex-1" />
        <Button
          variant="primary"
          size="sm"
          leadingIcon={<Link2 />}
          loading={busy}
          disabled={!passwordOk}
          onClick={() => void create()}
        >
          Create link
        </Button>
      </div>
    </div>
  );
}

function LinksTab({
  design,
  ws,
  links,
}: {
  design: DesignSummary | undefined;
  ws: WorkspaceView | undefined;
  links: LiveState<ShareLink[]>;
}) {
  const designId = useEditorStore((s) => s.designId);
  const { copied, copy } = useCopy();
  const appLink = `${window.location.origin}/design/${encodeURIComponent(designId)}`;
  const canManage = design?.permission === "manage" && design.via === "member";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 rounded-card bg-surface-2/40 p-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-fg">Link for workspace members</p>
          <p className="truncate font-mono text-[11px] text-fg-muted">{appLink}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          leadingIcon={copied === "app" ? <Check className="text-success" /> : <Copy />}
          onClick={() => void copy("app", appLink)}
        >
          Copy
        </Button>
      </div>
      {!canManage ? (
        <p className="text-[13px] text-fg-muted">
          Only people who manage this design can create public links.
        </p>
      ) : (
        <>
          <NewLinkForm ws={ws} />
          {links.error ? (
            <p className="text-[13px] text-danger">{links.error}</p>
          ) : !links.data ? (
            <Skeleton className="h-16 w-full" />
          ) : links.data.length > 0 ? (
            <ul className="flex flex-col gap-2" aria-label="Share links">
              {links.data.map((l) => (
                <LinkRow key={l.id} link={l} ws={ws} />
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Embed

function EmbedTab({
  design,
  ws,
  links,
}: {
  design: DesignSummary | undefined;
  ws: WorkspaceView | undefined;
  links: LiveState<ShareLink[]>;
}) {
  const { backend } = useCollab();
  const run = useAction();
  const { copied, copy } = useCopy();
  const name = useEditorStore((s) => s.doc.design?.name ?? "Desyn design");
  const aspect = useEditorStore((s) => {
    const d = s.doc.design;
    const first = d
      ? (d.nodes.root as { children?: string[] } | undefined)?.children?.[0]
      : undefined;
    const page = first && d ? d.nodes[first] : undefined;
    return page && page.height > 0 ? page.width / page.height : 16 / 9;
  });
  const [mode, setMode] = useState<"responsive" | "fixed">("responsive");
  const [width, setWidth] = useState(800);
  const [busy, setBusy] = useState(false);
  const canManage = design?.permission === "manage" && design.via === "member";
  const embeddable = (links.data ?? []).filter(
    (l) => l.permission === "view" && !l.hasPassword && !l.expired,
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const link = embeddable.find((l) => l.id === chosen) ?? embeddable[0];
  const height = Math.round(width / aspect);

  if (!canManage) {
    return (
      <EmptyState
        size="sm"
        icon={<Code2 />}
        title={
          <>
            embed on your <em className="text-accent">site</em>
          </>
        }
        description="Someone who manages this design can create an embeddable view link."
      />
    );
  }
  if (!links.data) return <Skeleton className="h-40 w-full" />;
  if (!link) {
    return (
      <EmptyState
        size="sm"
        icon={<Code2 />}
        title={
          <>
            embed on your <em className="text-accent">site</em>
          </>
        }
        description="Embeds use a view-only link without a password. Create one to get the code."
        action={
          <Button
            variant="primary"
            leadingIcon={<Link2 />}
            loading={busy}
            disabled={planAllows(ws, "share.viewLink") === false}
            onClick={async () => {
              setBusy(true);
              await run("Couldn't create the link", () =>
                backend.shares.set({ permission: "view", label: "Embed" }),
              );
              setBusy(false);
            }}
          >
            Create embed link
          </Button>
        }
      />
    );
  }
  const code = buildEmbedCode({
    url: link.url,
    title: name,
    size: mode === "responsive" ? { mode, aspect } : { mode, width, height },
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {embeddable.length > 1 ? (
          <Select
            size="sm"
            aria-label="Link to embed"
            value={link.id}
            onValueChange={setChosen}
            options={embeddable.map((l) => ({
              value: l.id,
              label: l.label || `View link · ${new Date(l.createdAt).toLocaleDateString()}`,
            }))}
            className="w-52"
          />
        ) : null}
        <SegmentedControl
          size="sm"
          aria-label="Embed size"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "responsive", label: "Responsive" },
            { value: "fixed", label: "Fixed size" },
          ]}
        />
        {mode === "fixed" ? (
          <span className="flex items-center gap-1.5 text-xs text-fg-muted">
            <Input
              size="sm"
              type="number"
              min={120}
              max={4000}
              value={width}
              onChange={(e) => setWidth(Math.max(120, Math.min(4000, Number(e.target.value) || 0)))}
              aria-label="Embed width"
              className="w-20"
            />
            × {height} px
          </span>
        ) : null}
      </div>
      <pre className="max-h-48 overflow-auto rounded-card border border-line-subtle bg-surface-2 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-fg-secondary">
        {code}
      </pre>
      <div className="flex items-center gap-2">
        <p className="flex-1 text-xs text-fg-muted">
          Visitors see the design read-only. Revoking the link removes the embed.
        </p>
        <Button
          variant="primary"
          size="sm"
          leadingIcon={copied === "embed" ? <Check /> : <Copy />}
          onClick={() => void copy("embed", code, "Embed code copied")}
        >
          Copy code
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------

/** Share dialog (modal `share`): invite people with a role, share links (permission, password, expiry), embed code. */
export function ShareDialog({ close }: ModalProps) {
  const { backend } = useCollab();
  const designId = useEditorStore((s) => s.designId);
  const name = useEditorStore((s) => s.doc.design?.name ?? "");
  const design = useLive(`design:${designId}`, () => backend.design());
  const workspaceId = design.data?.via === "member" ? design.data.workspaceId : null;
  const ws = useLive(workspaceId ? `ws:${workspaceId}` : null, () =>
    workspaceId ? backend.workspace(workspaceId) : null,
  );
  const canManage = design.data?.permission === "manage" && design.data.via === "member";
  const links = useLive(canManage ? `shares:${designId}` : null, () => backend.shares.list());
  const [tab, setTab] = useState("people");

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            share <em className="text-accent">{name || "design"}</em>
          </DialogTitle>
          <DialogDescription>Invite people, create links, or embed the design.</DialogDescription>
        </DialogHeader>
        <DialogBody className="min-h-[min(380px,60dvh)] pb-6">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="people" icon={<Users />}>
                People
              </TabsTrigger>
              <TabsTrigger value="link" icon={<Link2 />}>
                Links
                {links.data && links.data.length > 0 ? (
                  <Badge size="sm" tone="neutral">
                    {links.data.length}
                  </Badge>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="embed" icon={<Code2 />}>
                Embed
              </TabsTrigger>
            </TabsList>
            <TabsContent value="people" className="pt-1">
              <PeopleTab design={design.data} ws={ws} />
            </TabsContent>
            <TabsContent value="link" className="pt-1">
              <LinksTab design={design.data} ws={ws.data} links={links} />
            </TabsContent>
            <TabsContent value="embed" className="pt-1">
              <EmbedTab design={design.data} ws={ws.data} links={links} />
            </TabsContent>
          </Tabs>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
