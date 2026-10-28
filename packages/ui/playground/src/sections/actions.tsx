import {
  Button,
  ButtonGroup,
  IconButton,
  Kbd,
  Shortcut,
  SunSpinner,
  Toggle,
  ToggleGroup,
  ToggleGroupItem,
} from "@desyn/ui";
import {
  AlignHorizontalJustifyCenter,
  ArrowRight,
  ArrowUp,
  Bold,
  Copy,
  Download,
  Italic,
  Plus,
  Trash2,
  Underline,
} from "lucide-react";
import { useState } from "react";
import { Row, Showcase, Stack } from "../showcase.tsx";

function LoadingDemo() {
  const [loading, setLoading] = useState(false);
  return (
    <Button
      variant="primary"
      loading={loading}
      onClick={() => {
        setLoading(true);
        window.setTimeout(() => setLoading(false), 1800);
      }}
    >
      {loading ? "Generating" : "Generate design"}
    </Button>
  );
}

export function ActionsSection() {
  return (
    <Showcase
      id="actions"
      eyebrow="Actions"
      title={
        <>
          one sun, <em>many</em> quiet buttons
        </>
      }
      description="Primary is the single sun-filled action on a surface. Everything else stays calm until touched."
    >
      {() => (
        <Stack>
          <Row label="Variants">
            <Button variant="primary" trailingIcon={<ArrowRight />}>
              Start designing
            </Button>
            <Button variant="secondary">Share</Button>
            <Button variant="outline">Learn more</Button>
            <Button variant="ghost">Ask AI</Button>
            <Button variant="danger" leadingIcon={<Trash2 />}>
              Delete
            </Button>
            <Button variant="link">View changelog</Button>
          </Row>
          <Row label="Sizes">
            <Button variant="primary" size="xs">
              Extra small
            </Button>
            <Button variant="primary" size="sm">
              Small
            </Button>
            <Button variant="primary" size="md">
              Medium
            </Button>
            <Button variant="primary" size="lg">
              Large
            </Button>
            <Button variant="primary" size="xl" shape="pill">
              Get Desyn
            </Button>
          </Row>
          <Row label="Loading and disabled">
            <LoadingDemo />
            <Button variant="secondary" loading>
              Saving
            </Button>
            <Button variant="secondary" disabled>
              Disabled
            </Button>
            <SunSpinner size="lg" label="Loading" />
          </Row>
          <Row label="Icon buttons">
            <IconButton label="Add" size="xs">
              <Plus />
            </IconButton>
            <IconButton label="Duplicate" shortcut="mod+d" size="sm">
              <Copy />
            </IconButton>
            <IconButton label="Download" size="md" variant="secondary">
              <Download />
            </IconButton>
            <IconButton label="Generate" size="lg" variant="primary">
              <ArrowUp />
            </IconButton>
            <IconButton label="Center" active>
              <AlignHorizontalJustifyCenter />
            </IconButton>
            <IconButton label="Delete" variant="danger">
              <Trash2 />
            </IconButton>
          </Row>
          <Row label="Groups and toggles">
            <ButtonGroup label="History">
              <Button size="sm">Undo</Button>
              <Button size="sm">Redo</Button>
            </ButtonGroup>
            <ToggleGroup type="multiple" defaultValue={["bold"]} aria-label="Text style">
              <ToggleGroupItem value="bold" tooltip="Bold" shortcut="mod+b">
                <Bold />
              </ToggleGroupItem>
              <ToggleGroupItem value="italic" tooltip="Italic" shortcut="mod+i">
                <Italic />
              </ToggleGroupItem>
              <ToggleGroupItem value="underline" tooltip="Underline" shortcut="mod+u">
                <Underline />
              </ToggleGroupItem>
            </ToggleGroup>
            <Toggle tooltip="Snap to grid" defaultPressed>
              <span className="text-xs">Snap</span>
            </Toggle>
          </Row>
          <Row label="Keyboard">
            <Shortcut keys="mod+k" />
            <Shortcut keys="mod+shift+z" />
            <Shortcut keys="alt+enter" />
            <Kbd>Esc</Kbd>
            <Shortcut keys="mod+shift+e" variant="text" />
          </Row>
        </Stack>
      )}
    </Showcase>
  );
}
