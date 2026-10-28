import Link from "next/link";
import { ConsentSettingsButton } from "@/components/analytics/ConsentSettingsButton";
import { SUBPROCESSORS } from "@/lib/content/legal";
import { planConfig } from "@/lib/plans";
import { CONTACT_EMAIL, GITHUB_URL } from "@/lib/site";

const Mail = () => <span className="text-fg">{CONTACT_EMAIL}</span>;

export function Terms() {
  const pro = planConfig.plans.pro;
  return (
    <>
      <h2>1. Who we are</h2>
      <p>
        Desyn (“we”, “us”) provides the Desyn design service at desyn.app and app.desyn.app, the
        desktop and mobile apps, and the related APIs (together, “the Service”). These terms are an
        agreement between you and Desyn. Contact: <Mail />.
      </p>

      <h2>2. Your account</h2>
      <ul>
        <li>
          You must be at least 16 years old, or the age of digital consent where you live, to create
          an account.
        </li>
        <li>
          Keep your sign-in details safe. You are responsible for what happens under your account.
        </li>
        <li>
          If you create an account for an organisation, you confirm you may bind it to these terms.
        </li>
      </ul>

      <h2>3. Your content</h2>
      <p>
        Your designs, uploads and the assets you generate (“Your Content”) belong to you. You give
        us a limited licence to store, process, render and transmit Your Content only to run the
        Service for you, for example to save your designs, show them to collaborators you invite,
        create thumbnails and exports, and send them to AI providers when you ask the AI to work on
        them. We do not use Your Content to train AI models.
      </p>
      <p>
        You are responsible for having the rights to what you upload, and for how you use what you
        make. AI output can resemble existing work; check anything you publish for rights you may
        need.
      </p>

      <h2>4. Acceptable use</h2>
      <p>Do not use the Service to:</p>
      <ul>
        <li>
          break the law, infringe others’ rights, or create content that sexualises minors or
          promotes violence or hatred;
        </li>
        <li>
          deceive people, for example by impersonating real organisations or people, or by making
          fake documents;
        </li>
        <li>
          attack, overload, scrape or reverse-engineer the hosted Service, or get around its limits;
        </li>
        <li>
          create accounts in bulk, resell access, or share one paid account among many people.
        </li>
      </ul>
      <p>
        We may remove content or suspend accounts that break these rules. Where we can, we will tell
        you first and explain why.
      </p>

      <h2>5. Plans, billing and fair use</h2>
      <ul>
        <li>
          The Free plan costs nothing and has the limits shown on the{" "}
          <Link href="/pricing">pricing page</Link>.
        </li>
        <li>
          Pro costs ${pro.priceMonthly} a month or ${pro.priceYearly} a year (plus any tax), billed
          in advance through Stripe. It renews automatically until you cancel; you can cancel at any
          time from your billing settings and keep Pro until the end of the period you paid for.
        </li>
        <li>
          Pro includes {pro.limits.creditsPerMonth} AI credits a month. Unused credits do not roll
          over. When they run out, AI requests are slowed down rather than charged; we never bill
          overage. Requests made with your own API keys do not use credits.
        </li>
        <li>
          Fair-use limits (requests per minute and per day, concurrent runs) protect the Service for
          everyone and are described on the pricing page.
        </li>
        <li>
          If you are a consumer in the EU, you have a 14-day right of withdrawal for your first Pro
          purchase.
        </li>
      </ul>

      <h2>6. AI features</h2>
      <p>
        AI features send the relevant prompts, design content and images to the AI providers listed
        in our <Link href="/legal/privacy">privacy policy</Link>, or to the providers you configure
        with your own keys. AI output can be wrong or unexpected. Review it before you rely on it.
      </p>

      <h2>7. The source code</h2>
      <p>
        The Desyn source is available under the Desyn Non-Commercial Source License, summarised on
        the <Link href="/legal/license">licence page</Link>. These terms cover the hosted Service;
        the licence covers the source code and self-hosted installations.
      </p>

      <h2>8. Availability and changes</h2>
      <p>
        We work hard to keep the Service available and your data safe, but we cannot promise it will
        never be interrupted. We may change features; if we make a change that materially reduces
        what a paid plan includes, we will tell you in advance and you may cancel with a pro-rata
        refund.
      </p>

      <h2>9. Ending your account</h2>
      <p>
        You can delete your account at any time. You can export your designs before you do. We may
        end the Service for you after notice if you seriously or repeatedly break these terms. After
        an account is deleted, we delete Your Content within 30 days, except where the law requires
        us to keep something.
      </p>

      <h2>10. Liability</h2>
      <p>
        Nothing in these terms limits liability that cannot be limited by law, including your rights
        as a consumer. Otherwise, the Service is provided as it is, and our total liability to you
        is limited to the amount you paid us in the 12 months before the claim.
      </p>

      <h2>11. Changes to these terms</h2>
      <p>
        If we change these terms, we will post the new version here and, for material changes, tell
        you by email at least 30 days before they apply.
      </p>
    </>
  );
}

