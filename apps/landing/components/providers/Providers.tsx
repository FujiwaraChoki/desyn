import { Reveal } from "@/components/site/Reveal";
import { Em, SectionIntro } from "@/components/site/SectionIntro";
import { planConfig } from "@/lib/plans";

/**
 * Provider names set in our own type (no third-party logos). Each gets a typographic treatment so
 * the strip reads as a wall of wordmarks without borrowing anyone's artwork.
 */
const PROVIDERS: { name: string; style: string; note: string }[] = [
  { name: "OpenRouter", style: "font-serif", note: "Default, hosted" },
  {
    name: "Anthropic",
    style: "font-sans tracking-[0.12em] uppercase text-[0.62em] font-medium",
    note: "Your key",
  },
  { name: "OpenAI", style: "font-sans font-semibold tracking-[-0.03em]", note: "Your key" },
  { name: "Google", style: "font-serif italic", note: "Your key" },
  { name: "Fal", style: "font-mono lowercase tracking-[-0.04em]", note: "Images & video" },
  { name: "Ollama", style: "font-sans lowercase font-medium tracking-[-0.02em]", note: "Local" },
  {
    name: "Mistral",
    style: "font-serif uppercase tracking-[0.06em] text-[0.8em]",
    note: "Your key",
  },
  { name: "Groq", style: "font-mono font-semibold", note: "Your key" },
  { name: "Replicate", style: "font-sans font-light tracking-[0.02em]", note: "Your key" },
  { name: "LM Studio", style: "font-serif", note: "Local" },
  { name: "vLLM", style: "font-mono", note: "Self-hosted" },
  { name: "llama.cpp", style: "font-mono text-[0.85em]", note: "Local" },
  {
    name: "Any OpenAI-compatible API",
    style: "font-serif italic text-[0.8em]",
    note: "Bring a URL",
  },
];

export function Providers() {
  return (
    <section className="section" aria-labelledby="providers-title">
      <div className="container-wide">
        <SectionIntro
          id="providers-title"
          eyebrow="Bring your own AI"
          title={
            <>
              Your models, your <Em>keys.</Em>
            </>
          }
        >
          Use the models we host, plug in your own keys, or run everything on your machine. Pick a
          model for each job: one for layout, another for images.
        </SectionIntro>

        <Reveal className="mx-auto mt-16 max-w-5xl">
          <ul className="flex flex-wrap items-baseline justify-center gap-x-10 gap-y-6 text-[clamp(28px,3.6vw,46px)] leading-none text-fg/80 sm:gap-x-14">
            {PROVIDERS.map((p) => (
              <li key={p.name} className="group relative">
                <span
                  className={`${p.style} transition-colors duration-300 group-hover:text-sun-text`}
                >
                  {p.name}
                </span>
                <span className="pointer-events-none absolute -bottom-5 left-0 whitespace-nowrap font-sans text-[11px] text-fg/0 transition-colors duration-300 group-hover:text-subtle">
                  {p.note}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="mx-auto mt-16 grid max-w-4xl gap-px overflow-hidden rounded-[18px] border border-fg/10 bg-fg/10 sm:grid-cols-3">
            {[
              [
                "Hosted",
                `Pro includes ${planConfig.plans.pro.limits.creditsPerMonth} AI credits a month on our models. Run out and requests slow down; you are never charged extra.`,
              ],
              [
                "Your keys",
                "Add keys for the providers you already pay for. Requests with your own key do not use credits.",
              ],
              [
                "Local",
                "Point Desyn at Ollama, LM Studio or any OpenAI-compatible server. Your prompts go to your own hardware.",
              ],
            ].map(([t, d]) => (
              <div key={t} className="bg-bg p-7">
                <h3 className="font-serif text-[24px]">{t}</h3>
                <p className="mt-2 text-[14.5px] leading-6 text-fg/65">{d}</p>
              </div>
            ))}
          </div>
        </Reveal>
        <p className="mt-6 text-center text-[12px] text-subtle">
          Product names are trademarks of their owners and are shown for identification only.
        </p>
      </div>
    </section>
  );
}
