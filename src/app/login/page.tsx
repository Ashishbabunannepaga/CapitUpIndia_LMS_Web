import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BellRing, CopyCheck, Sparkles, TrendingUp } from "lucide-react";

import { BrandLockup, BrandMark } from "@/components/brand/brand";
import { getCurrentProfile } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  inactive: "Your account is disabled. Contact your administrator.",
};

const POINTS = [
  { icon: BellRing, title: "Never miss a renewal", text: "T-30 to T-5 minute reminders, sent by the server." },
  { icon: CopyCheck, title: "One owner per account", text: "Duplicate companies are caught before outreach." },
  { icon: Sparkles, title: "AI-assisted intake", text: "Notes, speech and visiting cards become leads." },
  { icon: TrendingUp, title: "Live pipeline", text: "Quotes, wins and renewals for the whole team." },
];

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : undefined;
  const errorKey = typeof params.error === "string" ? params.error : undefined;
  const setupDone = params.setup === "done";

  if (await getCurrentProfile()) {
    redirect("/my-day");
  }

  return (
    <main className="grid min-h-svh bg-background lg:grid-cols-[1.1fr_1fr]">
      {/* Brand panel */}
      <section className="hero-band relative hidden flex-col justify-between overflow-hidden px-12 py-10 text-white lg:flex xl:px-16">
        <div aria-hidden="true" className="grid-texture absolute inset-0" />
        <BrandMark className="pointer-events-none absolute -right-24 -bottom-24 size-[28rem] animate-float opacity-[0.07]" />
        <div aria-hidden="true" className="absolute top-1/3 right-16 size-3 rounded-full bg-gold-300">
          <span className="absolute inset-0 animate-ping-soft rounded-full bg-gold-300" />
        </div>
        <div aria-hidden="true" className="absolute top-[58%] left-[46%] size-2 rounded-full bg-brand-300">
          <span className="absolute inset-0 animate-ping-soft rounded-full bg-brand-300 [animation-delay:700ms]" />
        </div>

        <BrandLockup className="relative animate-rise" />

        <div className="relative max-w-xl animate-rise [animation-delay:120ms]">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-brand-100">
            <span className="size-1.5 rounded-full bg-brand-300" /> Insurance lead &amp; renewal command centre
          </p>
          <h1 className="text-[clamp(2.2rem,3.4vw,3.4rem)] leading-[1.05] font-semibold tracking-tight">
            Every renewal on time. <span className="text-gold-gradient">Every lead owned.</span>
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-white/75">
            Capture, assign, follow up, quote and renew from one workspace built for CapitUp&apos;s brokers and account
            managers.
          </p>
        </div>

        <ul className="stagger relative grid max-w-xl grid-cols-2 gap-x-8 gap-y-6">
          {POINTS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-3">
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/10 text-gold-300 ring-1 ring-white/10">
                <Icon className="size-4" />
              </span>
              <span>
                <span className="block text-sm font-semibold">{title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-white/65">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Form panel */}
      <section className="ambient flex flex-col justify-center px-6 py-10 sm:px-12">
        <div className="mx-auto w-full max-w-sm animate-rise">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark className="size-10" priority />
            <div className="leading-tight">
              <p className="font-semibold">
                CapitUp <span className="text-gold-600">India</span>
              </p>
              <p className="text-xs text-muted-foreground">Lead &amp; Renewal CRM</p>
            </div>
          </div>
          <p className="text-[11px] font-semibold tracking-[0.16em] text-brand-700 uppercase">Welcome back</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Sign in</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {setupDone
              ? "Your admin account is ready. Sign in with it, then add your team under Team."
              : "Use the account your administrator created for you."}
          </p>
          <div className="surface mt-6 p-6">
            <LoginForm next={next} initialError={errorKey ? ERRORS[errorKey] : undefined} />
          </div>
          <p className="mt-6 text-center text-xs text-muted-foreground">
            No public sign-up. Ask your admin if you need an account.
          </p>
        </div>
      </section>
    </main>
  );
}
