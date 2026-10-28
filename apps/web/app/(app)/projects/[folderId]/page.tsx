import type { Metadata } from "next";
import { Projects } from "@/components/dashboard/projects";
import type { Id } from "@/lib/convex-api";
import { translate } from "@/lib/i18n-core";

export const metadata: Metadata = { title: translate("en", "dashboard.projects.title") };

export default async function FolderPage({ params }: { params: Promise<{ folderId: string }> }) {
  const { folderId } = await params;
  return <Projects key={folderId} folderId={folderId as Id<"folders">} />;
}
