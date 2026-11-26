import type { Metadata } from "next";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { CheckCircle2, CircleAlert } from "lucide-react";

import { PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireSession } from "@/lib/auth";
import { CLIENT_REPLY_MAX, getWhatsAppClientReply, listWhatsAppTeam, whatsAppSentToday } from "@/server/data/whatsapp";
import { whatsAppForwardStatus, whatsAppStatus } from "@/server/whatsapp/client";

import { saveClientReplyAction, saveWhatsAppAction, testWhatsAppAction } from "./actions";

export const metadata: Metadata = { title: "WhatsApp" };

// The admin layout already requires an admin; the data functions check again.
export default async function WhatsAppPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { ctx, actor } = await requireSession();
  const { env } = await getCloudflareContext({ async: true });
  const [team, sent, clientReply, { error, ok }] = await Promise.all([
    listWhatsAppTeam(ctx, actor),
    whatsAppSentToday(ctx, actor),
    getWhatsAppClientReply(ctx),
    searchParams,
  ]);
  const forward = whatsAppForwardStatus(env);
  const forwarding = forward.WHATSAPP_FORWARD_URL;
  const status = whatsAppStatus(env);
  const ready = status.WHATSAPP_TOKEN && status.WHATSAPP_PHONE_NUMBER_ID;
  const webhook = `${(env.BETTER_AUTH_URL ?? "").replace(/\/$/, "")}/api/whatsapp`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="WhatsApp"
        description="Task alerts on WhatsApp for the team, with Done and Snooze 1h buttons. The team can also reply into task chats, send voice notes, add tasks and ask questions from WhatsApp."
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

      <section className="surface space-y-3 p-4 sm:p-5">
        <h2 className="text-sm font-medium">What the team can send</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Done or Snooze 1h on an alert, as a button or a word.</li>
          <li>A swipe-reply to an alert, typed or as a voice note, goes into that task&apos;s chat.</li>
          <li>&quot;todo: renew the Zenith policy&quot; adds their own task; &quot;Sravani: send the GMC quote by Friday&quot; gives one (same rules as the app).</li>
          <li>Anything else is a question, like &quot;what is overdue?&quot;, answered from what that person can see. &quot;help&quot; lists all of this.</li>
        </ul>
      </section>

      <section className="surface space-y-3 p-4 sm:p-5">
        <h2 className="text-sm font-medium">Clients and other numbers</h2>
        <p className="text-sm text-muted-foreground">
          {forwarding
            ? "Messages from numbers outside the team are passed on to your older WhatsApp app (WHATSAPP_FORWARD_URL), so it keeps answering clients."
            : "Messages from numbers outside the team are not passed on. To keep an older app on this number answering clients, add its webhook address as the WHATSAPP_FORWARD_URL secret, and its app secret as WHATSAPP_FORWARD_SECRET if it checks signatures (see docs/whatsapp.md)."}
        </p>
        <form action={saveClientReplyAction} className="space-y-2">
          <label htmlFor="client_reply" className="text-xs font-medium">
            Auto-reply to clients {forwarding ? "(not used while forwarding is on)" : "(at most once a day per number; leave empty for none)"}
          </label>
          <textarea
            id="client_reply"
            name="client_reply"
            defaultValue={clientReply}
            maxLength={CLIENT_REPLY_MAX}
            rows={3}
            placeholder="Thanks for writing to CapitUp. Our team will call you back shortly."
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          <Button size="sm" variant="outline" type="submit">
            Save auto-reply
          </Button>
        </form>
      </section>
    </div>
  );
}
