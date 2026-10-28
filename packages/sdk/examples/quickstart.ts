// Create a design, add a headline with the transaction builder, render a preview and export a PDF.
// Run: DESYN_API_KEY=dsk_… [DESYN_API_URL=https://<convex-site>/api/v1] pnpm tsx examples/quickstart.ts
import { writeFile } from "node:fs/promises";
import { DesynClient, TransactionBuilder } from "@desyn/sdk";

const desyn = new DesynClient({
  ...(process.env.DESYN_API_URL ? { baseUrl: process.env.DESYN_API_URL } : {}),
});

const me = await desyn.me();
console.log(`Signed in as ${me.name} (${me.plan}), workspace ${me.workspaceName}`);

const design = await desyn.designs.create({ name: "Quickstart poster", presetId: "poster-a4" });
const page = design.firstPageId as string;

const tx = new TransactionBuilder();
tx.create(page, {
  type: "rect",
  name: "Background",
  role: "background",
  x: 0,
  y: 0,
  width: design.width,
  height: design.height,
  fill: "#0e0d0b",
});
tx.create(page, {
  type: "text",
  name: "Headline",
  role: "headline",
  text: "Design at the speed of light",
  x: 64,
  y: 96,
  width: design.width - 128,
  fontFamily: "Instrument Serif",
  fontSize: 72,
  color: "#ffb02e",
});
const commit = await desyn.designs.commit(design.id, {
  baseSeq: design.seq,
  tx: tx.build("Add headline"),
});
console.log(`Committed seq ${commit.seq}, dropped ${commit.dropped.length} op(s)`);

const preview = await desyn.designs.preview(design.id, { maxSize: 800 });
await writeFile("quickstart-preview.png", preview.bytes);
console.log("Wrote quickstart-preview.png");

const job = await desyn.exports.request(design.id, { format: "pdf" });
const done = await desyn.exports.wait(job.id);
console.log("PDF:", done.files[0]?.url);
