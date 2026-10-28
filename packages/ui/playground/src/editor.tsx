import {
  AvatarStack,
  Button,
  CollapsibleSection,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  FontPickerButton,
  IconButton,
  Logo,
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
  moveTreeNodes,
  NumberField,
  type Paint,
  PaintSwatchButton,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  SegmentedControl,
  Select,
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Slider,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToggleGroup,
  ToggleGroupItem,
  Toolbar,
  ToolbarButton,
  ToolbarSeparator,
  ToolbarToggleGroup,
  ToolbarToggleItem,
  Tree,
  type TreeNode,
  TreeRowToggle,
  toast,
} from "@desyn/ui";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Circle,
  Component,
  Eye,
  EyeOff,
  Frame,
  Group,
  Hand,
  ImageIcon,
  Layers,
  LayoutTemplate,
  Lock,
  MessageSquareText,
  MousePointer2,
  PanelRight,
  PenLine,
  PenTool,
  Plus,
  Redo2,
  RotateCw,
  Shapes,
  Slash,
  Square,
  Type,
  Undo2,
  Unlock,
  Upload,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  collaborators,
  type Layer,
  loadPlaygroundFont,
  playgroundFonts,
  posterLayers,
} from "./data.ts";

const KIND_ICONS: Record<Layer["kind"], ReactNode> = {
  page: <LayoutTemplate />,
  frame: <Frame />,
  group: <Group />,
  text: <Type />,
  image: <ImageIcon />,
  rect: <Square />,
  ellipse: <Circle />,
  path: <PenTool />,
};

function updateLayer(
  nodes: TreeNode<Layer>[],
  id: string,
  patch: Partial<Layer>,
): TreeNode<Layer>[] {
  return nodes.map((n) =>
    n.id === id
      ? { ...n, data: { ...(n.data as Layer), ...patch } }
      : n.children
        ? { ...n, children: updateLayer(n.children, id, patch) }
        : n,
  );
}

/** Layers panel: the Tree with rename, drag & drop, lock and visibility. */
export function LayersPanel({ className }: { className?: string }) {
  const [layers, setLayers] = useState(posterLayers);
  const [selected, setSelected] = useState<string[]>(["txt-headline"]);
  const [expanded, setExpanded] = useState<string[]>(["frame-poster", "grp-header", "grp-sun"]);
  return (
    <Tree<Layer>
      aria-label="Layers"
      className={className}
      items={layers}
      getLabel={(n) => n.data?.name ?? n.id}
      renderIcon={(n) => KIND_ICONS[n.data?.kind ?? "rect"]}
      isDimmed={(n) => !!n.data?.hidden}
      selected={selected}
      onSelectedChange={setSelected}
      expanded={expanded}
      onExpandedChange={setExpanded}
      onRename={(id, name) => setLayers((l) => updateLayer(l, id, { name }))}
      onMove={(ids, parentId, index) => setLayers((l) => moveTreeNodes(l, ids, parentId, index))}
      canHaveChildren={(n) => n.data?.kind === "frame" || n.data?.kind === "group"}
      renderActions={(n) => (
        <>
          <TreeRowToggle
            label={n.data?.locked ? "Unlock layer" : "Lock layer"}
            active={!!n.data?.locked}
            onToggle={() => setLayers((l) => updateLayer(l, n.id, { locked: !n.data?.locked }))}
            icon={<Unlock />}
            activeIcon={<Lock />}
          />
          <TreeRowToggle
            label={n.data?.hidden ? "Show layer" : "Hide layer"}
            active={!!n.data?.hidden}
            onToggle={() => setLayers((l) => updateLayer(l, n.id, { hidden: !n.data?.hidden }))}
            icon={<Eye />}
            activeIcon={<EyeOff />}
          />
        </>
      )}
    />
  );
}

