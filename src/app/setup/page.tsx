import type { Metadata } from "next";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDataContext } from "@/server/data/context";
import { isSetupOpen } from "@/server/data/setup";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up" };

// The first admin account on a new deployment. Once anyone exists, or when
// the SETUP_CODE secret is not set, this page does not exist.
export default async function SetupPage() {
  await headers();
  const { env } = await getCloudflareContext({ async: true });
  if (!(await isSetupOpen(await getDataContext(), env.SETUP_CODE))) notFound();

  return (
    <main className="flex min-h-svh items-center justify-center bg-sidebar p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Set up CapitUp LMS</CardTitle>
          <CardDescription>
            Create the first admin account. Enter the setup code you saved as a Worker secret; this page closes once the
            account exists.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SetupForm />
        </CardContent>
      </Card>
    </main>
  );
}
