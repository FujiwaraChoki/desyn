"use client";

import { Button, EmptyState, Orbs, Skeleton, SunMark, SunSpinner } from "@desyn/ui";
import { FileQuestion, KeyRound, LockKeyhole, LogIn, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/** Full-window loading state: the editor's silhouette with a sun spinner. */
export function LoadingScreen({ label = "Opening your design" }: { label?: string }) {
  return (
    <div
      className="relative flex h-dvh w-full flex-col overflow-hidden bg-background text-fg"
      aria-busy
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line-subtle bg-surface-1 px-3">
        <SunMark size={18} />
        <Skeleton className="h-4 w-40" />
        <div className="flex-1" />
        <Skeleton className="h-7 w-20 rounded-full" />
        <Skeleton className="h-7 w-24 rounded-full" />
      </div>
      <div className="relative grid flex-1 place-items-center bg-canvas">
        <Orbs intensity={0.5} className="opacity-60" />
        <div className="relative flex flex-col items-center gap-4">
          <SunSpinner size="lg" label={label} />
          <p className="font-serif text-2xl text-fg">
            opening your <em className="text-accent">design</em>
          </p>
        </div>
      </div>
    </div>
  );
}

interface ErrorInfo {
  icon: ReactNode;
  title: ReactNode;
  description: string;
  action: { label: string; href: string; icon?: ReactNode };
}

/** Message for a load error (`SyncSnapshot.error`). */
export function describeLoadError(
  error: { code: string; message: string; reason?: string },
  ctx: { exitHref: string; shareToken: string | null; designId: string },
): ErrorInfo {
  const back = { label: "Back to designs", href: ctx.exitHref };
  if (error.reason === "password_required" || error.reason === "wrong_password") {
    return {
      icon: <KeyRound />,
      title: (
        <>
          this design is <em className="text-accent">protected</em>
        </>
      ),
      description: "Enter the link password to open it.",
      action: {
        label: "Enter password",
        href: ctx.shareToken ? `/share/${encodeURIComponent(ctx.shareToken)}` : ctx.exitHref,
      },
    };
  }
  switch (error.code) {
    case "NOT_FOUND":
      return {
        icon: <FileQuestion />,
        title: (
          <>
            this design is <em className="text-accent">gone</em>
          </>
        ),
        description:
          "It was deleted, or the link is wrong. Designs in the trash can be restored from there.",
        action: back,
      };
    case "FORBIDDEN":
      return {
        icon: <LockKeyhole />,
        title: (
          <>
            you don't have <em className="text-accent">access</em>
          </>
        ),
        description: "Ask the owner to share this design with you.",
        action: back,
      };
    case "EXPIRED":
      return {
        icon: <LockKeyhole />,
        title: (
          <>
            this link has <em className="text-accent">expired</em>
          </>
        ),
        description: "Ask the owner for a new link.",
        action: back,
      };
    case "UNAUTHENTICATED":
      return {
        icon: <LogIn />,
        title: (
          <>
            sign in to <em className="text-accent">continue</em>
          </>
        ),
        description: "Your session ended.",
        action: {
          label: "Sign in",
          href: `/login?next=${encodeURIComponent(`/design/${ctx.designId}`)}`,
          icon: <LogIn />,
        },
      };
    default:
      return {
        icon: <TriangleAlert />,
        title: (
          <>
            something went <em className="text-accent">wrong</em>
          </>
        ),
        description: `${error.message} Reload to try again.`,
        action: { label: "Reload", href: "" },
      };
  }
}

export function ErrorScreen({ info }: { info: ErrorInfo }) {
  return (
    <div className="relative grid h-dvh w-full place-items-center overflow-hidden bg-background px-4 text-fg">
      <Orbs intensity={0.4} className="opacity-50" />
      <EmptyState
        className="relative"
        icon={info.icon}
        title={info.title}
        description={info.description}
        action={
          info.action.href ? (
            <Button asChild variant="primary" leadingIcon={info.action.icon}>
              <a href={info.action.href}>{info.action.label}</a>
            </Button>
          ) : (
            <Button variant="primary" onClick={() => window.location.reload()}>
              {info.action.label}
            </Button>
          )
        }
      />
    </div>
  );
}