/** Right inspector with dense numeric fields, paints, type and effects. */
export function Inspector() {
  const [geom, setGeom] = useState({ x: 96, y: 212, w: 888, h: 236, r: 0, radius: 0 });
  const [fill, setFill] = useState<Paint>({ type: "solid", color: "#1a1205" });
  const [bg, setBg] = useState<Paint>({
    type: "linear",
    angle: 160,
    stops: [
      { pos: 0, color: "#ffd66b" },
      { pos: 0.55, color: "#ffb02e" },
      { pos: 1, color: "#ff6a1f" },
    ],
  });
  const [stroke, setStroke] = useState<Paint>({ type: "solid", color: "#ffffff80" });
  const [font, setFont] = useState("Instrument Serif");
  const [opacity, setOpacity] = useState([100]);
  const [shadow, setShadow] = useState(true);
  const set = (k: keyof typeof geom) => (v: number) => setGeom((g) => ({ ...g, [k]: v }));

  return (
    <Tabs defaultValue="design" className="h-full gap-0">
      <TabsList className="shrink-0 px-3">
        <TabsTrigger value="design">Design</TabsTrigger>
        <TabsTrigger value="arrange">Arrange</TabsTrigger>
        <TabsTrigger value="animate">Animate</TabsTrigger>
      </TabsList>
      <TabsContent value="design" className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
        <CollapsibleSection title="Layout">
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField label="X" size="sm" value={geom.x} onChange={set("x")} />
            <NumberField label="Y" size="sm" value={geom.y} onChange={set("y")} />
            <NumberField label="W" size="sm" value={geom.w} min={0} onChange={set("w")} />
            <NumberField label="H" size="sm" value={geom.h} min={0} onChange={set("h")} />
            <NumberField
              label={<RotateCw />}
              aria-label="Rotation"
              size="sm"
              value={geom.r}
              unit="°"
              onChange={set("r")}
            />
            <NumberField
              label={<Slash />}
              aria-label="Corner radius"
              size="sm"
              value={geom.radius}
              min={0}
              onChange={set("radius")}
            />
          </div>
        </CollapsibleSection>
        <div className="h-px bg-line-subtle" />
        <CollapsibleSection title="Text">
          <div className="flex flex-col gap-1.5">
            <FontPickerButton
              fonts={playgroundFonts}
              value={font}
              onChange={setFont}
              loadFont={loadPlaygroundFont}
            />
            <div className="grid grid-cols-[1fr_76px] gap-1.5">
              <Select
                aria-label="Font weight"
                size="sm"
                defaultValue="400"
                options={[
                  { value: "400", label: "Regular" },
                  { value: "400i", label: "Italic" },
                ]}
              />
              <NumberField aria-label="Font size" size="sm" defaultValue={96} min={1} unit="px" />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <NumberField
                label="LH"
                aria-label="Line height"
                size="sm"
                defaultValue={110}
                unit="%"
              />
              <NumberField
                label="LS"
                aria-label="Letter spacing"
                size="sm"
                defaultValue={-2}
                step={0.5}
                unit="%"
              />
            </div>
            <div className="flex items-center justify-between">
              <ToggleGroup type="single" defaultValue="left" aria-label="Text alignment">
                <ToggleGroupItem value="left" tooltip="Align left" size="xs">
                  <AlignLeft />
                </ToggleGroupItem>
                <ToggleGroupItem value="center" tooltip="Align center" size="xs">
                  <AlignCenter />
                </ToggleGroupItem>
                <ToggleGroupItem value="right" tooltip="Align right" size="xs">
                  <AlignRight />
                </ToggleGroupItem>
              </ToggleGroup>
              <SegmentedControl
                aria-label="Text case"
                size="sm"
                defaultValue="none"
                options={[
                  { value: "none", label: "Aa" },
                  { value: "upper", label: "AA" },
                  { value: "lower", label: "aa" },
                ]}
              />
            </div>
          </div>
        </CollapsibleSection>
        <div className="h-px bg-line-subtle" />
        <CollapsibleSection
          title="Fill"
          actions={
            <IconButton label="Add fill" size="xs">
              <Plus />
            </IconButton>
          }
        >
          <div className="flex flex-col gap-1.5">
            <PaintSwatchButton
              label="Text fill"
              value={fill}
              onChange={setFill}
              brandColors={["#ffb02e", "#1a1205", "#fff6e5"]}
            />
            <PaintSwatchButton
              label="Background fill"
              value={bg}
              onChange={setBg}
              brandColors={["#ffb02e", "#1a1205", "#fff6e5"]}
            />
          </div>
        </CollapsibleSection>
        <div className="h-px bg-line-subtle" />
        <CollapsibleSection title="Stroke" defaultOpen={false}>
          <div className="grid grid-cols-[1fr_72px] gap-1.5">
            <PaintSwatchButton label="Stroke" value={stroke} onChange={setStroke} />
            <NumberField
              aria-label="Stroke width"
              size="sm"
              defaultValue={1}
              min={0}
              step={0.5}
              unit="px"
            />
          </div>
        </CollapsibleSection>
        <div className="h-px bg-line-subtle" />
        <CollapsibleSection title="Effects">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between text-xs text-fg-secondary">
              <span>Drop shadow</span>
              <Switch
                size="sm"
                checked={shadow}
                onCheckedChange={setShadow}
                aria-label="Drop shadow"
              />
            </div>
            <div className="flex items-center gap-3">
              <span className="w-14 text-xs text-fg-muted">Opacity</span>
              <Slider
                size="sm"
                value={opacity}
                onValueChange={setOpacity}
                aria-label="Opacity"
                max={100}
              />
              <span className="w-9 text-right text-xs tabular-nums text-fg-secondary">
                {opacity[0]}%
              </span>
            </div>
          </div>
        </CollapsibleSection>
      </TabsContent>
      <TabsContent value="arrange" className="px-3 py-3 text-xs text-fg-muted">
        Alignment, distribution and auto layout controls live here.
      </TabsContent>
      <TabsContent value="animate" className="px-3 py-3 text-xs text-fg-muted">
        Entrance, exit and emphasis animations for the selection.
      </TabsContent>
    </Tabs>
  );
}

