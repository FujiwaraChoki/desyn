// The editor package (packages/editor) is resolved by next.config.ts (turbopack.resolveAlias): its
// own entry when present, a local stand-in otherwise. The web app only relies on this contract.
declare module "@desyn/editor" {
  import type { ComponentType } from "react";
  import type { EditorProps } from "@/lib/editor-contract";
  export const Editor: ComponentType<EditorProps>;
}
