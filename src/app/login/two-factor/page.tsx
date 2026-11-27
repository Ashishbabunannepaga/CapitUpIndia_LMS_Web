import type { Metadata } from "next";
import Link from "next/link";

import { BrandMark } from "@/components/brand/brand";
import { TwoFactorCodeForm } from "./code-form";

export const metadata: Metadata = { title: "Enter your code" };

// Second step of signing in (audit R11): the password was right, now the
// 6-digit code from the authenticator app. The challenge lives in a cookie for
// 10 minutes; after that the person starts again from the password.
export default async function TwoFactorSignInPage({ searchParams }: PageProps<"/login/two-factor">) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : undefined;

  return (
    <main className="flex min-h-svh flex-col justify-center px-6 py-10 sm:px-12">
      <div className="mx-auto w-full max-w-sm animate-rise">
        <div className="mb-8 flex items-center gap-3">
          <BrandMark className="size-10" priority />
          <p className="font-semibold">
            CapitUp <span className="text-gold-600">India</span>
          </p>
        </div>
        <h1 className="text-2xl font-medium tracking-tight">Enter your code</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Open your authenticator app (Google Authenticator, Microsoft Authenticator or similar) and type the 6-digit
          code for CapitUp LMS.
        </p>
        <div className="surface mt-6 p-6">
          <TwoFactorCodeForm next={next} />
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Lost your phone? Use one of your backup codes, or ask another admin to reset two-step sign-in on Team.{" "}
          <Link href="/login" className="underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