/** The user's design on the canvas (a poster) with a live selection frame. */
function PosterPage() {
  return (
    <div className="relative aspect-[4/5] w-[min(360px,72%)] overflow-hidden rounded-[2px] bg-[#fff6e5] shadow-page">
      <div
        className="absolute inset-0"
        style={{ background: "linear-gradient(160deg, #ffd66b 0%, #ffb02e 55%, #ff6a1f 100%)" }}
      />
      <div className="absolute top-[42%] left-1/2 aspect-square w-[46%] -translate-x-1/2 rounded-full bg-[#fff6e5]/90 blur-[1px]" />
      <div className="absolute top-[35%] left-1/2 aspect-square w-[66%] -translate-x-1/2 rounded-full bg-[#fff6e5]/25 blur-xl" />
      <div
        className="absolute inset-x-0 bottom-0 h-[34%] bg-[#1a1205]"
        style={{ clipPath: "ellipse(80% 60% at 30% 100%)" }}
      />
      <div className="absolute inset-x-[9%] top-[8%] text-[#1a1205]">
        <p className="text-[9px] font-semibold tracking-[0.3em] uppercase opacity-70">
          Summer launch · 2026
        </p>
        {/* Selected layer */}
        <div className="relative mt-2">
          <p className="font-serif text-[46px] leading-[0.95]">
            golden <em>hour</em>
          </p>
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-1 border border-selection"
          >
            {[
              "-top-1 -left-1",
              "-top-1 -right-1",
              "-bottom-1 -left-1",
              "-right-1 -bottom-1",
              "top-1/2 -left-1 -translate-y-1/2",
              "top-1/2 -right-1 -translate-y-1/2",
            ].map((pos) => (
              <span
                key={pos}
                className={`absolute size-2 border border-selection bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.2)] ${pos}`}
              />
            ))}
            <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 rounded-[4px] bg-selection px-1.5 py-0.5 font-sans text-[9px] font-medium whitespace-nowrap text-accent-ink">
              888 × 236
            </span>
          </div>
        </div>
        <p className="mt-9 max-w-[70%] text-[10px] leading-snug opacity-80">
          An evening of light, sound and long shadows.
        </p>
      </div>
      <div className="absolute bottom-[8%] left-[9%] rounded-full bg-[#fff6e5] px-3 py-1.5 text-[9px] font-semibold text-[#1a1205]">
        Reserve a seat
      </div>
    </div>
  );
}

