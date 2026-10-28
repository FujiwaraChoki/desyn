import { makeTransaction } from "@desyn/doc-ops";
import {
  createDesign as createDesignBase,
  type Design,
  type Id,
  type Node,
  type Op,
} from "@desyn/schema";

export {
  createFrame,
  createGroup,
  createImage,
  createLine,
  createPath,
  createRect,
  createText,
  type Design,
} from "@desyn/schema";

/** A fresh social post design and its page id. */
export function createDesign(): { design: Design; page: Id } {
  const design = createDesignBase("social-post");
  const page = (design.nodes.root as Node & { children: Id[] }).children[0] as Id;
  return { design, page };
}

export function makeTx(ops: Op[]) {
  return makeTransaction(ops, "Test");
}
