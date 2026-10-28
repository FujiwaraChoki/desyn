"use client";

import Link from "next/link";

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const digest =
    error instanceof Error && "digest" in error
      ? String((error as Error & { digest?: string }).digest ?? "")
      : "";
  return (
    <section className="flex min-h-[80svh] items-center">
      <div className="container-content text-center">
        <p className="label">Something went wrong</p>
        <h1 className="mt-5 font-serif text-[clamp(48px,7vw,96px)] leading-[0.95]">
          A cloud passed over <em className="em text-sun-gradient">the sun.</em>
        </h1>
        <p className="subhead mx-auto mt-6 max-w-md">
          This part of the page failed to load. Trying again usually fixes it.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <button type="button" onClick={() => retry()} className="btn btn-primary btn-lg">
            Try again
          </button>
          <Link href="/" className="btn btn-secondary btn-lg">
            Go home
          </Link>
        </div>
        {digest ? (
          <p className="mt-8 font-mono text-[12px] text-subtle">Reference {digest}</p>
        ) : null}
      </div>
    </section>
  );
}
