import type { Metadata } from "next";

import { BrandMark } from "@/components/brand/brand";
import { requireSessionForPasswordChange } from "@/lib/auth";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ChangePasswordPage() {
  const { actor } = await requireSessionForPasswordChange();
  const required = actor.must_change_password;

  return (
    <main className="ambient flex min-h-svh flex-col justify-center px-6 py-10 sm:px-12">
      <div className="mx-auto w-full max-w-sm animate-rise">
        <div className="mb-8 flex items-center gap-3">
          <BrandMark className="size-10" priority />
          <div className="leading-tight">
            <p className="font-semibold">
              CapitUp <span className="text-gold-600">India</span>
            </p>
            <p className="text-xs text-muted-foreground">{actor.email}</p>
          </div>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {required
            ? "Your administrator set your current password. Pick one only you know before you continue."
            : "Your other devices will be signed out."}
        </p>
        <div className="surface mt-6 p-6">
          <ChangePasswordForm />
        </div>
        <form action="/auth/signout" method="post" className="mt-6 text-center">
          <button type="submit" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
            Sign out instead
          </button>
        </form>
      </div>
    </main>
  );
}
