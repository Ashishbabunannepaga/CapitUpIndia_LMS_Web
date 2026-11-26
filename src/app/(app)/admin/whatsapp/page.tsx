import type { Metadata } from "next";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { CheckCircle2, CircleAlert } from "lucide-react";

import { PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireSession } from "@/lib/auth";
import { listWhatsAppTeam, whatsAppSentToday } from "@/server/data/whatsapp";
import { whatsAppStatus } from "@/server/whatsapp/client";

import { saveWhatsAppAction, testWhatsAppAction } from "./actions";

export const metadata: Metadata = { title: "WhatsApp" };

// The admin layout already requires an admin; the data functions check again.
export default async function WhatsAppPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { ctx, actor } = await requireSession();
  const { env } = await getCloudflareContext({ async: true });
  const [team, sent, { error, ok }] = await Promise.all([listWhatsAppTeam(ctx, actor), whatsAppSentToday(ctx, actor), searchParams]);
  const status = whatsAppStatus(env);
  const ready = status.WHATSAPP_TOKEN && status.WHATSAPP_PHONE_NUMBER_ID;
  const webhook = `${(env.BETTER_AUTH_URL ?? "").replace(/\/$/, "")}/api/whatsapp`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="WhatsApp"
        description="Task alerts on WhatsApp for the team: due soon, due now, overdue, escalations, new tasks and approvals, with Done and Snooze 1h buttons."
      />
      {error ? <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {ok ? <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{ok}</p> : null}

      <section className="surface space-y-3 p-4 sm:p-5">
        <h2 className="text-sm font-medium">Setup</h2>
        <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
          {Object.entries(status).map(([name, set]) => (
            <li key={name} className="flex items-center gap-2">
              {set ? <CheckCircle2 className="size-4 text-success" /> : <CircleAlert className="size-4 text-warning" />}
              <code className="text-xs">{name}</code>
              <span className="text-muted-foreground">{set ? "set" : "missing"}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Webhook URL for Meta: <code className="break-all">{webhook}</code>. Alerts sent in the last 24 hours: {sent}.
        </p>
        {!ready ? <p className="text-xs text-warning">Alerts stay off until WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are set.</p> : null}
      </section>

      <section className="surface space-y-3 p-4 sm:p-5">
        <h2 className="text-sm font-medium">Team</h2>
        <ul className="divide-y rounded-md border">
          {team
            .filter((m) => m.is_active)
            .map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-36 font-medium">
                  {m.full_name}
                  {m.role === "ADMIN" ? <span className="ml-1 text-xs text-muted-foreground">(admin)</span> : null}
                </span>
                <form action={saveWhatsAppAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="user_id" value={m.id} />
                  <Input name="phone" defaultValue={m.whatsapp_phone ?? ""} placeholder="98765 43210" className="h-8 w-40" aria-label={`${m.full_name}'s WhatsApp number`} />
                  <label className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" name="on" defaultChecked={m.whatsapp_on} className="size-4 accent-primary" /> Alerts on
                  </label>
                  <Button size="sm" variant="outline" type="submit">
                    Save
                  </Button>
                </form>
                {m.whatsapp_phone && ready ? (
                  <form action={testWhatsAppAction}>
                    <input type="hidden" name="user_id" value={m.id} />
                    <Button size="sm" variant="ghost" type="submit">
                      Send test
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Only people with Alerts on get messages. Done and Snooze replies work once the webhook URL above is saved in Meta with the WHATSAPP_VERIFY_TOKEN value.
        </p>
      </section>
    </div>
  );
}
