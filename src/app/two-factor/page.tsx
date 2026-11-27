import type { Metadata } from "next";
import Link from "next/link";

import { BrandMark } from "@/components/brand/brand";
import { requireSessionForTwoFactorSetup } from "@/lib/auth";
import { hasTwoFactor, twoFactorRequired } from "@/server/data/users";
import { DisableTwoFactorForm, TwoFactorSetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Two-step sign-in" };

// Setting up two-step sign-in (audit R11). Admins are sent here until they
// have it; agents can come here from the account menu to switch it on.
export default async function TwoFactorPage() {
  const { ctx, actor } = await requireSessionForTwoFactorSetup();
  const required = twoFactorRequired(actor);
  const enabled = await hasTwoFactor(ctx, actor.id);

  return (
    <main className="flex min-h-svh flex-col justify-center px-6 py-10 sm:px-12">
      <div className="mx-auto w-full max-w-md animate-rise">
        <div className="mb-8 flex items-center gap-3">
          <BrandMark className="size-10" priority />
          <div className="leading-tight">
            <p className="font-semibold">
              CapitUp <span className="text-gold-600">India</span>
            </p>
            <p className="text-xs text-muted-foreground">{actor.email}</p>
          </div>
        </div>
        <h1 className="text-2xl font-medium tracking-tight">Two-step sign-in</h1>
        {enabled ? (
          <>
            <p className="mt-1.5 text-sm text-muted-foreground">
              It is on. Each sign-in asks for your password and a code from your authenticator app.
              {required ? " Admins must keep it on." : ""}
            </p>
            {required ? null : (
              <div className="surface mt-6 p-6">
                <DisableTwoFactorForm />
              </div>
            )}
            <p className="mt-6 text-center text-sm">
              <Link href="/my-day" className="underline-offset-4 hover:underline">
                Back to My Day
              </Link>
            </p>
          </>
        ) : (
          <>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {required
                ? "Admin accounts can see and export every client, so they need a second step at sign-in. It takes two minutes: install Google Authenticator or Microsoft Authenticator on your phone, then follow the steps below."
                : "Add a code from your phone to each sign-in, so a stolen password alone can't open your account."}
            </p>
            <div className="surface mt-6 p-6">
              <TwoFactorSetupForm />
            </div>
            <form action="/auth/signout" method="post" className="mt-6 text-center">
              <button type="submit" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
                Sign out instead
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
