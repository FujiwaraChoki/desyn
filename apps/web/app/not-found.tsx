import { Button, Logo, Orbs } from "@desyn/ui";
import Link from "next/link";
import { Rich } from "@/components/rich";
import { translate } from "@/lib/i18n-core";

export default function NotFound() {
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-background px-6 text-center">
      <Orbs intensity={0.8} />
      <div className="relative flex max-w-lg flex-col items-center">
        <Logo size={22} />
        <p className="mt-14 font-serif text-[120px] leading-none text-accent">404</p>
        <h1 className="rich-title mt-6 font-serif text-[40px] leading-tight text-fg">
          <Rich text={translate("en", "common.errors.notFoundTitle")} />
        </h1>
        <p className="mt-3 text-sm text-fg-muted">
          {translate("en", "common.errors.notFoundBody")}
        </p>
        <Button asChild variant="primary" size="lg" shape="pill" className="mt-8">
          <Link href="/">{translate("en", "common.errors.goHome")}</Link>
        </Button>
      </div>
    </main>
  );
}
