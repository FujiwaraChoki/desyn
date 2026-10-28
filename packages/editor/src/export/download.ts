import { zipSync } from "fflate";

export interface ExportedFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

/** Saves a blob with a file name (object URL + temporary link). */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function clickLink(url: string, name: string, newTab: boolean): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  if (newTab) a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Saves a remote file (export download URL) without leaving the editor. `download` is ignored for
 * cross-origin links, so only presigned S3 URLs that carry an attachment disposition are opened directly;
 * other URLs (Convex file storage on deployments without S3) are fetched into a blob first, and opened in a
 * new tab when the fetch is blocked.
 */
export async function downloadUrl(url: string, name: string): Promise<void> {
  let attachment = false;
  try {
    attachment =
      new URL(url, window.location.href).searchParams
        .get("response-content-disposition")
        ?.startsWith("attachment") === true;
  } catch {
    attachment = false;
  }
  if (attachment) {
    clickLink(url, name, false);
    return;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    downloadBlob(await res.blob(), name);
  } catch {
    clickLink(url, name, true);
  }
}

/**
 * Packs files into one zip. Images and PDFs are already compressed, so entries are stored (level 0) unless
 * `compress` is set (SVG and other text formats shrink a lot).
 */
export function zipFiles(files: readonly ExportedFile[], compress = false): Uint8Array {
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const f of files) entries[f.name] = [f.bytes, { level: compress ? 6 : 0 }];
  return zipSync(entries, { mtime: new Date() });
}

/** One download for the export: the single file, or a zip named after the design. */
export function saveExport(
  files: readonly ExportedFile[],
  zipName: string,
  compress: boolean,
): void {
  const only = files[0];
  if (files.length === 1 && only) {
    downloadBlob(new Blob([only.bytes as BlobPart], { type: only.mime }), only.name);
    return;
  }
  const zip = zipFiles(files, compress);
  downloadBlob(new Blob([zip as BlobPart], { type: "application/zip" }), zipName);
}
