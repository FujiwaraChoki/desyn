import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Breadcrumbs,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleSection,
  CollapsibleTrigger,
  NumberField,
  Pagination,
  ScrollArea,
  Separator,
  Stepper,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@desyn/ui";
import { Folder, Home, ImagePlus, LayoutGrid, LayoutTemplate, Type } from "lucide-react";
import { useState } from "react";
import { Row, Showcase, Stack } from "../showcase.tsx";

const PAGES = Array.from({ length: 14 }, (_, i) => ({
  id: `page-${i + 1}`,
  name: `Page ${i + 1}`,
  layers: (i * 3) % 17,
}));

function PaginationDemo() {
  const [page, setPage] = useState(6);
  return <Pagination page={page} pageCount={24} onPageChange={setPage} />;
}

function StepperDemo() {
  const [step, setStep] = useState(1);
  return (
    <div className="flex w-full flex-col gap-4">
      <Stepper
        current={step}
        onStepClick={setStep}
        steps={[
          { label: "Brief" },
          { label: "Concept" },
          { label: "Variants" },
          { label: "Export" },
        ]}
      />
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={step === 0}
          onClick={() => setStep((s) => s - 1)}
        >
          Back
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={step === 3}
          onClick={() => setStep((s) => s + 1)}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

export function StructureSection() {
  return (
    <Showcase
      id="structure"
      eyebrow="Structure"
      title={
        <>
          calm ways to <em>find</em> things
        </>
      }
      description="Tabs with a sliding sun underline, breadcrumbs, pagination, steppers, accordions and inspector sections."
    >
      {() => (
        <Stack>
          <Tabs defaultValue="templates">
            <TabsList>
              <TabsTrigger value="templates" icon={<LayoutTemplate />}>
                Templates
              </TabsTrigger>
              <TabsTrigger value="elements" icon={<LayoutGrid />}>
                Elements
              </TabsTrigger>
              <TabsTrigger value="text" icon={<Type />}>
                Text
              </TabsTrigger>
              <TabsTrigger value="uploads" icon={<ImagePlus />}>
                Uploads
              </TabsTrigger>
            </TabsList>
            <TabsContent value="templates" className="text-sm text-fg-muted">
              312 templates across 24 categories, all fully editable layers.
            </TabsContent>
            <TabsContent value="elements" className="text-sm text-fg-muted">
              Shapes, lines, frames, icons and stickers.
            </TabsContent>
            <TabsContent value="text" className="text-sm text-fg-muted">
              Headings and text styles from your brand kit.
            </TabsContent>
            <TabsContent value="uploads" className="text-sm text-fg-muted">
              Drop images, SVGs, fonts and videos here.
            </TabsContent>
          </Tabs>
          <Row label="Pill tabs">
            <Tabs variant="pill" defaultValue="design">
              <TabsList>
                <TabsTrigger value="design">Design</TabsTrigger>
                <TabsTrigger value="arrange">Arrange</TabsTrigger>
                <TabsTrigger value="effects">Effects</TabsTrigger>
                <TabsTrigger value="animate">Animate</TabsTrigger>
              </TabsList>
            </Tabs>
          </Row>
          <Row label="Breadcrumbs">
            <Breadcrumbs
              items={[
                { label: "Home", href: "#structure", icon: <Home className="size-3.5" /> },
                { label: "Launch", href: "#structure", icon: <Folder className="size-3.5" /> },
                { label: "Summer 2026", href: "#structure" },
                { label: "Social", href: "#structure" },
                { label: "Golden hour poster" },
              ]}
            />
          </Row>
          <Row label="Pagination">
            <PaginationDemo />
          </Row>
          <Row label="Stepper">
            <StepperDemo />
          </Row>
          <div className="grid gap-5 sm:grid-cols-2">
            <Row label="Accordion" className="block">
              <Accordion type="single" collapsible defaultValue="a1" className="w-full">
                <AccordionItem value="a1">
                  <AccordionTrigger>What does the AI change?</AccordionTrigger>
                  <AccordionContent>
                    Only what you ask. Everything else stays exactly where you left it.
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="a2">
                  <AccordionTrigger>Can I self-host?</AccordionTrigger>
                  <AccordionContent>
                    Yes. Self-hosters get every feature for non-commercial use.
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="a3">
                  <AccordionTrigger>Which formats export?</AccordionTrigger>
                  <AccordionContent>PNG, JPG, WebP, SVG, PDF, PPTX, GIF and MP4.</AccordionContent>
                </AccordionItem>
              </Accordion>
            </Row>
            <Row label="Inspector sections" className="block">
              <div className="rounded-card border border-line-subtle bg-surface-1 px-2">
                <CollapsibleSection title="Auto layout">
                  <div className="grid grid-cols-2 gap-1.5 px-1">
                    <NumberField label="Gap" size="sm" defaultValue={16} />
                    <NumberField label="Pad" size="sm" defaultValue={24} />
                  </div>
                </CollapsibleSection>
                <Separator />
                <CollapsibleSection title="Constraints" defaultOpen={false}>
                  <p className="px-1 text-xs text-fg-muted">Left · Top</p>
                </CollapsibleSection>
              </div>
              <Collapsible className="mt-3">
                <CollapsibleTrigger asChild>
                  <Button variant="link" size="sm">
                    Show advanced
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <p className="pt-2 text-xs text-fg-muted">
                    Blend mode, masks and export settings.
                  </p>
                </CollapsibleContent>
              </Collapsible>
            </Row>
          </div>
          <Row label="Scroll area" className="block">
            <ScrollArea className="h-32 rounded-card border border-line-subtle">
              <ul className="divide-y divide-line-subtle text-sm">
                {PAGES.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between px-3 py-2 text-fg-secondary"
                  >
                    <span>{p.name}</span>
                    <span className="text-2xs text-fg-muted">{p.layers} layers</span>
                  </li>
                ))}
              </ul>
            </ScrollArea>
            <Separator label="or" className="mt-4" />
          </Row>
        </Stack>
      )}
    </Showcase>
  );
}
