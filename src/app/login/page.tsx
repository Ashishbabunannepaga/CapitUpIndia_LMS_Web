import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentProfile } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  inactive: "Your account is disabled. Contact your administrator.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : undefined;
  const errorKey = typeof params.error === "string" ? params.error : undefined;
  const setupDone = params.setup === "done";

  if (await getCurrentProfile()) {
    redirect("/my-day");
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-sidebar p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center justify-center gap-2 text-sidebar-foreground">
          <div className="flex size-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <ShieldCheck className="size-5" />
          </div>
          <div className="leading-tight">
            <p className="font-semibold">CapitUp India</p>
            <p className="text-xs text-sidebar-foreground/70">Lead &amp; Renewal CRM</p>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Sign in</CardTitle>
            <CardDescription>
              {setupDone
                ? "Your admin account is ready. Sign in with it, then add your team under Team."
                : "Use the account your administrator created for you."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LoginForm next={next} initialError={errorKey ? ERRORS[errorKey] : undefined} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
