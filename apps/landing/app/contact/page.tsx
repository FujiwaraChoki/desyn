import type { Metadata } from "next";
import { CopyEmail } from "@/components/site/CopyEmail";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { Em } from "@/components/site/SectionIntro";
import { CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Contact",
  description: `Write to ${CONTACT_EMAIL} for support, commercial licences, security reports and press.`,
  alternates: { canonical: "/contact" },
};

const TOPICS = [
  {
    title: "Help with Desyn",
    body: "Questions about your account, billing or how something works.",
  },
  {
    title: "Commercial licence",
    body: "Using Desyn inside a company or offering it to customers. Tell us a little about your plans.",
  },
  {
    title: "Security",
    body: "Reports of vulnerabilities. Put “Security” in the subject so it reaches the right person fast.",
  },
  { title: "Press and partnerships", body: "Stories, interviews and integrations." },
];

export default function ContactPage() {
  return (
    <>
      <PageHero
        eyebrow="Contact"
        title={
          <>
            Say <Em>hello.</Em>
          </>
        }
      >
        One address for everything. A person reads every message.
      </PageHero>
      <section className="pb-28" aria-label="Email">
        <div className="container-wide">
          <Reveal>
            <CopyEmail email={CONTACT_EMAIL} />
          </Reveal>
          <div className="mx-auto mt-20 grid max-w-5xl gap-px overflow-hidden rounded-[24px] border border-fg/10 bg-fg/10 sm:grid-cols-2">
            {TOPICS.map((t, i) => (
              <Reveal key={t.title} delay={(i % 2) * 0.06} className="bg-bg p-8">
                <h2 className="font-serif text-[26px] leading-tight">{t.title}</h2>
                <p className="mt-2 text-[15px] leading-6 text-fg/65">{t.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
