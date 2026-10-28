import {
  Avatar,
  Button,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandPalette,
  CommandSeparator,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Field,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Shortcut,
  Switch,
  Tooltip,
  toast,
  useConfirm,
} from "@desyn/ui";
import {
  Copy,
  FileImage,
  FilePlus2,
  FolderOpen,
  LayoutTemplate,
  MessageSquareText,
  MoreHorizontal,
  Palette,
  PenLine,
  Settings2,
  Share2,
  Trash2,
  Type,
} from "lucide-react";
import { useState } from "react";
import { Row, Showcase, Stack } from "../showcase.tsx";

function ConfirmDemo() {
  const confirm = useConfirm();
  return (
    <Button
      variant="secondary"
      leadingIcon={<Trash2 />}
      onClick={async () => {
        const ok = await confirm({
          title: "Delete this page?",
          description: "Page 3 and its 14 layers will be removed. You can undo this from history.",
          confirmLabel: "Delete page",
          tone: "danger",
        });
        if (ok)
          toast("Page deleted", {
            action: { label: "Undo", onClick: () => toast.success("Restored") },
          });
      }}
    >
      Delete page…
    </Button>
  );
}

function PaletteDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        trailingIcon={<Shortcut keys="mod+k" />}
      >
        Command palette
      </Button>
      <CommandPalette open={open} onOpenChange={setOpen} shortcut={null}>
        <CommandEmpty>Nothing matches. Try “export” or “text”.</CommandEmpty>
        <CommandGroup heading="Create">
          <CommandItem icon={<FilePlus2 />} shortcut="mod+n" onSelect={() => setOpen(false)}>
            New design
          </CommandItem>
          <CommandItem icon={<LayoutTemplate />} onSelect={() => setOpen(false)}>
            Browse templates
          </CommandItem>
          <CommandItem
            icon={<MessageSquareText />}
            shortcut="mod+j"
            keywords={["ai", "generate"]}
            onSelect={() => setOpen(false)}
          >
            Generate with AI
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Insert">
          <CommandItem icon={<Type />} shortcut="t" onSelect={() => setOpen(false)}>
            Text
          </CommandItem>
          <CommandItem icon={<FileImage />} onSelect={() => setOpen(false)} hint="Uploads">
            Image
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Settings">
          <CommandItem icon={<Palette />} onSelect={() => setOpen(false)}>
            Brand kit
          </CommandItem>
          <CommandItem icon={<Settings2 />} shortcut="mod+," onSelect={() => setOpen(false)}>
            Preferences
          </CommandItem>
        </CommandGroup>
      </CommandPalette>
    </>
  );
}

