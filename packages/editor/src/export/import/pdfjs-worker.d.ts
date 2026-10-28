// The pdf.js worker module is imported on the main thread ("fake worker", see pdf.ts); it has no typings.
declare module "pdfjs-dist/build/pdf.worker.min.mjs" {
  export const WorkerMessageHandler: unknown;
}
