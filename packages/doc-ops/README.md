# @desyn/doc-ops

Pure TypeScript operations on Desyn designs: the reference `applyTransaction` (DOCUMENT_MODEL §5), inversion,
composition, the §6 client sync model, tree and geometry queries, transaction builders for every editor / AI action,
and `diffDesigns`. Depends only on `@desyn/schema`. Used by Convex (`designs.commit`), the web / desktop clients
and the AI package.

The exact semantics (drop reasons and their check order, `move` index semantics, normalized `applied` forms, inverse
ops, path rules) are specified in [`spec/fixtures/README.md`](../../spec/fixtures/README.md) and pinned by the 234
conformance fixtures (design, `applied`, `dropped` and the exact inverse) that the Rust core runs too. During review the
TS applier and the Rust core were also compared op for op on ~13,000 random and hostile transactions.

```ts
import { applyTransaction, groupNodes, alignNodes, diffDesigns, rebase } from "@desyn/doc-ops";

const { design, inverse, applied, dropped } = applyTransaction(current, tx);
const tx2 = groupNodes(design, selection, { source: "ai", actor: { runId } });
```

Inputs are never mutated; results share every untouched node / map with the input (structural sharing). Treat
results as immutable values.

## API

**Apply** — `applyTransaction(design, tx, { validateNodes?, inverseId? })`, `applyOps(design, ops)`,
`invert(design, tx)`, `inverseTxId(txId)`, and `ApplySession` (apply ops one by one against one working copy and
inspect the state in between; the builders use it so each op costs O(op) instead of O(design)).

**Compose / sync** — `compose(txs, { id?, label?, coalesce? })`, `coalesceOps(ops)`,
`rebase(confirmed, pending, remote)`, `replayPending`, and the client state helpers `createSyncState(design, seq)`,
`commitLocal`, `acknowledge(state, txId, applied, seq)`, `receiveRemote(state, tx, seq)` (own echoes count as acks).
Sequence numbers are contiguous per design: `acknowledge` only folds `state.seq + 1`; an ack that jumps ahead (other
clients' transactions were ordered first and have not arrived yet) is ignored and the echo from `designOps.since`
confirms the transaction in order, so no remote transaction is skipped.

**Tree** — `getNode`, `children`, `childIds`, `parentOf`, `parentChain`, `pathTo`, `descendants`, `subtree`,
`isAncestor`, `pageOf`, `pages`, `zIndex`, `siblings`, `findNodes`, `documentOrder`, `sortByDocumentOrder`,
`topLevelSelection`, `lowestCommonAncestor`, `cloneSubtree(design, id, { newIds?, parent?, index?, offset?, name? })`.

**Geometry** (no text shaping; rotation + flips about the box center) — `localTransform`,
`worldTransform(design, id, "page" | "canvas")`, `approxBounds`, `boundsOfSelection`, `decompose`, matrix helpers
(`multiply`, `invertMatrix`, `applyToPoint`, `rotate`, `scale`, `translate`), rect helpers.

**Builders** (each returns a `Transaction`; `TxOptions = { id?, label?, source?, actor?, ts? }`):
`groupNodes`, `ungroup`, `wrapInFrame`, `alignNodes(ids, "left"|"center"|"right"|"top"|"middle"|"bottom", { to })`,
`distribute(ids, "horizontal"|"vertical", { spacing? })`, `tidyGrid`, `matchSize`, `bringForward`, `sendBackward`,
`bringToFront` / `toFront`, `sendToBack` / `toBack`, `duplicate(ids, { offset })`, `deleteNodes`, `reparent`,
`setFill`, `setText`, `replaceImage`, `addPage`, `duplicatePage`, `deletePage`, `reorderPages`, `movePage`,
`resizePage(pageId, size, { strategy: "none"|"center"|"scale"|"fill"|"stretch" })`. Builders keep on-page placement
when restructuring and refit derived group bounds; invalid arguments throw `DocOpsError`; legitimate no-ops return a
transaction with empty `ops`. `createdIds(tx)` lists the ids of created subtree roots. `deleteNodes` / `deletePage`
refuse to remove the last page. Builders stay linear in practice (5,000-node pages resize / align / group in tens of
ms).

**Diff** — `diffDesigns(a, b, txOptions?)` / `diffOps(a, b)`: minimal transaction with
`applyTransaction(a, diff).design` canonically equal to `b` (property-tested on thousands of random edits,
including retyped nodes and reorders with the fewest moves).

**Misc** — `reorderMoves(parent, current, target)`, `scaledProps`, `parsePath` / `scalePath` / `serializePath`,
`getAtPath` / `setAtPath`.

## Scripts

```sh
pnpm typecheck
pnpm test            # includes the spec/fixtures conformance runner
pnpm lint
pnpm gen:fixtures    # regenerate spec/fixtures/** from scripts/fixture-*.ts (verifies hand expectations first)
```
