"use node";

import * as zlib from "node:zlib";

// Snapshot compression for Node actions only (imports node:zlib; never import this from a V8 module).
// zstd when the Node runtime provides it (Node >= 22.15), gzip otherwise. Readers detect the format from the
// magic bytes, so snapshots written by either runtime stay readable.

export type Compression = "zstd" | "gzip";

type ZstdZlib = {
  zstdCompressSync?: (buf: Uint8Array) => Uint8Array;
  zstdDecompressSync?: (buf: Uint8Array) => Uint8Array;
};
const zstd = zlib as unknown as ZstdZlib;

export function zstdAvailable(): boolean {
  return (
    typeof zstd.zstdCompressSync === "function" && typeof zstd.zstdDecompressSync === "function"
  );
}

export function compressJson(
  json: string,
  prefer: Compression = "zstd",
): { bytes: Uint8Array; compression: Compression; ext: "zst" | "gz"; contentType: string } {
  const input = new TextEncoder().encode(json);
  if (prefer === "zstd" && zstdAvailable() && zstd.zstdCompressSync) {
    return {
      bytes: new Uint8Array(zstd.zstdCompressSync(input)),
      compression: "zstd",
      ext: "zst",
      contentType: "application/zstd",
    };
  }
  return {
    bytes: new Uint8Array(zlib.gzipSync(input, { level: 6 })),
    compression: "gzip",
    ext: "gz",
    contentType: "application/gzip",
  };
}

export function decompressToString(bytes: Uint8Array): string {
  const decoder = new TextDecoder();
  if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    if (!zstd.zstdDecompressSync)
      throw new Error("This runtime cannot read zstd snapshots (needs Node >= 22.15)");
    return decoder.decode(zstd.zstdDecompressSync(bytes));
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return decoder.decode(zlib.gunzipSync(bytes));
  return decoder.decode(bytes);
}

export function gzip(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(zlib.gzipSync(bytes, { level: 5 }));
}
