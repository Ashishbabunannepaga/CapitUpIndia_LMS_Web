import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, CalendarClock, CheckCircle2, Mail, MessageCircle, Pencil, Phone } from "lucide-react";

import { DuplicateBadge, RenewalDate } from "@/components/leads/lead-badges";
import {
  AddContactForm,
  AddNoteForm,
  AssignAgentSelect,
  DeleteLeadButton,
  MarkNotesReadOnView,
  ResolveDuplicateButton,
} from "@/components/leads/lead-detail-actions";
import { AgentName } from "@/components/leads/lead-views";
import { StatusSelect } from "@/components/leads/status-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isAdmin, requireProfile } from "@/lib/auth";
import { mailtoHref, telHref, whatsappHref } from "@/lib/contact-links";
import { formatDateTime, formatNoteTimestamp, nowMs } from "@/lib/dates";
import { CLOSED_STATUSES } from "@/lib/domain";
import { findSimilarLeads, getLead, getLeadEvents, getLeadNotes, getTeam } from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Lead" };

const SAVED_MESSAGES: Record<string, string> = {
  created: "Lead saved.",
  updated: "Changes saved.",
  merged: "Your contacts were added to this lead instead of creating a duplicate.",
};

function Panel({
  title,
  actions,
  children,
  className,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border bg-card shadow-sm", className)}>
      <header className="flex items-center justify-between gap-2 border-b px-5 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function PocCard({
  label,
  name,
  designation,
  phone,
  email,
}: {
  label: string;
  name: string;
  designation: string;
  phone: string;
  email: string;
}) {
  const empty = !name && !phone && !email;
  const tel = telHref(phone);
  const wa = whatsappHref(phone);
  const mail = mailtoHref(email);
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      {empty ? (
        <p className="mt-2 text-sm text-muted-foreground">Empty</p>
      ) : (
        <>
          <p className="mt-1.5 font-medium">
            {name || "Contact"}
            {designation ? <span className="font-normal text-muted-foreground"> · {designation}</span> : null}
          </p>
          {phone ? <p className="text-sm text-muted-foreground">{phone}</p> : null}
          {email ? <p className="truncate text-sm text-muted-foreground">{email}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {tel ? (
              <Button asChild size="sm" variant="outline">
                <a href={tel}>
                  <Phone />
                  Call
                </a>
              </Button>
            ) : null}
            {wa ? (
              <Button asChild size="sm" variant="outline">
                <a href={wa} target="_blank" rel="noreferrer">
                  <MessageCircle />
                  WhatsApp
                </a>
              </Button>
            ) : null}
            {mail ? (
              <Button asChild size="sm" variant="outline">
                <a href={mail}>
                  <Mail />
                  Email
                </a>
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export default async function LeadPage({ params, searchParams }: PageProps<"/leads/[id]">) {
  const profile = await requireProfile();
  const admin = isAdmin(profile);
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const lead = await getLead(id);
  if (!lead) notFound();

  const supabase = await createClient();
  const [notes, events, team, similar, unread] = await Promise.all([
    getLeadNotes(id),
    getLeadEvents(id),
    admin ? getTeam() : Promise.resolve([]),
    findSimilarLeads(lead.client_name, id),
    supabase.rpc("unread_lead_notes", { p_limit: 200 }),
  ]);
  const unreadIds = new Set((unread.data ?? []).filter((n) => n.lead_id === id).map((n) => n.id));
  const saved = (await searchParams).saved;
  const savedMessage = typeof saved === "string" ? SAVED_MESSAGES[saved] : undefined;

  // Other records for the same company. A newer record is flagged as a
  // duplicate; the original owner still sees who else holds the company.
  const sameCompany = similar.filter((match) => match.is_exact);
  const closed = CLOSED_STATUSES.includes(lead.status);
  const now = nowMs();
  const visibleEvents = events.filter((e) => !e.is_background_reminder);
  const pendingReminders = events.filter(
    (e) => e.is_background_reminder && !e.reminder_sent_at && Date.parse(e.event_timestamp) > now,
  );

  return (
    <>
      <MarkNotesReadOnView leadId={id} unread={unreadIds.size} />
      <div className="mb-4">
        <Link href="/leads" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />
          Leads
        </Link>
      </div>

      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{lead.client_name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <StatusSelect leadId={lead.id} status={lead.status} />
            <Badge variant="secondary">{lead.type}</Badge>
            <Badge variant="secondary">{lead.business_type}</Badge>
            <Badge variant="secondary">{lead.policy_product}</Badge>
            {lead.is_duplicate ? <DuplicateBadge label={lead.duplicate_label} /> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link href={`/leads/${lead.id}/edit`}>
              <Pencil />
              Edit
            </Link>
          </Button>
          {admin ? <DeleteLeadButton leadId={lead.id} clientName={lead.client_name} redirectTo="/leads" /> : null}
        </div>
      </div>

      {savedMessage ? (
        <p
          role="status"
          className="mb-4 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          <CheckCircle2 className="size-4" />
          {savedMessage}
        </p>
      ) : null}

      {lead.is_duplicate ? (
        <div
          role="alert"
          className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div className="space-y-1">
                <p className="font-semibold">Duplicate lead warning</p>
                <p>{lead.duplicate_label || "Another record exists for this company."}</p>
                {similar.length > 0 ? (
                  <ul className="mt-2 space-y-0.5">
                    {similar.map((match) => (
                      <li key={match.lead_id}>
                        {admin || match.assigned_agent_id === profile.id ? (
                          <Link href={`/leads/${match.lead_id}`} className="font-medium underline">
                            {match.client_name}
                          </Link>
                        ) : (
                          <span className="font-medium">{match.client_name}</span>
                        )}{" "}
                        <span className="text-red-800/80 dark:text-red-100/80">· {match.assigned_agent_name}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {!admin ? (
                  <p className="text-red-800/80 dark:text-red-100/80">
                    Talk to your admin before contacting this company. Only an admin can clear this warning.
                  </p>
                ) : null}
              </div>
            </div>
            {admin ? <ResolveDuplicateButton leadId={lead.id} /> : null}
          </div>
        </div>
      ) : sameCompany.length > 0 ? (
        <div
          role="note"
          className="mb-6 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-semibold">This company has another record</p>
            <ul className="mt-1 space-y-0.5">
              {sameCompany.map((match) => (
                <li key={match.lead_id}>
                  {admin || match.assigned_agent_id === profile.id ? (
                    <Link href={`/leads/${match.lead_id}`} className="font-medium underline">
                      {match.client_name}
                    </Link>
                  ) : (
                    <span className="font-medium">{match.client_name}</span>
                  )}{" "}
                  · {match.assigned_agent_name}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-amber-800/80 dark:text-amber-100/80">
              Coordinate before reaching out so the client hears from one person.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-6 xl:col-span-2">
          <Panel title="Policy">
            <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <Fact label="Renewal date">
                <RenewalDate date={lead.renewal_date} closed={closed} />
              </Fact>
              <Fact label="Product">
                {lead.policy_product}
                {lead.sub_product_name ? <span className="text-muted-foreground"> · {lead.sub_product_name}</span> : null}
              </Fact>
              <Fact label="Assigned agent">
                {admin ? (
                  <AssignAgentSelect
                    leadId={lead.id}
                    agentId={lead.assigned_agent_id}
                    agents={team.filter((m) => m.is_active || m.id === lead.assigned_agent_id)}
                  />
                ) : (
                  <AgentName name={lead.agent_name} />
                )}
              </Fact>
              <Fact label="Added">{formatDateTime(lead.created_at)}</Fact>
              <Fact label="Last updated">{formatDateTime(lead.updated_at)}</Fact>
              {lead.assigned_at ? <Fact label="Assigned">{formatDateTime(lead.assigned_at)}</Fact> : null}
            </dl>
          </Panel>

          <Panel title="Points of contact" actions={null}>
            <div className="grid gap-4 md:grid-cols-2">
              <PocCard
                label="Primary POC"
                name={lead.poc_name}
                designation={lead.poc_designation}
                phone={lead.poc_contact_number}
                email={lead.poc_email_id}
              />
              <PocCard
                label="Secondary POC"
                name={lead.poc2_name}
                designation={lead.poc2_designation}
                phone={lead.poc2_contact_number}
                email={lead.poc2_email_id}
              />
            </div>
            <div className="mt-4">
              <AddContactForm leadId={lead.id} />
            </div>
          </Panel>

          <Panel title="Lead notes">
            {lead.notes ? (
              <p className="text-sm whitespace-pre-wrap">{lead.notes}</p>
            ) : (
              <p className="text-sm text-muted-foreground">No background notes. Add them with Edit.</p>
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          <Panel title={`Notes thread (${notes.length})`}>
            <AddNoteForm leadId={lead.id} />
            {notes.length > 0 ? (
              <ol className="mt-5 space-y-3">
                {notes.map((note) => (
                  <li
                    key={note.id}
                    className={cn(
                      "rounded-lg border p-3 text-sm",
                      unreadIds.has(note.id) && "border-primary/40 bg-accent/50",
                    )}
                  >
                    <p className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        <span className="font-medium text-foreground">{note.agent_name}</span> -{" "}
                        {formatNoteTimestamp(note.created_at)}
                      </span>
                      {unreadIds.has(note.id) ? <Badge className="px-1.5 py-0 text-[10px]">New</Badge> : null}
                    </p>
                    <p className="whitespace-pre-wrap">{note.content}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">No notes yet. Notes are timestamped and visible to admins.</p>
            )}
          </Panel>

          <Panel title="Calendar">
            {visibleEvents.length === 0 && pendingReminders.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing scheduled. Set a renewal date to schedule the renewal countdown.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {visibleEvents.map((event) => (
                  <li key={event.id} className="flex items-start gap-2">
                    {event.is_completed ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                    ) : (
                      <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div>
                      <p className={cn(event.is_completed && "text-muted-foreground line-through")}>{event.title}</p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(event.event_timestamp)}</p>
                    </div>
                  </li>
                ))}
                {pendingReminders.length > 0 ? (
                  <li className="pt-1 text-xs text-muted-foreground">
                    {pendingReminders.length} countdown reminder{pendingReminders.length === 1 ? "" : "s"} scheduled,
                    next {pendingReminders[0].milestone} on {formatDateTime(pendingReminders[0].event_timestamp)}.
                  </li>
                ) : null}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
