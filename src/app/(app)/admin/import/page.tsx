import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/page-header";
import { ImportWorkspace } from "@/components/import/import-workspace";
import { isAiConfigured } from "@/lib/ai/gemini";
import { requireAdmin } from "@/lib/auth";
import { getTeam } from "@/lib/leads";

export const metadata: Metadata = { title: "Bulk Import" };

export default async function ImportPage() {
  await requireAdmin();
  const agents = (await getTeam())
    .filter((member) => member.is_active && member.role === "AGENT")
    .map(({ id, full_name }) => ({ id, full_name }));

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Bulk Import"
        description="Paste or upload a sheet, check every row, then create the leads and distribute them."
      />
      <ImportWorkspace agents={agents} aiConfigured={isAiConfigured()} />
    </div>
  );
}
