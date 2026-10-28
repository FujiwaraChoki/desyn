import type {
  AccountView,
  CollabBackend,
  CommentThread,
  DesignSummary,
  HeartbeatArgs,
  Member,
  MentionableMember,
  NewComment,
  PresenceRow,
  SetShareArgs,
  ShareLink,
  VersionRow,
  WorkspaceView,
} from "../../src/collab/backend.ts";
import type { Live } from "../../src/collab/live.ts";
import type { ExportBackend, ExportJob, ExportRequestArgs } from "../../src/export/backend.ts";

/** A reactive value tests can change (`set`) while components are subscribed. */
export class Cell<T> implements Live<T> {
  private listeners = new Set<(v: T) => void>();
  constructor(public value: T) {}
  subscribe(onValue: (v: T) => void): () => void {
    this.listeners.add(onValue);
    onValue(this.value);
    return () => this.listeners.delete(onValue);
  }
  set(value: T): void {
    this.value = value;
    for (const l of this.listeners) l(value);
  }
}

/** In-memory collaboration backend recording every call. */
export class FakeCollab implements CollabBackend {
  calls: { fn: string; args: unknown }[] = [];
  rows = new Cell<PresenceRow[]>([]);
  threads = new Cell<CommentThread[]>([]);
  links = new Cell<ShareLink[]>([]);
  versionList = new Cell<VersionRow[]>([]);
  memberList = new Cell<Member[]>([]);
  summary: Cell<DesignSummary>;
  ws: Cell<WorkspaceView>;
  me = new Cell<AccountView | null>(null);
  people: MentionableMember[] = [];
  private n = 0;

  constructor(
    opts: { plan?: WorkspaceView["plan"]; permission?: DesignSummary["permission"] } = {},
  ) {
    this.summary = new Cell<DesignSummary>({
      id: "d1",
      key: "designkey001",
      name: "Poster",
      workspaceId: "ws1",
      ownerId: "user1",
      permission: opts.permission ?? "manage",
      via: "member",
      shareCount: 0,
    });
    this.ws = new Cell<WorkspaceView>({
      id: "ws1",
      name: "Studio",
      kind: "team",
      role: "owner",
      plan: opts.plan ?? "pro",
      planName: "Pro",
      memberCount: 2,
      teamsEnabled: true,
    });
  }

  private log(fn: string, args: unknown) {
    this.calls.push({ fn, args });
  }

  presence = {
    heartbeat: async (args: HeartbeatArgs) => {
      this.log("heartbeat", args);
      return { color: "#4dabf7", expiresAt: Date.now() + 15_000, intervalMs: 5_000 };
    },
    leave: async (sessionId: string) => {
      this.log("leave", sessionId);
    },
    list: () => this.rows,
  };

  comments = {
    list: (_includeResolved: boolean) => this.threads,
    mentionable: async () => this.people,
    create: async (c: NewComment) => {
      this.log("comments.create", c);
      return `thread${++this.n}`;
    },
    reply: async (threadId: string, body: string, mentions: string[]) => {
      this.log("comments.reply", { threadId, body, mentions });
      return `reply${++this.n}`;
    },
    edit: async (commentId: string, body: string, mentions: string[]) => {
      this.log("comments.edit", { commentId, body, mentions });
    },
    remove: async (commentId: string) => {
      this.log("comments.remove", commentId);
    },
    resolve: async (threadId: string, resolved: boolean) => {
      this.log("comments.resolve", { threadId, resolved });
    },
  };

  shares = {
    list: () => this.links,
    set: async (args: SetShareArgs) => {
      this.log("shares.set", args);
      const token = `tok${++this.n}`;
      return { shareId: `share${this.n}`, token, url: `https://app.test/share/${token}` };
    },
    revoke: async (shareId: string) => {
      this.log("shares.revoke", shareId);
    },
  };

  members = {
    list: (_workspaceId: string) => this.memberList,
    invite: async (workspaceId: string, emails: string[], role: string) => {
      this.log("members.invite", { workspaceId, emails, role });
      return { invited: emails, skipped: [] };
    },
  };

  versions = {
    list: () => this.versionList,
    create: async (name: string) => {
      this.log("versions.create", name);
      return `v${++this.n}`;
    },
    rename: async (versionId: string, name: string) => {
      this.log("versions.rename", { versionId, name });
    },
    remove: async (versionId: string) => {
      this.log("versions.remove", versionId);
    },
    restore: async (versionId: string) => {
      this.log("versions.restore", versionId);
      return { seq: 1 };
    },
    get: async (versionId: string): Promise<{ design: string; name: string }> => {
      this.log("versions.get", versionId);
      throw new Error("no snapshot in tests");
    },
    autosave: async () => {
      this.log("versions.autosave", null);
      return { versionId: null, skipped: "unchanged" as const };
    },
  };

  design = () => this.summary;
  workspace = (_id: string) => this.ws;
  account = () => this.me;

  named(fn: string): unknown[] {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args);
  }
}

export class FakeExports implements ExportBackend {
  requests: ExportRequestArgs[] = [];
  jobs = new Map<string, Cell<ExportJob>>();
  accountCell = new Cell<{
    userId: string;
    plan: string;
    edition: "hosted" | "selfhost";
    features: Record<string, boolean>;
  } | null>(null);

  async request(args: ExportRequestArgs): Promise<string> {
    this.requests.push(args);
    const id = `job${this.requests.length}`;
    this.jobs.set(
      id,
      new Cell<ExportJob>({
        id,
        designId: "d1",
        format: args.format,
        pages: args.pages,
        scale: args.scale ?? 1,
        status: "queued",
        files: [],
        error: null,
        attempts: 0,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        expiresAt: null,
      }),
    );
    return id;
  }
  status(id: string) {
    const cell = this.jobs.get(id);
    if (!cell) throw new Error(`unknown job ${id}`);
    return cell;
  }
  recent() {
    return new Cell<ExportJob[]>([]);
  }
  account() {
    return this.accountCell;
  }
  edition() {
    return new Cell<{ edition: "hosted" | "selfhost" }>({ edition: "hosted" });
  }
}
