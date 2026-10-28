// Upload a local image and place it on the first page of a design as one transaction.
// Run: DESYN_API_KEY=dsk_… pnpm tsx examples/upload-and-place.ts <designId> ./photo.jpg
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { DesynClient, mimeFromName, TransactionBuilder } from "@desyn/sdk";

const [designId, file] = process.argv.slice(2);
if (!designId || !file) throw new Error("usage: upload-and-place.ts <designId> <file>");

const desyn = new DesynClient({
  ...(process.env.DESYN_API_URL ? { baseUrl: process.env.DESYN_API_URL } : {}),
});
const mime = mimeFromName(file);
if (!mime) throw new Error(`unknown file type: ${file}`);

const asset = await desyn.assets.upload(await readFile(file), { name: basename(file), mime });
console.log(`Uploaded ${asset.name} (${asset.width}×${asset.height}), refId ${asset.refId}`);

const { design, seq } = await desyn.designs.load(designId);
const pageId = (design.nodes.root as { children: string[] }).children[0] as string;
const width = 480;
const height = asset.width && asset.height ? Math.round((width * asset.height) / asset.width) : 320;

const tx = new TransactionBuilder().asset([asset.assetRef]);
tx.create(pageId, {
  type: "image",
  name: asset.name,
  role: "photo",
  assetId: asset.refId,
  x: 40,
  y: 40,
  width,
  height,
  fit: "crop",
});
const result = await desyn.designs.commit(designId, { baseSeq: seq, tx: tx.build("Place photo") });
console.log(`Placed at seq ${result.seq}`);
