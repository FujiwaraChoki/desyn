import { ArrowRight } from "lucide-react";
import { SELF_HOST_DOCS_URL, SIGNUP_URL } from "@/lib/site";

const LINE_ONE = "design at the";
const LINE_TWO = "speed of";

function Chars({ text, offset }: { text: string; offset: number }) {
  return (
    <>
      {text.split("").map((ch, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static text, order never changes.
          key={i}
          className="hero-char"
          style={{ "--i": offset + i } as React.CSSProperties}
        >
          {ch === " " ? " " : ch}
        </span>
      ))}
    </>
  );
}

export function Hero() {
  const lightDelay = (LINE_ONE.length + LINE_TWO.length) * 45 + 220;
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="flex flex-col items-center px-5 text-center">
        <p className="label hero-fade text-fg/70" style={{ "--d": "60ms" } as React.CSSProperties}>
          The source-available Canva alternative
        </p>

        <h1
          id="hero-title"
          aria-label="design at the speed of light."
          className="display mt-5 max-w-[14ch] text-fg md:mt-7"
        >
          <span aria-hidden="true" className="block">
            <Chars text={LINE_ONE} offset={0} />
          </span>
          <span aria-hidden="true" className="block">
            <Chars text={LINE_TWO} offset={LINE_ONE.length} />
            <span
              className="hero-char"
              style={{ "--i": LINE_ONE.length + LINE_TWO.length } as React.CSSProperties}
            >
              {" "}
            </span>
            <span
              className="em text-sun-gradient inline-block [animation:rise-in_1.2s_var(--ease-out)_both]"
              style={{ animationDelay: `${lightDelay}ms` }}
            >
              light.
            </span>
          </span>
        </h1>

        <p
          className="subhead hero-fade mt-6 max-w-[40rem] md:mt-7"
          style={{ "--d": "700ms" } as React.CSSProperties}
        >
          Describe it, and Desyn builds it as real, editable layers. Keep talking and every change
          lands on the canvas, not in a new picture.
        </p>

        <div
          className="hero-fade mt-8 flex w-full max-w-[22rem] flex-col items-stretch gap-3 sm:w-auto sm:max-w-none sm:flex-row sm:items-center md:mt-10"
          style={{ "--d": "900ms" } as React.CSSProperties}
        >
          <a href={SIGNUP_URL} className="btn btn-primary btn-lg group">
            Start designing — free
            <ArrowRight
              size={18}
              strokeWidth={1.75}
              aria-hidden="true"
              className="transition-transform duration-300 group-hover:translate-x-0.5"
            />
          </a>
          <a href={SELF_HOST_DOCS_URL} className="btn btn-secondary btn-lg">
            Self-host it
          </a>
        </div>
      </div>
    </section>
  );
}
