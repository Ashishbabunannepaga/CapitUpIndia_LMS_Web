import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/page-header";
import { IntakeWorkspace } from "@/components/intake/intake-workspace";
import { isAiConfigured } from "@/lib/ai/client";
import { isAdmin, requireSession } from "@/lib/auth";
import { cleanExtractedLead, type ExtractedLead } from "@/lib/ai/lead-cleanup";
import { todayInBusinessTz } from "@/lib/dates";
import { getTeam } from "@/lib/leads";
import { getWhatsAppLeadDraft } from "@/server/data/whatsapp";

export const metadata: Metadata = { title: "Add lead" };

// One page for adding a lead: AI intake (notes, dictation, visiting card) or
// the plain form ("Add manually", or /leads/new?mode=manual). Both save
// through the same form and the same duplicate checks. ?wa=<id> opens a lead
// draft someone made on WhatsApp (theirs only, for a week).
export default async function NewLeadPage({ searchParams }: PageProps<"/leads/new">) {
  const { ctx, actor: profile } = await requireSession();
  const admin = isAdmin(profile);
  const agents = admin
    ? (await getTeam()).filter((member) => member.is_active).map(({ id, full_name }) => ({ id, full_name }))
    : [];
  const params = await searchParams;
  const wa = typeof params.wa === "string" ? await getWhatsAppLeadDraft(ctx, profile, params.wa) : null;
  // Cleaned again here, so a stored draft can never carry odd values into the form.
  const fromWhatsApp = wa ? { ...cleanExtractedLead(wa.lead as Partial<ExtractedLead>, { today: todayInBusinessTz() }), dropped: wa.dropped } : undefined;
  const mode = params.mode === "manual" && !fromWhatsApp ? "manual" : "ai";

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
        key={fromWhatsApp ? `wa-${params.wa}` : mode}
        agents={agents}
        currentUserId={profile.id}
        isAdmin={admin}
        aiConfigured={isAiConfigured()}
        initialMode={mode}
        fromWhatsApp={fromWhatsApp}
      />
      {typeof params.wa === "string" && !fromWhatsApp ? (
        <p className="mt-4 text-sm text-muted-foreground">That WhatsApp lead draft has expired or isn&apos;t yours. Forward the message again to make a new one.</p>
      ) : null}
    </div>
  );
}