const RAIL = [
  { id: "design", label: "Design", icon: <LayoutTemplate /> },
  { id: "elements", label: "Elements", icon: <Shapes /> },
  { id: "text", label: "Text", icon: <Type /> },
  { id: "brand", label: "Brand", icon: <Component /> },
  { id: "uploads", label: "Uploads", icon: <Upload /> },
  { id: "ai", label: "AI", icon: <MessageSquareText /> },
  { id: "layers", label: "Layers", icon: <Layers /> },
];

/** Realistic editor chrome assembled from the library. */
export function EditorComposition() {
  const [tool, setTool] = useState("select");
  const [rail, setRail] = useState("layers");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  return (
    <div className="flex h-[760px] flex-col overflow-hidden rounded-panel border border-line-subtle bg-surface-1 shadow-dialog max-md:h-[640px]">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line-subtle px-2.5">
        <Logo variant="mark" size={20} className="px-1" />
        <Menubar className="max-lg:hidden">
          <MenubarMenu>
            <MenubarTrigger>File</MenubarTrigger>
            <MenubarContent>
              <MenubarItem shortcut="mod+n">New design</MenubarItem>
              <MenubarItem shortcut="mod+o">Open…</MenubarItem>
              <MenubarSeparator />
              <MenubarItem shortcut="mod+shift+e">Export…</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger>Edit</MenubarTrigger>
            <MenubarContent>
              <MenubarItem shortcut="mod+z">Undo</MenubarItem>
              <MenubarItem shortcut="mod+shift+z">Redo</MenubarItem>
              <MenubarSeparator />
              <MenubarItem shortcut="mod+d">Duplicate</MenubarItem>
              <MenubarItem destructive shortcut="delete">
                Delete
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger>View</MenubarTrigger>
            <MenubarContent>
              <MenubarItem shortcut="shift+r">Rulers</MenubarItem>
              <MenubarItem shortcut="mod+'">Grid</MenubarItem>
              <MenubarItem shortcut="shift+1">Zoom to fit</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>
        <div className="mx-1 h-5 w-px bg-line-subtle max-lg:hidden" />
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="text-fg-muted max-sm:hidden">Launch /</span>
          <span className="truncate font-medium text-fg">Golden hour poster</span>
        </div>
        <div className="ml-2 flex items-center gap-0.5 max-sm:hidden">
          <IconButton label="Undo" shortcut="mod+z" size="sm">
            <Undo2 />
          </IconButton>
          <IconButton label="Redo" shortcut="mod+shift+z" size="sm">
            <Redo2 />
          </IconButton>
        </div>
        <div className="flex-1" />
        <AvatarStack people={collaborators} max={3} className="max-md:hidden" />
        <Button variant="ghost" size="sm" className="max-sm:hidden">
          Ask AI
        </Button>
        <Button variant="secondary" size="sm" className="max-sm:hidden">
          Share
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => toast.success("Export started", { description: "PNG · 2x · 1080 × 1350" })}
        >
          Export
        </Button>
        <IconButton
          label="Open inspector"
          size="sm"
          className="md:hidden"
          onClick={() => setInspectorOpen(true)}
        >
          <PanelRight />
        </IconButton>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left rail */}
        <nav
          aria-label="Panels"
          className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line-subtle py-2 max-md:hidden"
        >
          {RAIL.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={rail === r.id}
              onClick={() => setRail(r.id)}
              className="group flex w-12 cursor-pointer flex-col items-center gap-1 rounded-[8px] py-1.5 text-[10px] text-fg-muted transition-colors hover:text-fg aria-pressed:text-fg"
            >
              <span className="grid size-8 place-items-center rounded-[8px] transition-colors group-hover:bg-fg/6 group-aria-pressed:bg-fg/8 group-aria-pressed:text-accent [&_svg]:size-[18px]">
                {r.icon}
              </span>
              {r.label}
            </button>
          ))}
        </nav>

        <ResizablePanelGroup autoSaveId="playground-editor" className="min-w-0 flex-1">
          <ResizablePanel
            id="left"
            defaultSize={256}
            minSize={200}
            maxSize={400}
            collapsible
            className="max-md:hidden"
          >
            <div className="flex h-full flex-col">
              <div className="flex h-10 shrink-0 items-center justify-between px-3">
                <span className="text-xs font-medium text-fg">Layers</span>
                <IconButton label="New group" size="xs">
                  <Plus />
                </IconButton>
              </div>
              <LayersPanel className="min-h-0 flex-1" />
            </div>
          </ResizablePanel>
          <ResizableHandle aria-label="Resize layers panel" className="max-md:hidden" />
          <ResizablePanel id="canvas">
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="dsn-dot-grid relative flex h-full items-center justify-center overflow-hidden">
                  <PosterPage />
                  <Toolbar
                    aria-label="Tools"
                    className="absolute bottom-4 left-1/2 -translate-x-1/2"
                  >
                    <ToolbarToggleGroup
                      type="single"
                      value={tool}
                      onValueChange={(v) => v && setTool(v)}
                      aria-label="Tool"
                    >
                      <ToolbarToggleItem value="select" label="Select" shortcut="v">
                        <MousePointer2 />
                      </ToolbarToggleItem>
                      <ToolbarToggleItem value="frame" label="Frame" shortcut="f">
                        <Frame />
                      </ToolbarToggleItem>
                      <ToolbarToggleItem value="rect" label="Rectangle" shortcut="r">
                        <Square />
                      </ToolbarToggleItem>
                      <ToolbarToggleItem
                        value="ellipse"
                        label="Ellipse"
                        shortcut="o"
                        className="max-sm:hidden"
                      >
                        <Circle />
                      </ToolbarToggleItem>
                      <ToolbarToggleItem value="pen" label="Pen" shortcut="p">
                        <PenTool />
                      </ToolbarToggleItem>
                      <ToolbarToggleItem value="text" label="Text" shortcut="t">
                        <Type />
                      </ToolbarToggleItem>
                      <ToolbarToggleItem
                        value="image"
                        label="Image"
                        shortcut="shift+mod+k"
                        className="max-sm:hidden"
                      >
                        <ImageIcon />
                      </ToolbarToggleItem>
                      <ToolbarToggleItem value="hand" label="Hand" shortcut="h">
                        <Hand />
                      </ToolbarToggleItem>
                    </ToolbarToggleGroup>
                    <ToolbarSeparator />
                    <ToolbarButton
                      label="Generate with AI"
                      shortcut="mod+j"
                      className="text-accent"
                    >
                      <MessageSquareText />
                    </ToolbarButton>
                  </Toolbar>
                  <div className="absolute top-3 right-3 rounded-full border border-line-subtle bg-glass px-2.5 py-1 text-2xs tabular-nums text-fg-secondary backdrop-blur-md">
                    84%
                  </div>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem shortcut="mod+c">Copy</ContextMenuItem>
                <ContextMenuItem shortcut="mod+v">Paste</ContextMenuItem>
                <ContextMenuItem shortcut="mod+d">Duplicate</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem icon={<PenLine />}>Edit with AI…</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem destructive shortcut="delete">
                  Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </ResizablePanel>
          <ResizableHandle aria-label="Resize inspector" className="max-md:hidden" />
          <ResizablePanel
            id="right"
            defaultSize={280}
            minSize={240}
            maxSize={420}
            className="max-md:hidden"
          >
            <Inspector />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
        <SheetContent side="bottom" className="h-[75dvh]">
          <SheetHeader>
            <SheetTitle>Inspector</SheetTitle>
          </SheetHeader>
          <SheetBody className="px-0 pb-0">
            <Inspector />
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
