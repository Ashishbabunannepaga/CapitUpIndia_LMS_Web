import Image from "next/image";

import { cn } from "@/lib/utils";

/** The CapitUp logo: gold ring for trust, teal arrow for growth. */
export function BrandMark({ className, priority = false }: { className?: string; priority?: boolean }) {
  return (
    <Image
      src="/capitup-logo.png"
      alt=""
      aria-hidden="true"
      width={128}
      height={128}
      priority={priority}
      // A 10 KB PNG: serve it as is. Image optimisation would need an IMAGES binding on the Worker.
      unoptimized
      className={cn("size-8 object-contain", className)}
    />
  );
}

/** Logo plus name, for the sidebar and sign-in screens. */
export function BrandLockup({ tone = "light", className }: { tone?: "light" | "dark"; className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/95 shadow-lg ring-1 shadow-black/20 ring-white/40">
        <BrandMark className="size-8" priority />
      </span>
      <div className="leading-tight">
        <p className={cn("text-[15px] font-semibold tracking-tight", tone === "light" ? "text-white" : "text-foreground")}>
          CapitUp <span className={tone === "light" ? "text-gold-gradient" : "text-gold-600"}>India</span>
        </p>
        <p className={cn("text-[11px]", tone === "light" ? "text-white/60" : "text-muted-foreground")}>
          Lead &amp; Renewal CRM
        </p>
      </div>
    </div>
  );
}
