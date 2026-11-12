import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Eye } from "lucide-react";

import { MyDayScreen } from "@/components/my-day/my-day-screen";
import { requireSession } from "@/lib/auth";
import { InvalidInputError } from "@/server/data/errors";
import { agentForView } from "@/server/data/my-day";

export const metadata: Metadata = { title: "View as agent" };

// "View as agent" from the Team page: the agent's My Day exactly as their
// data makes it, read-only. No session switch: the screen is rendered with the
// agent's profile as the reader, and every button that writes is hidden.
// agentForView() allows admins only (the admin layout also checks).
export default async function ViewAsAgentPage({ params }: PageProps<"/admin/team/[id]/view">) {
  const { ctx, actor } = await requireSession();
  const { id } = await params;
  let agent;
  try {
    agent = await agentForView(ctx, actor, id);
  } catch (error) {
    if (error instanceof InvalidInputError) notFound();
    throw error;
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gold-300 bg-gold-50 px-4 py-2.5 text-sm text-gold-900">
        <p className="flex items-center gap-2">
          <Eye className="size-4" />
          You are seeing {agent.full_name}&apos;s My Day as they see it. Nothing here can be changed.
        </p>
        <Link href="/admin/team" className="inline-flex items-center gap-1 font-medium hover:underline">
          <ArrowLeft className="size-4" />
          Back to Team
        </Link>
      </div>
      <MyDayScreen ctx={ctx} profile={agent} readOnly />
    </>
  );
}
