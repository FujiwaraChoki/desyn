import type { Role } from "./validators";

/** Workspace roles from least to most privileged. */
export const ROLES: Role[] = ["viewer", "commenter", "editor", "admin", "owner"];

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, admin: 3, owner: 4 };

export function roleRank(role: Role): number {
  return RANK[role];
}

export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/**
 * Whether `actor` may grant `target` to someone or change someone whose current role is `current`.
 * Owners can do anything except create a second owner (ownership moves via transfer). Admins manage
 * everyone below admin and may grant up to admin. Others cannot manage roles.
 */
export function canManageRole(actor: Role, target: Role, current?: Role): boolean {
  if (target === "owner" || current === "owner") return false;
  if (actor === "owner") return true;
  if (actor === "admin") return current !== "admin" && RANK[target] <= RANK.admin;
  return false;
}

/** Design access levels used by the designs owner, mapped onto workspace roles. */
export type DesignAccessLevel = "view" | "comment" | "edit" | "manage";

export const DESIGN_LEVEL_MIN_ROLE: Record<DesignAccessLevel, Role> = {
  view: "viewer",
  comment: "commenter",
  edit: "editor",
  manage: "admin",
};
