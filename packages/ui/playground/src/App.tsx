import {
  Eyebrow,
  Logo,
  Orbs,
  SegmentedControl,
  SunGlow,
  type ThemePreference,
  useTheme,
} from "@desyn/ui";
import { Monitor, Moon, Sun } from "lucide-react";
import { EditorComposition } from "./editor.tsx";
import { ActionsSection } from "./sections/actions.tsx";
import { BrandSection, DataSection } from "./sections/data.tsx";
import { FeedbackSection } from "./sections/feedback.tsx";
import { FormsSection } from "./sections/forms.tsx";
import { OverlaysSection } from "./sections/overlays.tsx";
import { PickersSection } from "./sections/pickers.tsx";
import { StructureSection } from "./sections/structure.tsx";

const NAV = [
  ["editor", "Editor"],
  ["actions", "Actions"],
  ["forms", "Inputs"],
  ["overlays", "Overlays"],
  ["structure", "Structure"],
  ["feedback", "Feedback"],
  ["pickers", "Pickers"],
  ["data", "Data"],
  ["brand", "Brand"],
] as const;

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <SegmentedControl<ThemePreference>
      aria-label="Theme"
      size="sm"
      value={theme}
      onValueChange={setTheme}
      options={[
        { value: "system", label: <Monitor />, "aria-label": "System theme" },
        { value: "dark", label: <Moon />, "aria-label": "Dark theme" },
        { value: "light", label: <Sun />, "aria-label": "Light theme" },
      ]}
    />
  );
}

export function App() {
  return (
    <div className="min-h-dvh bg-background text-fg">
      <header className="sticky top-0 z-(--z-sticky) border-b border-line-subtle bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1360px] items-center gap-6 px-4 sm:px-6">
          <Logo size={22} />
          <nav
            aria-label="Sections"
            className="flex min-w-0 flex-1 gap-1 overflow-x-auto max-md:hidden"
          >
            {NAV.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="shrink-0 rounded-[6px] px-2.5 py-1 text-sm text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg"
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="ml-auto">
            <ThemeSwitch />
          </div>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <Orbs
          scale={0.8}
          className="[mask-image:radial-gradient(120%_100%_at_50%_0%,black_45%,transparent_85%)]"
        />
        <div className="relative mx-auto flex max-w-[1360px] flex-col items-start gap-5 px-4 pt-16 pb-10 sm:px-6 sm:pt-24">
          <div className="relative">
            <SunGlow width={640} height={260} className="left-[40%]" />
            <Eyebrow>@desyn/ui · atmospheric minimalism</Eyebrow>
          </div>
          <h1 className="relative max-w-4xl font-serif text-[56px] leading-[0.98] tracking-[-0.02em] text-fg sm:text-[88px]">
            a component system for{" "}
            <em className="text-accent drop-shadow-[0_0_24px_var(--accent-glow)]">light</em>.
          </h1>
          <p className="relative max-w-xl text-base leading-7 text-fg-secondary">
            Every control the Desyn editor needs, in one calm visual language: dark first, one
            sun accent, serif headlines and motion that feels alive. Fully keyboard operable,
            reduced-motion aware.
          </p>
        </div>
      </section>

      <main className="mx-auto flex max-w-[1360px] flex-col gap-20 px-4 pt-10 pb-24 sm:px-6">
        <section id="editor" className="scroll-mt-20">
          <header className="mb-5 flex flex-col gap-2">
            <Eyebrow>Composition</Eyebrow>
            <h2 className="font-serif text-[34px] leading-tight text-fg">
              the editor, <em className="text-accent">assembled</em>
            </h2>
            <p className="max-w-2xl text-sm text-fg-muted">
              Top bar with menubar and collaborators, resizable layers tree, canvas with a floating
              tool dock and context menu, and a dense inspector. Follows the theme switch above.
            </p>
          </header>
          <EditorComposition />
        </section>

        <ActionsSection />
        <FormsSection />
        <OverlaysSection />
        <StructureSection />
        <FeedbackSection />
        <PickersSection />
        <DataSection />
        <BrandSection />
      </main>

      <footer className="border-t border-line-subtle">
        <div className="mx-auto flex max-w-[1360px] items-center justify-between px-4 py-6 text-xs text-fg-muted sm:px-6">
          <span>Desyn UI playground</span>
          <span>Instrument Serif · Instrument Sans · JetBrains Mono</span>
        </div>
      </footer>
    </div>
  );
}
