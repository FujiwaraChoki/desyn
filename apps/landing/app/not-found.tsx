import Link from "next/link";
import { Em } from "@/components/site/SectionIntro";

export default function NotFound() {
  return (
    <section className="relative flex min-h-[88svh] items-center overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-[12%] mx-auto h-px max-w-4xl bg-gradient-to-r from-transparent via-sun/70 to-transparent"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-[12%] left-1/2 aspect-[2/1] w-[min(70vw,520px)] -translate-x-1/2 rounded-t-full bg-[radial-gradient(circle_at_50%_100%,rgb(var(--sun-rgb)/0.45),rgb(var(--sun-rgb)/0.08)_55%,transparent_75%)]"
      />
      <div className="container-content relative text-center">
        <p className="label">404</p>
        <h1 className="mt-5 font-serif text-[clamp(56px,9vw,128px)] leading-[0.95] tracking-[-0.02em]">
          The sun has <Em>set</Em> here.
        </h1>
        <p className="subhead mx-auto mt-6 max-w-md">
          This page does not exist, or it moved. Let us get you back into the light.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Link href="/" className="btn btn-primary btn-lg">
            Back to the start
          </Link>
          <Link href="/features" className="btn btn-secondary btn-lg">
            See what Desyn does
          </Link>
        </div>
      </div>
    </section>
  );
}
