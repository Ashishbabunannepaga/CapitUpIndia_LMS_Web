import type { Metadata } from "next";
import Link from "next/link";
import { LeadLink } from "@/components/leads/lead-link";
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
import { ContactLink } from "@/components/leads/contact-link";
import { CopySummaryButton, LeadTagsEditor, WhatsAppIconLink } from "@/components/leads/lead-extras";
import { LeadHistory } from "@/components/leads/lead-history";
import { FollowUpWriter } from "@/components/leads/follow-up-writer";
import { AgentName } from "@/components/leads/lead-views";
import { StatusSelect } from "@/components/leads/status-select";
import { VisitingCardPanel } from "@/components/leads/visiting-card-panel";
import { TaskList, type TaskItem } from "@/components/my-day/my-day-widgets";
import { TaskForm } from "@/components/tasks/task-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isAdmin, requireSession } from "@/lib/auth";
import { mailtoHref, telHref, whatsappHref } from "@/lib/contact-links";
import { businessDateOf, formatDate, formatDateTime, formatNoteTimestamp, nowMs, todayInBusinessTz } from "@/lib/dates";
import { CLOSED_STATUSES, CONTACT_CHANNEL_LABELS, formatNoteLine } from "@/lib/domain";
import { findSimilarLeads, getLeadPage } from "@/lib/leads";
import { cn } from "@/lib/utils";
import { leadHistory } from "@/server/data/history";

export const metadata: Metadata = { title: "Lead" };

