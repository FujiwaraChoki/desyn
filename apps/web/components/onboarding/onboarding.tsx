"use client";

import { FONT_PAIRINGS } from "@desyn/schema";
import { Button, Callout, cn, Field, Input, Logo, Orbs, Select, Textarea, toast } from "@desyn/ui";
import { useMutation } from "convex/react";
import {
  ArrowRight,
  BookOpen,
  Briefcase,
  CalendarHeart,
  Check,
  Clapperboard,
  Globe,
  Lightbulb,
  Megaphone,
  Presentation,
  Printer,
  Shapes,
  Smartphone,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { type BrandLogo, LogoUploader } from "@/components/brand/logo-uploader";
import { type BrandColor, PaletteEditor } from "@/components/brand/palette-editor";
import { Rich } from "@/components/rich";
import { track } from "@/lib/analytics";
import { api } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { loadGoogleFont } from "@/lib/fonts";
import { useT } from "@/lib/i18n";
import { clearIntent, readIntent } from "@/lib/intent";
import { isEmail } from "@/lib/password";
import { routes } from "@/lib/routes";

const STEPS = ["make", "team", "brand", "ready"] as const;
type Step = (typeof STEPS)[number];

const USE_CASES: { id: string; icon: ReactNode }[] = [
  { id: "social", icon: <Smartphone /> },
  { id: "presentations", icon: <Presentation /> },
  { id: "marketing", icon: <Megaphone /> },
  { id: "print", icon: <Printer /> },
  { id: "video", icon: <Clapperboard /> },
  { id: "brand", icon: <Shapes /> },
  { id: "documents", icon: <BookOpen /> },
  { id: "events", icon: <CalendarHeart /> },
  { id: "web", icon: <Globe /> },
  { id: "whiteboard", icon: <Lightbulb /> },
];
const ROLES = [
  "designer",
  "marketer",
  "founder",
  "creator",
  "educator",
  "student",
  "developer",
  "other",
] as const;
const INVITE_ROLES = ["admin", "editor", "commenter", "viewer"] as const;

function StepHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-8 text-center">
      <h1 className="rich-title rise font-serif text-[40px] leading-[1.05] tracking-[-0.01em] text-fg sm:text-[56px]">
        <Rich text={title} />
      </h1>
      <p
        className="rise mx-auto mt-3 max-w-lg text-sm leading-6 text-fg-muted"
        style={{ ["--i" as string]: 1 }}
      >
        {subtitle}
      </p>
    </div>
  );
}

