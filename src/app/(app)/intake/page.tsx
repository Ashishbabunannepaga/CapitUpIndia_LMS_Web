import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/page-header";
import { IntakeWorkspace } from "@/components/intake/intake-workspace";
import { isAiConfigured } from "@/lib/ai/gemini";
import { isAdmin, requireProfile } from "@/lib/auth";
import { getTeam } from "@/lib/leads";

export const metadata: Metadata = { title: "AI Intake" };

export default async function IntakePage() {
  const profile = await requireProfile();
  const admin = isAdmin(profile);
  const agents = admin
    ? (await getTeam()).filter((member) => member.is_active).map(({ id, full_name }) => ({ id, full_name }))
    : [];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="AI Intake"
        description="Turn messy notes, dictation or a visiting card into a lead. You review every field before it is saved."
      />
      <IntakeWorkspace agents={agents} currentUserId={profile.id} isAdmin={admin} aiConfigured={isAiConfigured()} />
    </div>
  );
}
