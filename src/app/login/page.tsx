import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BellRing, CopyCheck, ScanText, TrendingUp } from "lucide-react";

import { BrandLockup, BrandMark } from "@/components/brand/brand";
import { getCurrentProfile } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  inactive: "Your account is disabled. Contact your administrator.",
};

const POINTS = [
  { icon: BellRing, title: "Never miss a renewal", text: "Reminders from 30 days to 5 minutes before, sent by the server" },
  { icon: CopyCheck, title: "One owner per account", text: "Duplicate companies are caught before anyone calls" },
  { icon: ScanText, title: "Intake from notes and cards", text: "Typed notes, speech and visiting cards become leads" },
  { icon: TrendingUp, title: "Live pipeline", text: "Quotes, wins and renewals for the whole team" },
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
      <section className="hero-band hidden flex-col justify-between px-12 py-10 text-white lg:flex xl:px-16">
        <BrandLockup />

        <div className="max-w-xl animate-rise">
          <h1 className="text-[clamp(2.25rem,3.4vw,3.5rem)] leading-[1.05] font-medium tracking-tight">
            Every renewal on time<br /><span className="text-gold-300">Every lead owned</span>
          </h1>
          <p className="mt-6 max-w-md text-lg leading-relaxed text-white/70">
            Capture, assign, follow up, quote and renew from one workspace built for CapitUp&apos;s brokers and account
            managers.
          </p>
        </div>

        <ul className="grid max-w-xl grid-cols-2 gap-x-8 gap-y-6 border-t border-white/10 pt-8">
          {POINTS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-3">
              <Icon className="mt-0.5 size-4 shrink-0 text-white/50" strokeWidth={1.75} />
              <span>
                <span className="block text-sm font-medium">{title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-white/65">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Form panel */}
      <section className="flex flex-col justify-center px-6 py-10 sm:px-12">
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
          <h2 className="text-2xl font-medium tracking-tight">Sign in</h2>
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
