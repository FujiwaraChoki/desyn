"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { api, type Id } from "@/lib/convex-api";
import { bindLocalKeysToUser } from "@/lib/local-keys";
import { usePersistentLocal } from "@/lib/use-local";

export type Me = NonNullable<FunctionReturnType<typeof api.accounts.profiles.me>>;
export type WorkspaceItem = FunctionReturnType<typeof api.accounts.workspaces.list>[number];
export type InstanceConfig = FunctionReturnType<typeof api.accounts.config.get>;

interface AppContextValue {
  me: Me;
  config: InstanceConfig | undefined;
  workspaces: WorkspaceItem[];
  workspace: WorkspaceItem;
  workspaceId: Id<"workspaces">;
  setWorkspaceId: (id: Id<"workspaces">) => void;
  /** Hosted edition with billing configured. */
  billing: boolean;
  /** Editor+ in the current workspace. */
  canEdit: boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

const WORKSPACE_KEY = "desyn-workspace";

/**
 * Signed-in app state shared by every dashboard page: the profile, the instance configuration and
 * the current workspace (remembered per browser, falling back to the user's default).
 */
export function AppProvider({
  me,
  workspaces,
  children,
}: {
  me: Me;
  workspaces: WorkspaceItem[];
  children: ReactNode;
}) {
  // Bound during render (idempotent) so children's effects, such as the editor's AI dock reading
  // local keys on mount, already see the right user.
  bindLocalKeysToUser(me.userId);
  const config = useQuery(api.accounts.config.get, {});
  const [stored, setStored] = usePersistentLocal<string | null>(WORKSPACE_KEY, null);
  const workspace =
    workspaces.find((w) => w.id === stored) ??
    workspaces.find((w) => w.id === me.defaultWorkspaceId) ??
    workspaces[0];

  const value = useMemo<AppContextValue | null>(() => {
    if (!workspace) return null;
    return {
      me,
      config,
      workspaces,
      workspace,
      workspaceId: workspace.id,
      setWorkspaceId: (id) => setStored(id),
      billing: Boolean(config?.billingEnabled),
      canEdit: workspace.role !== "viewer" && workspace.role !== "commenter",
    };
  }, [me, config, workspaces, workspace, setStored]);

  if (!value) return null;
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>.");
  return ctx;
}

/** Same as useApp but null outside the signed-in shell (share/present pages). */
export function useOptionalApp(): AppContextValue | null {
  return useContext(AppContext);
}
