import type { Metadata } from "next";
import { Projects } from "@/components/dashboard/projects";
import { translate } from "@/lib/i18n-core";

export const metadata: Metadata = { title: translate("en", "dashboard.projects.title") };

export default function ProjectsPage() {
  return <Projects folderId={null} />;
}
