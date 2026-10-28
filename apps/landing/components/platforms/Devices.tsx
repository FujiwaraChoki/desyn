import { SunMark } from "@/components/site/Logo";
import { TemplateArt } from "@/components/templates/TemplateArt";
import { TEMPLATE_SPECS, type TemplateSpec } from "@/lib/templates";

/* Device frames drawn in CSS, each showing a miniature of the Desyn editor. */

const spec = (slug: string) => TEMPLATE_SPECS.find((t) => t.slug === slug) as TemplateSpec;

function MiniEditor({
  slug,
  rails = true,
  inspector = true,
  idSuffix,
}: {
  slug: string;
  rails?: boolean;
  inspector?: boolean;
  idSuffix: string;
}) {
  return (
    <div className="flex h-full w-full flex-col bg-[#111]">
      <div className="flex h-[9%] min-h-[14px] items-center gap-[3%] border-b border-white/[0.06] px-[3%]">
        <SunMark size={9} />
        <span className="h-[18%] w-[16%] rounded-full bg-white/15" />
        <span className="ml-auto h-[38%] w-[10%] rounded-full bg-[#ffb02e]" />
      </div>
      <div className="flex min-h-0 flex-1">
        {rails && (
          <div className="flex w-[16%] flex-col gap-[6%] border-r border-white/[0.06] p-[3%]">
            {[70, 55, 80, 45, 62].map((w) => (
              <span
                key={w}
                className="h-[4%] rounded-full bg-white/10"
                style={{ width: `${w}%` }}
              />
            ))}
          </div>
        )}
        <div className="dot-grid relative flex flex-1 items-center justify-center [--canvas:#0e0e0e]">
          <div className="h-[78%] overflow-hidden rounded-[2px] shadow-[0_10px_30px_-10px_rgba(0,0,0,.8)]">
            <TemplateArt spec={spec(slug)} idSuffix={idSuffix} className="block h-full w-auto" />
          </div>
          <div className="absolute bottom-[6%] left-1/2 flex h-[9%] w-[46%] -translate-x-1/2 items-center gap-[4%] rounded-full border border-white/10 bg-[#171717]/90 px-[4%]">
            <span className="h-[30%] flex-1 rounded-full bg-white/10" />
            <span className="aspect-square h-[60%] rounded-full bg-[#ffb02e]" />
          </div>
        </div>
        {inspector && (
          <div className="flex w-[18%] flex-col gap-[5%] border-l border-white/[0.06] p-[3%]">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-[6%] rounded-[2px] bg-white/[0.07]" />
            ))}
            <div className="mt-[6%] flex gap-[6%]">
              {["#f6ebdd", "#f4a63a", "#2a1a0e"].map((c) => (
                <span
                  key={c}
                  className="aspect-square flex-1 rounded-[2px]"
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function BrowserFrame() {
  return (
    <div className="panel-edge overflow-hidden rounded-[14px] border border-fg/10 bg-[#161616]">
      <div className="flex h-8 items-center gap-2 border-b border-white/[0.06] px-3">
        <span className="size-2 rounded-full bg-white/15" />
        <span className="size-2 rounded-full bg-white/15" />
        <span className="size-2 rounded-full bg-white/15" />
        <span className="mx-auto flex h-5 w-1/2 items-center justify-center rounded-md bg-white/[0.06] font-mono text-[10px] text-white/60">
          app.desyn.app
        </span>
      </div>
      <div className="aspect-[16/10]">
        <MiniEditor slug="slow-mornings" idSuffix="-dev-web" />
      </div>
    </div>
  );
}

export function DesktopFrame() {
  return (
    <div>
      <div className="panel-edge overflow-hidden rounded-[12px] border-[6px] border-[#1d1d1d] bg-[#1d1d1d] ring-1 ring-fg/10">
        <div className="aspect-[16/10] overflow-hidden rounded-[6px]">
          <MiniEditor slug="quarterly" idSuffix="-dev-desk" />
        </div>
      </div>
      <div className="mx-auto h-3 w-[22%] bg-gradient-to-b from-[#2a2a2a] to-[#1a1a1a]" />
      <div className="mx-auto h-1.5 w-[38%] rounded-t-md bg-[#2a2a2a]" />
    </div>
  );
}

export function PhoneFrame() {
  return (
    <div className="panel-edge mx-auto aspect-[9/19.5] w-full overflow-hidden rounded-[18%/8.5%] border-[5px] border-[#232323] bg-[#111] ring-1 ring-fg/10">
      <div className="relative flex h-full flex-col">
        <div className="mx-auto mt-[4%] h-[3.2%] w-[32%] rounded-full bg-black" />
        <div className="flex items-center justify-between px-[8%] pt-[5%]">
          <SunMark size={10} />
          <span className="h-1.5 w-1/3 rounded-full bg-white/15" />
          <span className="size-3 rounded-full bg-[#ffb02e]" />
        </div>
        <div className="dot-grid mt-[5%] flex flex-1 items-center justify-center [--canvas:#0e0e0e]">
          <div className="w-[78%] overflow-hidden rounded-[3px] shadow-[0_10px_30px_-10px_rgba(0,0,0,.8)]">
            <TemplateArt
              spec={spec("run-club")}
              idSuffix="-dev-ios"
              className="block h-auto w-full"
            />
          </div>
        </div>
        <div className="mx-[6%] mb-[8%] mt-[4%] flex h-[6%] items-center gap-2 rounded-full border border-white/10 bg-[#171717] px-[5%]">
          <span className="h-1.5 flex-1 rounded-full bg-white/10" />
          <span className="aspect-square h-[60%] rounded-full bg-[#ffb02e]" />
        </div>
      </div>
    </div>
  );
}