function MenuDemo() {
  const [rulers, setRulers] = useState(true);
  const [zoom, setZoom] = useState("fit");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="More actions" variant="secondary">
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Design</DropdownMenuLabel>
        <DropdownMenuItem icon={<Copy />} shortcut="mod+d">
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Share2 />} shortcut="mod+shift+s">
          Share
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger icon={<FolderOpen />}>Move to</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Launch</DropdownMenuItem>
            <DropdownMenuItem>Brand</DropdownMenuItem>
            <DropdownMenuItem>Archive</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={rulers}
          onCheckedChange={(v) => setRulers(v === true)}
          shortcut="shift+r"
        >
          Show rulers
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={zoom} onValueChange={setZoom}>
          <DropdownMenuRadioItem value="fit">Zoom to fit</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="100">100%</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive icon={<Trash2 />} shortcut="delete">
          Move to trash
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function OverlaysSection() {
  return (
    <Showcase
      id="overlays"
      eyebrow="Overlays"
      title={
        <>
          surfaces made of <em>glass</em>
        </>
      }
      description="Menus, popovers and dialogs float over the canvas with blur and a hairline. Overlays opened in a themed scope keep its theme."
    >
      {() => (
        <Stack>
          <Row label="Menus and popovers">
            <MenuDemo />
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="secondary">Popover</Button>
              </PopoverTrigger>
              <PopoverContent align="start">
                <div className="flex flex-col gap-3">
                  <p className="font-serif text-lg text-fg">Page size</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Input size="sm" defaultValue="1080" aria-label="Width" trailing="px" />
                    <Input size="sm" defaultValue="1350" aria-label="Height" trailing="px" />
                  </div>
                  <Switch size="sm" label="Resize content" defaultChecked />
                </div>
              </PopoverContent>
            </Popover>
            <Tooltip content="Tooltips wait 400 ms" shortcut="mod+/">
              <Button variant="ghost">Hover for tooltip</Button>
            </Tooltip>
            <HoverCard>
              <HoverCardTrigger asChild>
                <button type="button" className="cursor-pointer rounded-full">
                  <Avatar name="Amira Haddad" ring="#FFB02E" status="online" />
                </button>
              </HoverCardTrigger>
              <HoverCardContent>
                <div className="flex gap-3">
                  <Avatar name="Amira Haddad" size="lg" />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-fg">Amira Haddad</span>
                    <span className="text-xs text-fg-muted">Editing “Headline” · 2 min ago</span>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          </Row>
          <Row label="Dialogs">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="primary">Export…</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    Export <em>design</em>
                  </DialogTitle>
                  <DialogDescription>
                    Choose a format. Exports render on our servers at full quality.
                  </DialogDescription>
                </DialogHeader>
                <DialogBody className="flex flex-col gap-4">
                  <RadioGroup defaultValue="png" aria-label="Format">
                    <RadioGroupItem
                      value="png"
                      label="PNG"
                      description="Lossless, transparent background"
                    />
                    <RadioGroupItem
                      value="jpg"
                      label="JPG"
                      description="Smaller files for photos"
                    />
                    <RadioGroupItem
                      value="pdf"
                      label="PDF Print"
                      description="With bleed and crop marks"
                    />
                  </RadioGroup>
                  <Field label="File name">
                    <Input defaultValue="golden-hour-poster" trailing=".png" />
                  </Field>
                </DialogBody>
                <DialogFooter>
                  <Button variant="ghost">Cancel</Button>
                  <Button
                    variant="primary"
                    onClick={() =>
                      toast.success("Export ready", { description: "golden-hour-poster.png" })
                    }
                  >
                    Export
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <ConfirmDemo />
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="secondary">Open sheet</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Brand kit</SheetTitle>
                  <SheetDescription>Colors, fonts and logos the AI keeps to.</SheetDescription>
                </SheetHeader>
                <SheetBody className="flex flex-col gap-4">
                  <Field label="Kit name">
                    <Input defaultValue="Desyn" />
                  </Field>
                  <Switch label="Enforce brand fonts" defaultChecked />
                </SheetBody>
                <SheetFooter>
                  <Button variant="primary">Save kit</Button>
                </SheetFooter>
              </SheetContent>
            </Sheet>
            <PaletteDemo />
          </Row>
          <Row label="Context menu">
            <ContextMenu>
              <ContextMenuTrigger className="flex h-24 w-full items-center justify-center rounded-card border border-dashed border-line text-xs text-fg-muted">
                Right-click (or long-press) here
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem shortcut="mod+c">Copy</ContextMenuItem>
                <ContextMenuItem shortcut="mod+v">Paste</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem icon={<PenLine />}>Edit with AI…</ContextMenuItem>
                <ContextMenuItem destructive shortcut="delete">
                  Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </Row>
          <Row label="Toasts">
            <Button size="sm" onClick={() => toast("Design saved")}>
              Default
            </Button>
            <Button
              size="sm"
              onClick={() =>
                toast.success("Exported", { description: "golden-hour-poster.png · 2.4 MB" })
              }
            >
              Success
            </Button>
            <Button
              size="sm"
              onClick={() =>
                toast.error("Upload failed", {
                  description: "Files must be under 25 MB. Try compressing it.",
                })
              }
            >
              Error
            </Button>
            <Button
              size="sm"
              onClick={() =>
                toast.promise(new Promise((r) => window.setTimeout(r, 1600)), {
                  loading: "Generating 4 variants…",
                  success: "Variants ready",
                  error: "Generation failed",
                })
              }
            >
              Promise
            </Button>
          </Row>
        </Stack>
      )}
    </Showcase>
  );
}
