import type { Metadata } from "next";
import { CtaBand } from "@/components/site/CtaBand";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { Em } from "@/components/site/SectionIntro";
import { CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How Desyn protects your account, your designs and your API keys, and how to report a vulnerability.",
  alternates: { canonical: "/security" },
};

const PRACTICES = [
  {
    title: "Every request is checked",
    body: "Every server function verifies who you are, that you belong to the workspace and that your plan allows the action, and validates its input before doing anything.",
  },
  {
    title: "Keys are encrypted",
    body: "API keys you add for your own AI providers are encrypted before they are stored, or, if you prefer, kept only in your browser and never sent to us.",
  },
  {
    title: "Files behind signed links",
    body: "Uploads and exports live in private object storage. Your browser gets short-lived signed links, never public URLs.",
  },
  {
    title: "Untrusted content stays untrusted",
    body: "Uploaded SVGs are sanitised. Text and images inside designs are treated as data by the AI, never as instructions, with tool allowlists and step and cost caps on every run.",
  },
  {
    title: "Encrypted in transit",
    body: "Every connection to desyn.app and the app uses TLS. Sessions are handled by Better Auth with secure, HTTP-only cookies.",
  },
  {
    title: "Limits and audit trail",
    body: "Rate limits protect accounts from abuse, and security-relevant events, such as sign-ins, key changes and sharing, are written to an audit log.",
  },
  {
    title: "Backups",
    body: "The database and file storage are backed up every night to separate storage.",
  },
  {
    title: "The source is public",
    body: "Desyn is source-available, so anyone can read how it handles data and report what they find.",
  },
];

export default function SecurityPage() {
  return (
    <>
      <PageHero
        eyebrow="Security"
        title={
          <>
            Your work, <Em>kept</Em> safe.
          </>
        }
      >
        How we protect your account, your designs and your keys.
      </PageHero>
      <section className="pb-20" aria-label="Practices">
        <div className="container-wide">
          <div className="mx-auto grid max-w-6xl gap-px overflow-hidden rounded-[24px] border border-fg/10 bg-fg/10 md:grid-cols-2">
            {PRACTICES.map((p, i) => (
              <Reveal key={p.title} delay={(i % 2) * 0.06} className="bg-bg p-8 sm:p-10">
                <h2 className="font-serif text-[28px] leading-tight">{p.title}</h2>
                <p className="mt-3 text-[15.5px] leading-7 text-fg/70">{p.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
      <section className="section pt-0" aria-labelledby="report-title">
        <div className="container-content">
          <Reveal className="rounded-[24px] border border-sun/25 bg-sun/[0.05] p-8 sm:p-12">
            <h2
              id="report-title"
              className="font-serif text-[clamp(34px,3.6vw,48px)] leading-tight"
            >
              Found a vulnerability?
            </h2>
            <p className="body mt-4">
              Please email <span className="text-fg">{CONTACT_EMAIL}</span> with “Security” in the
              subject, steps to reproduce and the impact you expect. Give us a reasonable time to
              fix it before you share it publicly, and do not access other people’s data or disrupt
              the service while testing. We read every report, reply as quickly as we can and credit
              you if you would like.
            </p>
          </Reveal>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