export function Privacy() {
  return (
    <>
      <h2>Who is responsible</h2>
      <p>
        Desyn is the controller of the personal data described here for the hosted Service. Contact:{" "}
        <Mail />. When a Pro customer uses Desyn for their organisation, we may act as their
        processor; see the <Link href="/legal/dpa">data processing addendum</Link>.
      </p>

      <h2>What we collect and why</h2>
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Why</th>
            <th>Legal basis</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Account: email, name, sign-in method, settings</td>
            <td>To give you an account and keep it secure</td>
            <td>Contract</td>
          </tr>
          <tr>
            <td>Your Content: designs, uploads, generated assets, comments</td>
            <td>To store, render, share and export your work</td>
            <td>Contract</td>
          </tr>
          <tr>
            <td>Billing: plan, invoices, Stripe customer id</td>
            <td>To charge for Pro and keep records the law requires</td>
            <td>Contract, legal obligation</td>
          </tr>
          <tr>
            <td>Usage: credits used, AI runs, feature usage</td>
            <td>To apply plan limits and fair use, and to improve Desyn</td>
            <td>Contract, legitimate interest</td>
          </tr>
          <tr>
            <td>Technical: IP address, device and browser, logs</td>
            <td>To run, secure and debug the Service</td>
            <td>Legitimate interest</td>
          </tr>
          <tr>
            <td>Website analytics on desyn.app</td>
            <td>To understand which pages help people</td>
            <td>Consent (cookies), legitimate interest (cookieless counts)</td>
          </tr>
        </tbody>
      </table>
      <p>
        We do not sell personal data, we do not use Your Content to train AI models, and we do not
        show ads.
      </p>

      <h2>AI providers</h2>
      <p>
        When you use hosted AI features, the prompt and the parts of your design needed to answer it
        are sent to the model provider through OpenRouter (text) or Fal (images and video). If you
        add your own API keys or connect a local model, requests go to the provider or server you
        chose instead, under your agreement with them.
      </p>

      <h2>Who processes data for us</h2>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          {SUBPROCESSORS.map((s) => (
            <tr key={s.name}>
              <td>{s.name}</td>
              <td>{s.purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Some of these providers may process data outside the European Economic Area. Where they do,
        we rely on safeguards such as the EU Standard Contractual Clauses.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Account and content: while your account exists, and up to 30 days after deletion.</li>
        <li>Billing records: as long as tax law requires (typically up to 10 years).</li>
        <li>Logs: up to 30 days. Analytics: up to 12 months.</li>
      </ul>

      <h2>Your rights</h2>
      <p>
        You can ask to access, correct, delete or export your personal data, object to or restrict
        processing, and withdraw consent at any time. Most of this you can do yourself in your
        account settings; for the rest, email <Mail />. You can also complain to your local data
        protection authority.
      </p>

      <h2>Cookies</h2>
      <p>
        See the <Link href="/legal/cookies">cookie page</Link> for every cookie and storage key, and
        to change your choice.
      </p>
    </>
  );
}

export function Cookies({ analyticsEnabled }: { analyticsEnabled: boolean }) {
  return (
    <>
      <p>
        desyn.app asks before setting any non-essential cookie. Declining keeps the site fully
        working and cookieless.
      </p>
      {analyticsEnabled ? (
        <div className="my-6">
          <ConsentSettingsButton />
        </div>
      ) : null}

      <h2>Strictly necessary</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Where</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>desyn-theme</code>
            </td>
            <td>Local storage, desyn.app</td>
            <td>Remembers light, dark or system theme</td>
          </tr>
          <tr>
            <td>
              <code>desyn-consent</code>
            </td>
            <td>Local storage, desyn.app</td>
            <td>Remembers your cookie choice</td>
          </tr>
          <tr>
            <td>Session cookies</td>
            <td>Cookies, app.desyn.app</td>
            <td>Keep you signed in to the app</td>
          </tr>
        </tbody>
      </table>

      <h2>Analytics, only with your consent</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Provider</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>ph_*</code>
            </td>
            <td>PostHog (EU cloud)</td>
            <td>
              Recognises returning visitors. Without consent, PostHog runs in memory only and
              nothing is stored on your device.
            </td>
          </tr>
          <tr>
            <td>
              <code>datafast_*</code>
            </td>
            <td>DataFast</td>
            <td>Counts visits and referrers. Not loaded at all without consent.</td>
          </tr>
        </tbody>
      </table>

      <h2>Changing your mind</h2>
      <p>
        {analyticsEnabled
          ? "Use the button above to see the choice again. You can also clear site data in your browser at any time."
          : "Analytics are currently switched off on this site, so there is nothing to choose. You can clear site data in your browser at any time."}
      </p>
    </>
  );
}

export function License({ fullText }: { fullText: string | null }) {
  return (
    <>
      <p>
        Desyn is <strong>source-available, free for non-commercial use</strong>. The source code is
        public under the Desyn Non-Commercial Source License. Here is what it means in plain words.
        The licence text itself is what counts; it is reproduced in full below.
      </p>

      <h2>You may</h2>
      <ul>
        <li>read, copy, modify and run the source;</li>
        <li>
          self-host Desyn with every feature for personal projects, hobbies, education, research and
          non-profit organisations;
        </li>
        <li>
          share modified or unmodified copies under the same licence, marked as modified where you
          changed them.
        </li>
      </ul>

      <h2>You may not, without a commercial licence</h2>
      <ul>
        <li>use Desyn inside a for-profit business, including for its own employees;</li>
        <li>
          offer Desyn, or something built from it, as a hosted, managed or white-label service;
        </li>
        <li>sell, rent, sublicense or bundle it with a paid product;</li>
        <li>use the name “Desyn”, the sun mark or desyn.app to name or promote a derivative.</li>
      </ul>
      <p>
        All commercial rights are reserved. For a commercial licence, write to <Mail />.
      </p>

      <h2>Contributions</h2>
      <p>
        Contributions are made under a Contributor License Agreement that lets us relicense them,
        including commercially. Fonts and other third-party components keep their own licences, such
        as the SIL Open Font License.
      </p>

      <h2>The full licence</h2>
      {GITHUB_URL ? (
        <p>
          It is also in the{" "}
          <a href={`${GITHUB_URL}/blob/main/LICENSE`}>LICENSE file of the repository</a>.
        </p>
      ) : null}
      {fullText ? (
        <section
          aria-label="Full licence text"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable so keyboard users can scroll it (WCAG 2.1.1).
          tabIndex={0}
          className="mt-4 max-h-[640px] overflow-auto rounded-[14px] border border-fg/10 bg-surface-1 p-6 focus-visible:outline-2 focus-visible:outline-sun"
        >
          <pre className="whitespace-pre-wrap font-mono text-[12.5px] leading-6 text-fg/75">
            {fullText}
          </pre>
        </section>
      ) : (
        <p>The licence text ships as the LICENSE file at the root of the source code.</p>
      )}
    </>
  );
}

export function Dpa() {
  return (
    <>
      <p>
        This addendum applies when a Pro customer (“you”) uses Desyn to process personal data on
        behalf of an organisation, and forms part of the{" "}
        <Link href="/legal/terms">Terms of Service</Link>. You are the controller; Desyn is the
        processor.
      </p>

      <h2>What we process</h2>
      <ul>
        <li>
          Subject matter: the personal data contained in designs, uploads, comments and account
          details of your team.
        </li>
        <li>Duration: for as long as you use the Service, plus up to 30 days for deletion.</li>
        <li>Purpose: only to provide the Service as you instruct through your use of it.</li>
      </ul>

      <h2>Our commitments</h2>
      <ul>
        <li>We process personal data only on your documented instructions.</li>
        <li>Everyone with access is bound by confidentiality.</li>
        <li>
          We keep appropriate technical and organisational measures in place, described on our{" "}
          <Link href="/security">security page</Link>.
        </li>
        <li>
          We help you answer requests from data subjects and with impact assessments where needed.
        </li>
        <li>
          We tell you without undue delay after becoming aware of a personal data breach affecting
          your data.
        </li>
        <li>At the end of the Service we delete your data, or return it first if you ask.</li>
        <li>We make the information needed to show compliance available to you on request.</li>
      </ul>

      <h2>Subprocessors</h2>
      <p>
        You authorise the following subprocessors. We will tell you before adding or replacing one,
        so you can object.
      </p>
      <table>
        <thead>
          <tr>
            <th>Subprocessor</th>
            <th>Purpose</th>
            <th>Data</th>
          </tr>
        </thead>
        <tbody>
          {SUBPROCESSORS.filter((s) => s.name !== "DataFast").map((s) => (
            <tr key={s.name}>
              <td>{s.name}</td>
              <td>{s.purpose}</td>
              <td>{s.data}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>International transfers</h2>
      <p>
        Where personal data leaves the European Economic Area, we rely on the EU Standard
        Contractual Clauses.
      </p>

      <h2>Signing</h2>
      <p>
        If your organisation needs a countersigned copy, email <Mail /> with your company details.
      </p>
    </>
  );
}