const SAVED_MESSAGES: Record<string, string> = {
  created: "Lead saved.",
  created_meeting: "Lead saved, and the meeting is on your calendar.",
  created_no_meeting: "Lead saved, but the meeting could not be added. Add it under Meetings and tasks below.",
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
    <section className={cn("rounded-2xl border bg-card shadow-card", className)}>
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
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function PocCard({
  leadId,
  label,
  name,
  designation,
  phone,
  email,
}: {
  leadId: number;
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
      <p className="text-xs text-muted-foreground">{label}</p>
      {empty ? (
        <p className="mt-2 text-sm text-muted-foreground">Empty</p>
      ) : (
        <>
          <p className="mt-1.5 font-medium">
            {name || "Contact"}
            {designation ? <span className="font-normal text-muted-foreground"> · {designation}</span> : null}
          </p>
          {phone ? (
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              {phone}
              <WhatsAppIconLink leadId={leadId} phone={phone} />
            </p>
          ) : null}
          {email ? <p className="truncate text-sm text-muted-foreground">{email}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {tel ? (
              <Button asChild size="sm" variant="outline">
                <ContactLink leadId={leadId} channel="call" href={tel}>
                  <Phone />
                  Call
                </ContactLink>
              </Button>
            ) : null}
            {wa ? (
              <Button asChild size="sm" variant="outline">
                <ContactLink leadId={leadId} channel="whatsapp" href={wa} target="_blank" rel="noreferrer">
                  <MessageCircle />
                  WhatsApp
                </ContactLink>
              </Button>
            ) : null}
            {mail ? (
              <Button asChild size="sm" variant="outline">
                <ContactLink leadId={leadId} channel="email" href={mail}>
                  <Mail />
                  Email
                </ContactLink>
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/** The plain-text snapshot "Copy summary" puts on the clipboard. */
function leadSummary(
  lead: {
    client_name: string;
    policy_product: string;
    sub_product_name: string;
    status: string;
    type: string;
    renewal_date: string | null;
    agent_name: string | null;
  } & Record<"poc_name" | "poc_designation" | "poc_contact_number" | "poc_email_id", string>,
  lastNote: { agent_name: string; created_at: string; content: string } | undefined,
): string {
  const poc = [
    lead.poc_name || null,
    lead.poc_designation && lead.poc_designation !== "poc" ? `(${lead.poc_designation})` : null,
    lead.poc_contact_number || null,
    lead.poc_email_id || null,
  ]
    .filter(Boolean)
    .join(" ");
  return [
    lead.client_name,
    `Product: ${lead.policy_product}${lead.sub_product_name ? ` (${lead.sub_product_name})` : ""} · ${lead.type}`,
    `Status: ${lead.status}`,
    `POC: ${poc || "not added yet"}`,
    `Renewal: ${lead.renewal_date ? formatDate(lead.renewal_date) : "no date yet"}`,
    `Agent: ${lead.agent_name ?? "Unassigned"}`,
    lastNote ? `Last note: ${formatNoteLine(lastNote.agent_name, lastNote.created_at, lastNote.content)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export default async function LeadPage({ params, searchParams }: PageProps<"/leads/[id]">) {
  const { ctx, actor: profile } = await requireSession();
  const admin = isAdmin(profile);
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const query = await searchParams;
  const showHistory = query.tab === "history";
  const [data, history] = await Promise.all([getLeadPage(id), showHistory ? leadHistory(ctx, profile, id) : null]);
  if (!data) notFound();
  const { lead, notes, events, contacts } = data;
  const team = admin ? data.team : [];
  const similar = await findSimilarLeads(lead.client_name, id);
  // Served by ./card/route.ts, which checks access again. The card's file name
  // in the URL makes a replaced card a new URL, so caching stays safe.
  const cardVersion = lead.visiting_card_path?.split("/").pop()?.split(".")[0];
  const cardUrl = cardVersion ? `/leads/${id}/card?v=${cardVersion}` : null;
  const unreadIds = new Set(data.unreadNoteIds);
  const saved = query.saved;
  const savedMessage = typeof saved === "string" ? SAVED_MESSAGES[saved] : undefined;

  // Other records for the same company. A newer record is flagged as a
  // duplicate; the original owner still sees who else holds the company.
  const sameCompany = similar.filter((match) => match.is_exact);
  // An agent whose duplicate only matches their own records has no one to clash
  // with, so they get the gentler same-company note instead of the warning.
  const ownDuplicate =
    !admin && lead.is_duplicate && sameCompany.length > 0 && sameCompany.every((m) => m.assigned_agent_id === profile.id);
  const closed = CLOSED_STATUSES.includes(lead.status);
  const now = nowMs();
  const visibleEvents = events.filter((e) => !e.is_background_reminder);
  const renewalEvents = visibleEvents.filter((e) => e.is_system_generated);
  const today = todayInBusinessTz();
  const names = new Map(team.map((m) => [m.id, m.full_name]));
  const plannedItems: TaskItem[] = visibleEvents
    .filter((e) => !e.is_system_generated)
    .map((e) => ({
      id: e.id,
      title: e.title,
      leadId: e.lead_id,
      leadName: lead.client_name,
      timestamp: e.event_timestamp,
      whenLabel: formatDate(businessDateOf(e.event_timestamp)),
      kind: e.kind,
      notes: e.notes,
      assigneeId: e.assigned_agent_id,
      assigneeName: admin && e.assigned_agent_id ? (names.get(e.assigned_agent_id) ?? null) : null,
      isCompleted: e.is_completed,
      isSystem: false,
      overdue: !e.is_completed && Date.parse(e.event_timestamp) < now,
    }));
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
          <h1 className="text-[28px] leading-tight font-medium tracking-tight">{lead.client_name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <StatusSelect leadId={lead.id} status={lead.status} />
            <Badge variant="secondary">{lead.type}</Badge>
            <Badge variant="secondary">{lead.business_type}</Badge>
            <Badge variant="secondary">{lead.policy_product}</Badge>
            {lead.is_duplicate ? <DuplicateBadge label={lead.duplicate_label} /> : null}
          </div>
          <LeadTagsEditor leadId={lead.id} tags={data.tags} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopySummaryButton summary={leadSummary(lead, notes[0])} />
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

      {lead.is_duplicate && !ownDuplicate ? (
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
                          <LeadLink href={`/leads/${match.lead_id}`} className="font-medium underline">
                            {match.client_name}
                          </LeadLink>
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
                    <LeadLink href={`/leads/${match.lead_id}`} className="font-medium underline">
                      {match.client_name}
                    </LeadLink>
                  ) : (
                    <span className="font-medium">{match.client_name}</span>
                  )}{" "}
                  · {match.assigned_agent_name}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-amber-800/80 dark:text-amber-100/80">
              {ownDuplicate
                ? "All of these records are yours. Your admin can merge them or clear the duplicate flag."
                : "Coordinate before reaching out so the client hears from one person."}
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* On phones the card sits first, so it is one tap away at a client visit. */}
        {cardUrl ? (
          <VisitingCardPanel leadId={lead.id} clientName={lead.client_name} cardUrl={cardUrl} className="xl:hidden" />
        ) : null}
        <div className="min-w-0 space-y-6 xl:col-span-2">
          <nav aria-label="Lead sections" className="flex gap-1 border-b">
            {[
              { label: "Details", href: `/leads/${lead.id}`, active: !showHistory },
              { label: "History", href: `/leads/${lead.id}?tab=history`, active: showHistory },
            ].map((tab) => (
              <Link
                key={tab.label}
                href={tab.href}
                scroll={false}
                aria-current={tab.active ? "page" : undefined}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                  tab.active ? "border-primary text-foreground" : "border-transparent",
                )}
              >
                {tab.label}
              </Link>
            ))}
          </nav>
          {showHistory ? (
            <Panel title="History">
              <p className="mb-4 text-sm text-muted-foreground">
                Status changes, edits field by field, tags, notes, tasks, assignments and contact presses (including AI follow-up
                drafts), newest first.
              </p>
              <LeadHistory items={history ?? []} />
            </Panel>
          ) : (
            <>
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
                  {lead.relationship_manager ? (
                    <Fact label="RM (relationship manager)">
                      <span className="whitespace-pre-wrap">{lead.relationship_manager}</span>
                    </Fact>
                  ) : null}
                  {lead.address ? (
                    <Fact label="Address">
                      <span className="whitespace-pre-wrap">{lead.address}</span>
                    </Fact>
                  ) : null}
                  <Fact label="Added">{formatDateTime(lead.created_at)}</Fact>
                  <Fact label="Last updated">{formatDateTime(lead.updated_at)}</Fact>
                  {lead.assigned_at ? <Fact label="Assigned">{formatDateTime(lead.assigned_at)}</Fact> : null}
                </dl>
              </Panel>

              <Panel title="Points of contact" actions={null}>
                <div className="grid gap-4 md:grid-cols-2">
                  <PocCard
                    leadId={lead.id}
                    label="Primary POC"
                    name={lead.poc_name}
                    designation={lead.poc_designation}
                    phone={lead.poc_contact_number}
                    email={lead.poc_email_id}
                  />
                  <PocCard
                    leadId={lead.id}
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

              <Panel title="AI follow-up">
                <FollowUpWriter
                  leadId={lead.id}
                  clientName={lead.client_name}
                  product={lead.policy_product}
                  phone={lead.poc_contact_number || lead.poc2_contact_number}
                  email={lead.poc_email_id || lead.poc2_email_id}
                />
              </Panel>

              <Panel title="Lead notes">
                {lead.notes ? (
                  <p className="text-sm whitespace-pre-wrap">{lead.notes}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">No background notes. Add them with Edit.</p>
                )}
              </Panel>
            </>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <VisitingCardPanel
            leadId={lead.id}
            clientName={lead.client_name}
            cardUrl={cardUrl}
            className={cardUrl ? "hidden xl:block" : undefined}
          />
          <Panel title={`Notes thread (${notes.length})`}>
            <AddNoteForm leadId={lead.id} />
            {notes.length > 0 ? (
              <ol className="mt-5 space-y-3">
                {notes.map((note) => (
                  <li
                    key={note.id}
                    className={cn("rounded-lg border p-3 text-sm", unreadIds.has(note.id) && "border-primary/40 bg-accent/50")}
                  >
                    <p className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        <span className="font-medium text-foreground">{note.agent_name}</span> -{" "}
                        {formatNoteTimestamp(note.created_at)}
                      </span>
                      {unreadIds.has(note.id) ? <span className="text-xs font-medium text-brand-700">New</span> : null}
                    </p>
                    <p className="whitespace-pre-wrap">{note.content}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">No notes yet. Notes are timestamped and visible to admins.</p>
            )}
          </Panel>

          <Panel title="Contact history">
            {contacts.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {contacts.map((c) => (
                  <li key={c.id} className="flex items-start gap-2">
                    {c.channel === "call" ? (
                      <Phone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    ) : c.channel === "whatsapp" ? (
                      <MessageCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div>
                      <p>
                        <span className="font-medium">{c.agent_name}</span> · {CONTACT_CHANNEL_LABELS[c.channel]}
                        {c.with_draft ? <span className="text-muted-foreground"> (AI follow-up)</span> : null}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(c.created_at)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No calls, WhatsApps or emails yet. Each press of those buttons on this page is recorded here.
              </p>
            )}
          </Panel>

          <Panel title="Meetings and tasks">
            <TaskForm
              today={today}
              currentUserId={profile.id}
              assignees={
                admin
                  ? team.filter((m) => m.is_active).map(({ id: memberId, full_name }) => ({ id: memberId, full_name }))
                  : undefined
              }
              fixedLead={{ id: lead.id, client_name: lead.client_name }}
              defaultKind="meeting"
              compact
            />
            <div className="mt-4">
              <TaskList
                showLead={false}
                tasks={plannedItems}
                emptyText="No meetings or tasks yet. Plan one above; it also shows on the calendar."
                editing={{
                  today,
                  currentUserId: profile.id,
                  assignees: admin
                    ? team.filter((m) => m.is_active).map(({ id: memberId, full_name }) => ({ id: memberId, full_name }))
                    : undefined,
                }}
              />
            </div>
          </Panel>

          <Panel title="Renewal countdown">
            {renewalEvents.length === 0 && pendingReminders.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing scheduled. Set a renewal date to schedule the renewal countdown.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {renewalEvents.map((event) => (
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
                    {pendingReminders.length} countdown reminder{pendingReminders.length === 1 ? "" : "s"} scheduled, next{" "}
                    {pendingReminders[0].milestone} on {formatDateTime(pendingReminders[0].event_timestamp)}.
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
