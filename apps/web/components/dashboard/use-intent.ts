"use client";

import { toast } from "@desyn/ui";
import { useConvex } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useApp } from "@/components/app/app-context";
import { api } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { clearIntent, readIntent } from "@/lib/intent";
import { routes } from "@/lib/routes";

/**
 * Finishes what a visitor came for from the marketing site, once: open the template they picked,
 * or take them to checkout for Pro.
 */
export function useIntentRedirect() {
  const router = useRouter();
  const convex = useConvex();
  const { workspaceId, billing, me } = useApp();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    const intent = readIntent();
    if (!intent) return;
    handled.current = true;
    clearIntent();
    void (async () => {
      if (intent.template) {
        try {
          const template = await convex.query(api.templates.templates.get, {
            slug: intent.template,
          });
          if (template.canUse) {
            const { designId } = await convex.mutation(api.templates.templates.instantiate, {
              templateId: template.id,
              workspaceId,
            });
            router.push(routes.design(designId));
            return;
          }
          router.push(`${routes.templates}?preview=${encodeURIComponent(template.slug)}`);
          return;
        } catch (error) {
          toast.error(errorMessage(error));
        }
      }
      if (intent.plan === "pro" && billing && me.plan === "free") {
        router.push(
          `${routes.settings("billing")}?upgrade=1&interval=${intent.interval ?? "month"}`,
        );
      }
    })();
  }, [convex, router, workspaceId, billing, me.plan]);
}
