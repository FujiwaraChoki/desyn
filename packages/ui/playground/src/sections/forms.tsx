import {
  Checkbox,
  Combobox,
  Field,
  Input,
  NumberField,
  RadioGroup,
  RadioGroupItem,
  SegmentedControl,
  Select,
  Shortcut,
  Slider,
  Switch,
  Textarea,
} from "@desyn/ui";
import { AtSign, Search } from "lucide-react";
import { useState } from "react";
import { Row, Showcase, Stack } from "../showcase.tsx";

const KINDS = [
  { value: "social-post", label: "Social post" },
  { value: "story", label: "Story" },
  { value: "poster", label: "Poster" },
  { value: "presentation", label: "Presentation" },
  { value: "business-card", label: "Business card" },
  { value: "resume", label: "Resume" },
  { value: "invitation", label: "Invitation" },
  { value: "logo", label: "Logo" },
  { value: "website", label: "One-page website" },
];

function ComboDemo() {
  const [value, setValue] = useState("story");
  return <Combobox options={KINDS} value={value} onValueChange={setValue} aria-label="Category" />;
}

function NumberDemo() {
  const [size, setSize] = useState(48);
  const [angle, setAngle] = useState(15);
  return (
    <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3">
      <NumberField label="W" value={size} min={0} onChange={setSize} unit="px" />
      <NumberField
        label="R"
        aria-label="Rotation"
        value={angle}
        onChange={setAngle}
        unit="°"
        step={1}
      />
      <NumberField label="Op" aria-label="Opacity" defaultValue={80} min={0} max={100} unit="%" />
      <NumberField label="X" value={null} placeholder="Mixed" />
      <NumberField aria-label="Scale" defaultValue={1.25} step={0.05} precision={2} />
      <NumberField
        label="LS"
        aria-label="Letter spacing"
        defaultValue={-0.5}
        step={0.1}
        unit="em"
        disabled
      />
    </div>
  );
}

export function FormsSection() {
  return (
    <Showcase
      id="forms"
      eyebrow="Inputs"
      title={
        <>
          precise, and <em>forgiving</em>
        </>
      }
      description="Drag a number label to scrub (Shift ×10, Alt ÷10), type expressions like 100/2, and use arrow keys to step."
    >
      {() => {
        return (
          <Stack>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Design name" help="Shown on your dashboard.">
                <Input placeholder="Untitled design" defaultValue="Golden hour poster" />
              </Field>
              <Field label="Email" error="Enter a valid email address." required>
                <Input type="email" defaultValue="amira@" leading={<AtSign />} />
              </Field>
              <Field label="Search">
                <Input
                  placeholder="Search templates"
                  leading={<Search />}
                  trailing={<Shortcut keys="mod+k" />}
                />
              </Field>
              <Field label="Kind">
                <Select options={KINDS} defaultValue="poster" />
              </Field>
              <Field label="Category">
                <ComboDemo />
              </Field>
              <Field label="Size">
                <Select
                  size="md"
                  defaultValue="1080x1350"
                  options={[
                    {
                      label: "Instagram",
                      options: [
                        { value: "1080x1080", label: "Square", description: "1080 × 1080" },
                        { value: "1080x1350", label: "Portrait", description: "1080 × 1350" },
                        { value: "1080x1920", label: "Story", description: "1080 × 1920" },
                      ],
                    },
                    {
                      label: "Print",
                      options: [
                        { value: "a4", label: "A4", description: "210 × 297 mm" },
                        { value: "letter", label: "Letter", description: "8.5 × 11 in" },
                      ],
                    },
                  ]}
                />
              </Field>
            </div>
            <Field label="Brief" help="The AI reads this before generating.">
              <Textarea
                autoResize
                minRows={2}
                defaultValue="A warm, minimal poster for an evening concert in the dunes. Big serif headline, one sun."
              />
            </Field>
            <Row label="Numeric fields">
              <NumberDemo />
            </Row>
            <Row label="Sliders" className="flex-col items-stretch gap-4">
              <Slider defaultValue={[64]} aria-label="Opacity" showValue />
              <Slider defaultValue={[20, 72]} thumbLabels={["Minimum", "Maximum"]} showValue />
            </Row>
            <div className="grid gap-5 sm:grid-cols-2">
              <Row label="Choices" className="flex-col items-start gap-3">
                <Switch
                  label="Snap to objects"
                  description="Align to nearby edges while dragging."
                  defaultChecked
                />
                <Checkbox label="Include bleed" defaultChecked />
                <Checkbox label="Some pages selected" checked="indeterminate" />
                <Checkbox label="Disabled option" disabled />
              </Row>
              <Row label="Export format" className="flex-col items-start">
                <RadioGroup defaultValue="png" aria-label="Export format">
                  <RadioGroupItem value="png" label="PNG" description="Best for social" />
                  <RadioGroupItem value="pdf" label="PDF" description="Vector, print ready" />
                  <RadioGroupItem value="svg" label="SVG" />
                </RadioGroup>
              </Row>
            </div>
            <Row label="Segmented">
              <SegmentedControl
                aria-label="Units"
                defaultValue="px"
                options={[
                  { value: "px", label: "px" },
                  { value: "mm", label: "mm" },
                  { value: "in", label: "in" },
                  { value: "pt", label: "pt" },
                ]}
              />
              <SegmentedControl
                aria-label="View"
                size="sm"
                defaultValue="grid"
                options={[
                  { value: "grid", label: "Grid" },
                  { value: "list", label: "List" },
                ]}
              />
            </Row>
          </Stack>
        );
      }}
    </Showcase>
  );
}
