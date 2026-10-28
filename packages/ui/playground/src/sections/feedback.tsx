import {
  Avatar,
  AvatarStack,
  Badge,
  Button,
  Callout,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  CircularProgress,
  EmptyState,
  ProBadge,
  Progress,
  Skeleton,
  SunSpinner,
} from "@desyn/ui";
import { FolderPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { collaborators } from "../data.ts";
import { Row, Showcase, Stack } from "../showcase.tsx";

function useTicker(): number {
  const [v, setV] = useState(36);
  useEffect(() => {
    const id = window.setInterval(() => setV((x) => (x >= 100 ? 8 : x + 4)), 700);
    return () => window.clearInterval(id);
  }, []);
  return v;
}

export function FeedbackSection() {
  return (
    <Showcase
      id="feedback"
      eyebrow="Feedback"
      title={
        <>
          status, said <em>softly</em>
        </>
      }
      description="Badges, progress, skeletons, callouts, avatars with presence and empty states with one clear action."
    >
      {() => <FeedbackPanel />}
    </Showcase>
  );
}

function FeedbackPanel() {
  const value = useTicker();
  return (
    <Stack>
      <Row label="Badges">
        <ProBadge />
        <Badge tone="accent">New</Badge>
        <Badge tone="success" dot>
          Synced
        </Badge>
        <Badge tone="warning">Draft</Badge>
        <Badge tone="danger">Failed</Badge>
        <Badge tone="info">Beta</Badge>
        <Badge>12 pages</Badge>
        <Badge tone="outline">Template</Badge>
      </Row>
      <Row label="Progress" className="flex-col items-stretch gap-3">
        <Progress value={value} label="Upload progress" />
        <Progress value={null} size="sm" label="Rendering" />
        <div className="flex items-center gap-4">
          <CircularProgress value={value} size={40} showValue label="Export progress" />
          <CircularProgress value={null} size={24} label="Loading" />
          <SunSpinner size="lg" label="Loading" />
          <SunSpinner size="xl" label="Loading" />
        </div>
      </Row>
      <Row label="Skeleton" className="block">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Skeleton className="aspect-[4/5]" />
          <Skeleton className="aspect-[4/5]" />
          <Skeleton className="aspect-[4/5]" />
        </div>
      </Row>
      <Row label="Avatars and presence">
        <Avatar name="Amira Haddad" size="lg" ring="#FFB02E" status="online" />
        <Avatar name="Jonas Weber" size="md" ring="#5AA9FF" status="away" />
        <Avatar name="Léa Martin" size="sm" />
        <AvatarStack people={collaborators} max={4} size="md" />
      </Row>
      <Row label="Callouts" className="flex-col items-stretch">
        <Callout
          tone="accent"
          title="You have 412 AI credits left"
          action={
            <Button size="sm" variant="ghost">
              Top up
            </Button>
          }
        >
          Credits reset on November 1.
        </Callout>
        <Callout tone="warning" title="Low resolution image">
          “dunes.jpg” prints soft at this size. Use an image at least 2400 px wide.
        </Callout>
        <Callout tone="danger" title="Export failed">
          The render worker timed out. Try again, or export pages one at a time.
        </Callout>
      </Row>
      <div className="grid gap-3 sm:grid-cols-2">
        <Card glow>
          <CardHeader>
            <CardTitle>
              Pro <em className="text-accent">plan</em>
            </CardTitle>
            <CardDescription>Everything, with fair-use AI.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-serif text-[40px] leading-none text-fg">
              $8<span className="font-sans text-sm text-fg-muted"> / month</span>
            </p>
          </CardContent>
          <CardFooter>
            <Button variant="primary" size="sm" className="w-full">
              Upgrade
            </Button>
          </CardFooter>
        </Card>
        <Card className="flex items-center justify-center">
          <EmptyState
            size="sm"
            icon={<FolderPlus />}
            title={
              <>
                no designs <em>yet</em>
              </>
            }
            description="Start from a template or describe what you need."
            action={
              <Button variant="primary" size="sm">
                New design
              </Button>
            }
          />
        </Card>
      </div>
    </Stack>
  );
}
