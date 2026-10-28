"use client";

import { ErrorView } from "@/components/error-view";

export default function PresentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorView error={error} reset={reset} fullScreen />;
}
