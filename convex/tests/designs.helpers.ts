import {
  createFrame,
  createGroup,
  createPage,
  createRect,
  type Node,
  newId,
  type Op,
  type Transaction,
} from "@desyn/schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { assembleDesign, type LoadPage } from "../lib/designs_wire";
import { createUser, type TestConvex, type TestUser } from "./harness.helpers";

// Helpers for the designs / assets / collab test suites.

type Role = "admin" | "editor" | "commenter" | "viewer";

export async function workspaceOf(user: TestUser): Promise<Id<"workspaces">> {
  const list = await user.as.query(api.accounts.workspaces.list, {});
  const ws = list[0];
  if (!ws) throw new Error("user has no workspace");
  return ws.id;
}

/** Add an existing user to a workspace with a role (as the invite flow would). */
export async function addMember(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  user: TestUser,
  role: Role,
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("memberships", {
      workspaceId,
      userId: user.userId,
      role,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function memberWithRole(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  role: Role,
): Promise<TestUser> {
  const user = await createUser(t);
  await addMember(t, workspaceId, user, role);
  return user;
}

export function makeTx(ops: Op[], overrides: Partial<Transaction> = {}): Transaction {
  return { id: newId(), label: "Test edit", ops, source: "user", ts: Date.now(), ...overrides };
}

export function rect(parent: string, overrides: Partial<Node> = {}): Node {
  return createRect({ parent, ...(overrides as object) }) as Node;
}

export function group(parent: string, children: string[] = []): Node & { children: string[] } {
  return createGroup({ parent, children }) as Node & { children: string[] };
}

export function frame(parent: string, children: string[] = []): Node & { children: string[] } {
  return createFrame({ parent, children }) as Node & { children: string[] };
}

export function page(overrides: Partial<Node> = {}): Node {
  return createPage(overrides as object) as Node;
}

type Caller = Pick<TestUser["as"], "query">;

/** Load every page of a design and assemble it. */
export async function loadAll(
  caller: Caller,
  designId: Id<"designs">,
  share?: { token: string; password?: string },
): Promise<ReturnType<typeof assembleDesign> & { pages: number }> {
  const pages: LoadPage[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: LoadPage = await caller.query(api.designs.designs.load, {
      designId,
      cursor,
      ...(share ? { share } : {}),
    });
    pages.push(page);
    if (page.isDone) break;
    cursor = page.cursor;
  }
  return { ...assembleDesign(pages), pages: pages.length };
}

/** First page id of a loaded design. */
export function firstPageId(design: { nodes: Record<string, Node> }): string {
  const root = design.nodes.root as Node & { children: string[] };
  const id = root.children[0];
  if (!id) throw new Error("design has no page");
  return id;
}
