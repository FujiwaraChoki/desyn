// Compile-time proof that the zod schemas and the hand-written contract types agree (checked by `tsc --noEmit`).
import { expect, test } from "vitest";
import type { z } from "zod";
import type * as S from "../src";

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Drops the string index signatures loose objects add (recursively), so only declared keys are compared. */
type DeepKnown<T> = T extends readonly unknown[]
  ? { [K in keyof T]: DeepKnown<T[K]> }
  : T extends object
    ? { [K in keyof T as string extends K ? never : K]: DeepKnown<T[K]> }
    : T;
type Keys<T> = keyof { [K in keyof T as string extends K ? never : K]: true };
/**
 * Data accepted by the schema satisfies the contract type, and both declare exactly the same keys. (The reverse
 * direction is intentionally not required: schemas are stricter, e.g. only the root may have parent: null.)
 */
type Check<Schema extends z.ZodType, T> = [DeepKnown<z.infer<Schema>>] extends [T]
  ? Mutual<Keys<z.infer<Schema>>, Keys<T>>
  : false;
const ok = <T extends true>(_: T) => _;

ok<Check<typeof S.RectNodeSchema, S.RectNode>>(true);
ok<Check<typeof S.EllipseNodeSchema, S.EllipseNode>>(true);
ok<Check<typeof S.PolygonNodeSchema, S.PolygonNode>>(true);
ok<Check<typeof S.StarNodeSchema, S.StarNode>>(true);
ok<Check<typeof S.LineNodeSchema, S.LineNode>>(true);
ok<Check<typeof S.PathNodeSchema, S.PathNode>>(true);
ok<Check<typeof S.FrameNodeSchema, S.FrameNode>>(true);
ok<Check<typeof S.GroupNodeSchema, S.GroupNode>>(true);
ok<Check<typeof S.BooleanNodeSchema, S.BooleanNode>>(true);
ok<Check<typeof S.TextNodeSchema, S.TextNode>>(true);
ok<Check<typeof S.ImageNodeSchema, S.ImageNode>>(true);
ok<Check<typeof S.VideoNodeSchema, S.VideoNode>>(true);
ok<Check<typeof S.AudioNodeSchema, S.AudioNode>>(true);
ok<Check<typeof S.ChartNodeSchema, S.ChartNode>>(true);
ok<Check<typeof S.TableNodeSchema, S.TableNode>>(true);
ok<Check<typeof S.QrNodeSchema, S.QrNode>>(true);
ok<Check<typeof S.SvgNodeSchema, S.SvgNode>>(true);
ok<Check<typeof S.FillSchema, S.Fill>>(true);
ok<Check<typeof S.EffectSchema, S.Effect>>(true);
ok<Check<typeof S.StrokeSchema, S.Stroke>>(true);
ok<Check<typeof S.TextStyleSchema, S.TextStyle>>(true);
ok<Check<typeof S.ParagraphStyleSchema, S.ParagraphStyle>>(true);
ok<Check<typeof S.AnimationSchema, S.Animation>>(true);
ok<Check<typeof S.AssetRefSchema, S.AssetRef>>(true);
ok<Check<typeof S.AutoLayoutSchema, S.AutoLayout>>(true);
ok<Check<typeof S.ImageAdjustSchema, S.ImageAdjust>>(true);

test("schema and contract types agree (compile-time)", () => {
  expect(true).toBe(true);
});
