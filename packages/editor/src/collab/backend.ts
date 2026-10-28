import type { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { ShareArg } from "../sync/wire.ts";
import { type Live, liveQuery } from "./live.ts";

/*
 * Backend surface of collaboration (presence, comments, share links, members, versions). Convex functions are
 * referenced by name (see src/sync/convex-transport.ts for why); shapes follow the functions in
 * convex/designs and convex/accounts. Components talk to this interface only, so tests script it directly.
 */

// ---------------------------------------------------------------------------------------------------------
// Shapes

export interface PresenceCursor {
  x: number;
  y: number;
  pageId?: string;
}

export interface PresenceViewport {
  x: number;
  y: number;
  zoom: number;
  width?: number;
  height?: number;
  pageId?: string;
}

export interface PresenceEditing {
  nodeIds: string[];
  kind: "text" | "ai" | "transform";
  label?: string;
}

/** `presence.list` row. */
export interface PresenceRow {
  sessionId: string;
  userId: string;
  name: string;
  image: string | null;
  color: string;
  cursor: PresenceCursor | null;
  selection: string[];
  viewport: PresenceViewport | null;
  drag: string | null;
  editing: PresenceEditing | null;
  expiresAt: number;
  updatedAt: number;
}

export interface HeartbeatArgs {
  sessionId: string;
  cursor?: PresenceCursor | null;
  selection?: string[];
  viewport?: PresenceViewport | null;
  editing?: PresenceEditing | null;
}

export interface Person {
  id: string;
  name: string;
  image: string | null;
}

export interface CommentView {
  id: string;
  threadId: string | null;
  body: string;
  deleted: boolean;
  author: Person;
  mentions: string[];
  createdAt: number;
  editedAt: number | null;
}

/** `comments.list` item: a thread root with its replies and its anchor. */
export interface CommentThread extends CommentView {
  nodeId: string | null;
  pageId: string | null;
  x: number | null;
  y: number | null;
  resolved: boolean;
  resolvedBy: Person | null;
  resolvedAt: number | null;
  lastActivityAt: number;
  replies: CommentView[];
}

export interface MentionableMember extends Person {
  role: string;
}

export interface NewComment {
  body: string;
  mentions: string[];
  nodeId?: string;
  pageId?: string;
  x?: number;
  y?: number;
}

export type SharePermission = "view" | "comment" | "edit";

export interface ShareLink {
  id: string;
  token: string;
  url: string;
  permission: SharePermission;
  hasPassword: boolean;
  expiresAt: number | null;
  expired: boolean;
  label: string | null;
  createdBy: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface SetShareArgs {
  shareId?: string;
  permission: SharePermission;
  /** New password; null removes it; omitted keeps it. */
  password?: string | null;
  /** Expiry (ms epoch); null removes it; omitted keeps it. */
  expiresAt?: number | null;
  label?: string;
}

export type WorkspaceRole = "owner" | "admin" | "editor" | "commenter" | "viewer";

export interface Member {
  userId: string;
  role: WorkspaceRole;
  name: string;
  email: string | null;
  image: string | null;
  isYou: boolean;
  joinedAt: number;
}

export interface InviteResult {
  invited: string[];
  skipped: { email: string; reason: "already_member" }[];
}

export interface VersionRow {
  id: string;
  name: string;
  seq: number;
  status: "pending" | "ready" | "failed";
  auto: boolean;
  pageCount: number;
  createdBy: string;
  createdByName: string | null;
  createdAt: number;
  error: string | null;
}

/** `designs.get` (subset the collaboration UI reads). */
export interface DesignSummary {
  id: string;
  key: string;
  name: string;
  workspaceId: string;
  ownerId: string;
  permission: "view" | "comment" | "edit" | "manage";
  via: "member" | "share";
  shareCount: number;
}

/** `workspaces.get` (subset). */
export interface WorkspaceView {
  id: string;
  name: string;
  kind: "personal" | "team";
  role: WorkspaceRole;
  plan: "free" | "pro" | "selfhost";
  planName: string;
  memberCount: number;
  teamsEnabled: boolean;
}

/** `profiles.me` (subset): the signed-in user's plan and resolved features. */
export interface AccountView {
  userId: string;
  email: string;
  name: string;
  image: string | null;
  plan: "free" | "pro" | "selfhost";
  planName: string;
  edition: "hosted" | "selfhost";
  features: Record<string, boolean>;
}

export interface AutosaveResult {
  versionId: string | null;
  /** Why nothing was saved: unchanged since the last autosave, too soon, or the plan has no version history. */
  skipped: "unchanged" | "recent" | "unavailable" | null;
}

export interface CollabBackend {
  presence: {
    heartbeat(
      args: HeartbeatArgs,
    ): Promise<{ color: string; expiresAt: number; intervalMs: number; live?: boolean }>;
    leave(sessionId: string): Promise<void>;
    list(): Live<PresenceRow[]>;
  };
  comments: {
    list(includeResolved: boolean): Live<CommentThread[]>;
    mentionable(): Promise<MentionableMember[]>;
    create(c: NewComment): Promise<string>;
    reply(threadId: string, body: string, mentions: string[]): Promise<string>;
    edit(commentId: string, body: string, mentions: string[]): Promise<void>;
    remove(commentId: string): Promise<void>;
    resolve(threadId: string, resolved: boolean): Promise<void>;
  };
  shares: {
    list(): Live<ShareLink[]>;
    set(args: SetShareArgs): Promise<{ shareId: string; token: string; url: string }>;
    revoke(shareId: string): Promise<void>;
  };
  members: {
    list(workspaceId: string): Live<Member[]>;
    invite(
      workspaceId: string,
      emails: string[],
      role: Exclude<WorkspaceRole, "owner">,
    ): Promise<InviteResult>;
  };
  versions: {
    list(): Live<VersionRow[]>;
    create(name: string): Promise<string>;
    rename(versionId: string, name: string): Promise<void>;
    remove(versionId: string): Promise<void>;
    restore(versionId: string): Promise<{ seq: number }>;
    /** Design JSON at the version (for read-only previews). */
    get(versionId: string): Promise<{ design: string; name: string }>;
    autosave(): Promise<AutosaveResult>;
  };
  design(): Live<DesignSummary>;
  workspace(workspaceId: string): Live<WorkspaceView>;
  account(): Live<AccountView | null>;
}

// ---------------------------------------------------------------------------------------------------------
// Convex implementation

type Args = Record<string, unknown>;
const q = <A extends Args, R>(name: string) => makeFunctionReference<"query", A, R>(name);
const m = <A extends Args, R>(name: string) => makeFunctionReference<"mutation", A, R>(name);
const a = <A extends Args, R>(name: string) => makeFunctionReference<"action", A, R>(name);

const refs = {
  heartbeat: m<Args, { color: string; expiresAt: number; intervalMs: number; live?: boolean }>(
    "collab/presence:heartbeat",
  ),
  leave: m<Args, null>("collab/presence:leave"),
  presence: q<Args, PresenceRow[]>("collab/presence:list"),
  comments: q<Args, CommentThread[]>("collab/comments:list"),
  mentionable: q<Args, MentionableMember[]>("collab/comments:mentionable"),
  createComment: m<Args, string>("collab/comments:create"),
  reply: m<Args, string>("collab/comments:reply"),
  editComment: m<Args, null>("collab/comments:edit"),
  deleteComment: m<Args, null>("collab/comments:delete"),
  resolve: m<Args, null>("collab/comments:resolve"),
  listShares: q<Args, ShareLink[]>("designs/designs:listShares"),
  setShare: m<Args, { shareId: string; token: string; url: string }>("designs/designs:setShare"),
  revokeShare: m<Args, null>("designs/designs:revokeShare"),
  members: q<Args, Member[]>("accounts/memberships:list"),
  invite: m<Args, InviteResult>("accounts/invites:create"),
  versions: q<Args, VersionRow[]>("designs/versions:list"),
  createVersion: m<Args, string>("designs/versions:create"),
  renameVersion: m<Args, null>("designs/versions:rename"),
  removeVersion: m<Args, null>("designs/versions:remove"),
  restoreVersion: a<Args, { seq: number }>("designs/versions:restore"),
  getVersion: a<Args, { design: string; name: string }>("designs/versions:get"),
  autosave: m<Args, AutosaveResult>("editor/autosave:autosave"),
  design: q<Args, DesignSummary>("designs/designs:get"),
  workspace: q<Args, WorkspaceView>("accounts/workspaces:get"),
  me: q<Args, AccountView | null>("accounts/profiles:me"),
};

/** Collaboration functions of one design, through the app's Convex client. */
export function createConvexCollabBackend(
  client: ConvexReactClient,
  designId: string,
  share?: ShareArg,
): CollabBackend {
  const s = share ? { share } : {};
  return {
    presence: {
      heartbeat: (args) => client.mutation(refs.heartbeat, { designId, ...args, ...s }),
      leave: async (sessionId) => {
        await client.mutation(refs.leave, { designId, sessionId, ...s });
      },
      list: () => liveQuery(client, refs.presence, { designId, ...s }),
    },
    comments: {
      list: (includeResolved) =>
        liveQuery(client, refs.comments, { designId, includeResolved, ...s }),
      // Share-link visitors cannot list workspace members (the server answers with an empty list).
      mentionable: () =>
        share ? Promise.resolve([]) : client.query(refs.mentionable, { designId }),
      create: (c) => client.mutation(refs.createComment, { designId, ...c, ...s }),
      reply: (threadId, body, mentions) =>
        client.mutation(refs.reply, { threadId, body, mentions, ...s }),
      edit: async (commentId, body, mentions) => {
        await client.mutation(refs.editComment, { commentId, body, mentions, ...s });
      },
      remove: async (commentId) => {
        await client.mutation(refs.deleteComment, { commentId, ...s });
      },
      resolve: async (threadId, resolved) => {
        await client.mutation(refs.resolve, { threadId, resolved, ...s });
      },
    },
    shares: {
      list: () => liveQuery(client, refs.listShares, { designId }),
      set: (args) => client.mutation(refs.setShare, { designId, ...args }),
      revoke: async (shareId) => {
        await client.mutation(refs.revokeShare, { shareId });
      },
    },
    members: {
      list: (workspaceId) => liveQuery(client, refs.members, { workspaceId }),
      invite: (workspaceId, emails, role) =>
        client.mutation(refs.invite, { workspaceId, emails, role }),
    },
    versions: {
      list: () => liveQuery(client, refs.versions, { designId, ...s }),
      create: (name) => client.mutation(refs.createVersion, { designId, name }),
      rename: async (versionId, name) => {
        await client.mutation(refs.renameVersion, { versionId, name });
      },
      remove: async (versionId) => {
        await client.mutation(refs.removeVersion, { versionId });
      },
      restore: (versionId) => client.action(refs.restoreVersion, { versionId }),
      get: (versionId) => client.action(refs.getVersion, { versionId, ...s }),
      autosave: () => client.mutation(refs.autosave, { designId }),
    },
    design: () => liveQuery(client, refs.design, { designId, ...s }),
    workspace: (workspaceId) => liveQuery(client, refs.workspace, { workspaceId }),
    account: () => liveQuery(client, refs.me, {}),
  };
}