/** First-run flow: what you make, your team, your brand, then into the app. Every step is skippable. */
export function Onboarding() {
  const t = useT();
  const router = useRouter();
  const { me, workspaceId, setWorkspaceId, billing } = useApp();
  const setOnboarding = useMutation(api.accounts.profiles.setOnboarding);
  const createWorkspace = useMutation(api.accounts.workspaces.create);
  const invite = useMutation(api.accounts.invites.create);
  const createKit = useMutation(api.brand.brandKits.create);
  const initial = (STEPS as readonly string[]).includes(me.onboarding.step ?? "")
    ? (me.onboarding.step as Step)
    : "make";
  const [step, setStep] = useState<Step>(initial === "ready" ? "make" : initial);
  const [useCases, setUseCases] = useState<string[]>(me.onboarding.useCases ?? []);
  const [role, setRole] = useState<string>(me.onboarding.role ?? "");
  const [teamName, setTeamName] = useState("");
  const [emails, setEmails] = useState("");
  const [inviteRole, setInviteRole] = useState<(typeof INVITE_ROLES)[number]>("editor");
  const [brandName, setBrandName] = useState("");
  const [logos, setLogos] = useState<BrandLogo[]>([]);
  const [colors, setColors] = useState<BrandColor[]>([
    { name: "Sun", value: "#ffb02e", role: "primary" },
    { name: "Ink", value: "#171717", role: "text" },
    { name: "Paper", value: "#faf8f4", role: "background" },
  ]);
  const [pairing, setPairing] = useState<string>(FONT_PAIRINGS[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const index = STEPS.indexOf(step);
  const intent = typeof window === "undefined" ? null : readIntent();

  useEffect(() => {
    for (const p of FONT_PAIRINGS.slice(0, 6)) {
      void loadGoogleFont(p.heading, [p.headingWeight]);
      void loadGoogleFont(p.body, [p.bodyWeight]);
    }
  }, []);

  const go = async (next: Step) => {
    setError(null);
    setStep(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
    void setOnboarding({ step: next }).catch(() => {});
  };

  const saveMake = async () => {
    setPending(true);
    try {
      await setOnboarding({ step: "team", useCases, ...(role ? { role } : {}) });
      track("onboarding_step", { step: "make", useCases: useCases.length });
      void go("team");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const saveTeam = async () => {
    const list = [
      ...new Set(
        emails
          .split(/[\s,;]+/)
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const bad = list.find((e) => !isEmail(e));
    if (bad) return setError(t("onboarding.team.invalidEmail", { email: bad }));
    if (!teamName.trim()) return setError(t("onboarding.team.nameRequired"));
    setPending(true);
    try {
      const id = await createWorkspace({ name: teamName.trim() });
      let invited = 0;
      if (list.length > 0)
        invited = (await invite({ workspaceId: id, emails: list.slice(0, 20), role: inviteRole }))
          .invited.length;
      setWorkspaceId(id);
      toast.success(t("onboarding.team.created", { count: invited }));
      track("onboarding_step", { step: "team", invited });
      void go("brand");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const saveBrand = async () => {
    setPending(true);
    try {
      const p = FONT_PAIRINGS.find((x) => x.id === pairing);
      await createKit({
        workspaceId,
        name: brandName.trim() || me.name || "My brand",
        colors: colors.map((c) => ({
          name: c.name || c.value,
          value: c.value,
          ...(c.role ? { role: c.role } : {}),
        })),
        logos: logos.map((l) => ({ assetId: l.assetId, name: l.name, variant: l.variant })),
        ...(p
          ? {
              fonts: {
                heading: { family: p.heading, weight: p.headingWeight, style: "normal" as const },
                body: { family: p.body, weight: p.bodyWeight, style: "normal" as const },
              },
            }
          : {}),
      });
      toast.success(t("onboarding.brand.saved"));
      track("onboarding_step", { step: "brand" });
      void go("ready");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const finish = async (toPro: boolean) => {
    setPending(true);
    try {
      await setOnboarding({ completed: true, step: "ready" });
      track("onboarding_completed", { useCases: useCases.length });
      if (toPro && intent?.plan) {
        clearIntent();
        router.replace(
          `${routes.settings("billing")}?upgrade=1&interval=${intent.interval ?? "month"}`,
        );
      } else router.replace(routes.home);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  const teams = me.features.teams;
  const brandKits = me.features.brandKit;

  return (
    <div className="relative min-h-dvh overflow-hidden bg-background">
      <Orbs intensity={0.55} />
      <div className="relative z-[1] mx-auto flex min-h-dvh max-w-[920px] flex-col px-4 py-6 sm:px-8">
        <header className="flex items-center justify-between">
          <Logo size={22} />
          <div className="flex items-center gap-3">
            <span className="text-xs text-fg-muted tabular-nums">
              {t("onboarding.step", { current: index + 1, total: STEPS.length })}
            </span>
            <ol className="flex gap-1.5" aria-hidden>
              {STEPS.map((s, i) => (
                <li
                  key={s}
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-500",
                    i < index ? "w-4 bg-accent" : i === index ? "w-8 bg-accent" : "w-4 bg-fg/15",
                  )}
                />
              ))}
            </ol>
          </div>
        </header>

        <main key={step} className="flex flex-1 flex-col justify-center py-10">
          {step === "make" ? (
            <>
              <StepHeading
                title={t("onboarding.make.title")}
                subtitle={t("onboarding.make.subtitle")}
              />
              <ul
                className="rise grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
                style={{ ["--i" as string]: 2 }}
              >
                {USE_CASES.map((u) => {
                  const on = useCases.includes(u.id);
                  return (
                    <li key={u.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setUseCases(on ? useCases.filter((x) => x !== u.id) : [...useCases, u.id])
                        }
                        className={cn(
                          "group relative flex h-20 w-full cursor-pointer flex-col justify-between rounded-[12px] p-3 text-left transition-colors duration-150",
                          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-4",
                          on
                            ? "bg-accent-wash ring-1 ring-accent/50 [&>svg]:text-accent"
                            : "bg-fg/[0.04] hover:bg-fg/[0.07] [&>svg]:text-fg-muted",
                        )}
                      >
                        {u.icon}
                        <span className="text-sm font-medium text-fg">
                          {t(
                            `onboarding.make.useCases.${u.id}` as "onboarding.make.useCases.social",
                          )}
                        </span>
                        {on ? (
                          <span className="absolute top-2.5 right-2.5 grid size-4 place-items-center rounded-full bg-accent-solid text-accent-ink">
                            <Check className="size-3!" strokeWidth={3} />
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="rise mx-auto mt-8 w-full max-w-xs" style={{ ["--i" as string]: 3 }}>
                <Field label={t("onboarding.make.roleLabel")}>
                  <Select
                    options={ROLES.map((r) => ({
                      value: r,
                      label: t(`onboarding.make.roles.${r}`),
                    }))}
                    value={role || undefined}
                    onValueChange={setRole}
                    placeholder={t("onboarding.make.rolePlaceholder")}
                    leading={<Briefcase />}
                  />
                </Field>
              </div>
            </>
          ) : null}

          {step === "team" ? (
            <>
              <StepHeading
                title={t("onboarding.team.title")}
                subtitle={t("onboarding.team.subtitle")}
              />
              {teams ? (
                <div
                  className="rise mx-auto flex w-full max-w-md flex-col gap-4"
                  style={{ ["--i" as string]: 2 }}
                >
                  <Field label={t("onboarding.team.teamName")}>
                    <Input
                      size="lg"
                      value={teamName}
                      maxLength={64}
                      placeholder={t("onboarding.team.teamPlaceholder")}
                      onChange={(e) => setTeamName(e.target.value)}
                    />
                  </Field>
                  <Field label={t("onboarding.team.emails")} help={t("onboarding.team.emailsHelp")}>
                    <Textarea
                      autoResize
                      minRows={3}
                      value={emails}
                      placeholder={t("onboarding.team.emailsPlaceholder")}
                      onChange={(e) => setEmails(e.target.value)}
                    />
                  </Field>
                  <Field label={t("onboarding.team.role")}>
                    <Select
                      options={INVITE_ROLES.map((r) => ({
                        value: r,
                        label: t(`onboarding.team.roles.${r}`),
                      }))}
                      value={inviteRole}
                      onValueChange={setInviteRole}
                    />
                  </Field>
                </div>
              ) : (
                <Callout tone="accent" className="mx-auto max-w-md">
                  {t("onboarding.team.proOnly")}
                </Callout>
              )}
            </>
          ) : null}

          {step === "brand" ? (
            <>
              <StepHeading
                title={t("onboarding.brand.title")}
                subtitle={t("onboarding.brand.subtitle")}
              />
              {brandKits ? (
                <div
                  className="rise mx-auto grid w-full max-w-3xl gap-8 md:grid-cols-2"
                  style={{ ["--i" as string]: 2 }}
                >
                  <div className="flex flex-col gap-5">
                    <Field label={t("onboarding.brand.name")}>
                      <Input
                        size="lg"
                        value={brandName}
                        maxLength={80}
                        placeholder={t("onboarding.brand.namePlaceholder")}
                        onChange={(e) => setBrandName(e.target.value)}
                      />
                    </Field>
                    <Field label={t("onboarding.brand.logo")} help={t("onboarding.brand.logoHelp")}>
                      <LogoUploader
                        workspaceId={workspaceId}
                        value={logos}
                        onChange={setLogos}
                        single
                      />
                    </Field>
                    <Field label={t("onboarding.brand.colors")}>
                      <PaletteEditor value={colors} onChange={setColors} compact max={8} />
                    </Field>
                  </div>
                  <Field label={t("onboarding.brand.fonts")}>
                    <ul className="flex flex-col gap-0.5">
                      {FONT_PAIRINGS.slice(0, 6).map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            aria-pressed={pairing === p.id}
                            onClick={() => setPairing(p.id)}
                            className={cn(
                              "flex w-full cursor-pointer items-center gap-3 rounded-card px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                              pairing === p.id
                                ? "bg-accent-wash ring-1 ring-accent/50"
                                : "hover:bg-fg/[0.05]",
                            )}
                          >
                            <span
                              className="text-[22px] leading-none text-fg"
                              style={{
                                fontFamily: `"${p.heading}", serif`,
                                fontWeight: p.headingWeight,
                              }}
                            >
                              Aa
                            </span>
                            <span className="min-w-0 flex-1">
                              <span
                                className="block truncate text-sm text-fg"
                                style={{
                                  fontFamily: `"${p.heading}", serif`,
                                  fontWeight: p.headingWeight,
                                }}
                              >
                                {p.heading}
                              </span>
                              <span
                                className="block truncate text-xs text-fg-muted"
                                style={{
                                  fontFamily: `"${p.body}", sans-serif`,
                                  fontWeight: p.bodyWeight,
                                }}
                              >
                                {p.body} · {p.moods.slice(0, 2).join(", ")}
                              </span>
                            </span>
                            {pairing === p.id ? <Check className="size-4 text-accent" /> : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </Field>
                </div>
              ) : (
                <Callout tone="accent" className="mx-auto max-w-md">
                  {t("onboarding.brand.proOnly")}
                </Callout>
              )}
            </>
          ) : null}

          {step === "ready" ? (
            <div className="text-center">
              <StepHeading
                title={t("onboarding.ready.title")}
                subtitle={t("onboarding.ready.subtitle")}
              />
            </div>
          ) : null}

          {error ? (
            <Callout tone="danger" className="mx-auto mt-6 w-full max-w-md">
              {error}
            </Callout>
          ) : null}
        </main>

        <footer className="flex items-center justify-between gap-3 border-t border-line-subtle pt-5">
          <Button
            variant="ghost"
            disabled={index === 0 || pending}
            onClick={() => go(STEPS[index - 1] ?? "make")}
          >
            {t("common.back")}
          </Button>
          <div className="flex items-center gap-2">
            {step === "team" || step === "brand" ? (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => go(STEPS[index + 1] ?? "ready")}
              >
                {step === "team" ? t("onboarding.team.solo") : t("common.skip")}
              </Button>
            ) : null}
            {step === "make" ? (
              <Button
                variant="primary"
                shape="pill"
                trailingIcon={<ArrowRight />}
                loading={pending}
                onClick={() => void saveMake()}
              >
                {t("common.continue")}
              </Button>
            ) : null}
            {step === "team" && teams ? (
              <Button
                variant="primary"
                shape="pill"
                loading={pending}
                disabled={!teamName.trim()}
                onClick={saveTeam}
              >
                {t("onboarding.team.submit")}
              </Button>
            ) : null}
            {step === "team" && !teams ? (
              <Button
                variant="primary"
                shape="pill"
                trailingIcon={<ArrowRight />}
                onClick={() => go("brand")}
              >
                {t("common.continue")}
              </Button>
            ) : null}
            {step === "brand" && brandKits ? (
              <Button variant="primary" shape="pill" loading={pending} onClick={saveBrand}>
                {t("onboarding.brand.submit")}
              </Button>
            ) : null}
            {step === "brand" && !brandKits ? (
              <Button
                variant="primary"
                shape="pill"
                trailingIcon={<ArrowRight />}
                onClick={() => go("ready")}
              >
                {t("common.continue")}
              </Button>
            ) : null}
            {step === "ready" ? (
              <>
                {intent?.plan && billing && me.plan === "free" ? (
                  <Button
                    variant="secondary"
                    shape="pill"
                    disabled={pending}
                    onClick={() => finish(true)}
                  >
                    {t("onboarding.ready.pro")}
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  shape="pill"
                  size="lg"
                  loading={pending}
                  trailingIcon={<ArrowRight />}
                  onClick={() => finish(false)}
                >
                  {t("onboarding.ready.start")}
                </Button>
              </>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );
}
