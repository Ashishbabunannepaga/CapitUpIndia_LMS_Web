import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/app-shell/page-header";
import { LeadForm } from "@/components/leads/lead-form";
import { isAdmin, requireProfile } from "@/lib/auth";
import { getLead, getTeam } from "@/lib/leads";

export const metadata: Metadata = { title: "Edit lead" };

export default async function EditLeadPage({ params }: PageProps<"/leads/[id]/edit">) {
  const profile = await requireProfile();
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const lead = await getLead(id);
  if (!lead) notFound();
  const admin = isAdmin(profile);
  const agents = admin ? (await getTeam()).filter((member) => member.is_active) : [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={`Edit ${lead.client_name}`} />
      <LeadForm mode="edit" lead={lead} agents={agents} currentUserId={profile.id} isAdmin={admin} />
    </div>
  );
}
