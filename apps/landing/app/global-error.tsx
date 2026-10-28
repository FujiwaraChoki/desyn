"use client";

import "./globals.css";
import { instrumentSans, instrumentSerif } from "./fonts";

/** Replaces the root layout when it fails, so it brings its own document, styles and theme. */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${instrumentSerif.variable} ${instrumentSans.variable}`}
    >
      <body>
        <title>Something went wrong · Desyn</title>
        <main className="flex min-h-svh items-center px-5">
          <div className="mx-auto max-w-xl text-center">
            <p className="label">Desyn</p>
            <h1 className="mt-5 font-serif text-[clamp(48px,8vw,104px)] leading-[0.95]">
              Lost the <em className="em text-sun-gradient">light.</em>
            </h1>
            <p className="subhead mx-auto mt-6 max-w-md">
              The page failed to load. Try again, or come back in a moment.
            </p>
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <button type="button" onClick={() => retry()} className="btn btn-primary btn-lg">
                Try again
              </button>
              <a href="/" className="btn btn-secondary btn-lg">
                Go home
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
