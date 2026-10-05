import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/page-header";
import { LeadForm } from "@/components/leads/lead-form";
import { isAdmin, requireProfile } from "@/lib/auth";
import { getTeam } from "@/lib/leads";

export const metadata: Metadata = { title: "New lead" };

export default async function NewLeadPage() {
  const profile = await requireProfile();
  const admin = isAdmin(profile);
  const agents = admin ? (await getTeam()).filter((member) => member.is_active) : [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="New lead"
        description={
          admin
            ? "Capture a lead and choose who works it. Existing companies are flagged as you type."
            : "Capture a lead for yourself. Existing companies are flagged as you type, so you don't chase someone else's account."
        }
      />
      <LeadForm mode="create" agents={agents} currentUserId={profile.id} isAdmin={admin} />
    </div>
  );
}
