import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/page-header";
import { IntakeWorkspace } from "@/components/intake/intake-workspace";
import { isAiConfigured } from "@/lib/ai/client";
import { isAdmin, requireProfile } from "@/lib/auth";
import { getTeam } from "@/lib/leads";

export const metadata: Metadata = { title: "Add lead" };

// One page for adding a lead: AI intake (notes, dictation, visiting card) or
// the plain form ("Add manually", or /leads/new?mode=manual). Both save
// through the same form and the same duplicate checks.
export default async function NewLeadPage({ searchParams }: PageProps<"/leads/new">) {
  const profile = await requireProfile();
  const admin = isAdmin(profile);
  const agents = admin
    ? (await getTeam()).filter((member) => member.is_active).map(({ id, full_name }) => ({ id, full_name }))
    : [];
  const mode = (await searchParams).mode === "manual" ? "manual" : "ai";

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow="Workspace"
        title="Add lead"
        description={
          admin
            ? "Let AI read notes, dictation or a visiting card, or fill the form yourself, and choose who works it. You review every field before it is saved."
            : "Let AI read notes, dictation or a visiting card, or fill the form yourself. Existing companies are flagged so you don't chase someone else's account."
        }
      />
      <IntakeWorkspace
        key={mode}
        agents={agents}
        currentUserId={profile.id}
        isAdmin={admin}
        aiConfigured={isAiConfigured()}
        initialMode={mode}
      />
    </div>
  );
}
