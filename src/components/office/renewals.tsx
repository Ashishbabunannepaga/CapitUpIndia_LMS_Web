import Link from "next/link";
import { Download, MessageCircle, Phone, Search } from "lucide-react";

import { updateRenewalAction } from "@/app/(app)/office/actions";
import { StatCard } from "@/components/analytics/charts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { OfficeRenewal } from "@/lib/office";
import { OFFICE_RENEWAL_STEPS, officeAgo, officeType, renewalMessage, whatsappLink } from "@/lib/office-labels";
import { cn } from "@/lib/utils";

import { requestsHref } from "./call-requests";
import { DaysLeft, Empty, GapChips } from "./office-bits";

export type RenewalsQuery = { range: string; type: string; contact: boolean; q: string };

export function renewalsHref(query: Partial<RenewalsQuery>): string {
  const params = new URLSearchParams({ tab: "renewals" });
  if (query.range && query.range !== "30") params.set("range", query.range);
  if (query.type && query.type !== "all") params.set("type", query.type);
  if (query.contact) params.set("contact", "1");
  if (query.q) params.set("q", query.q);
  return `/office?${params.toString()}`;
}

const dateFormat = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export function Renewals({ items, query }: { items: OfficeRenewal[]; query: RenewalsQuery }) {
  const inRange = (d: number) => (query.range === "expired" ? d < 0 : d >= 0 && d <= Number(query.range));
  const q = query.q.toLowerCase();
  const shown = items.filter(
    (i) =>
      inRange(i.days_left) &&
      (query.type === "all" || (i.policy_type || "unsure") === query.type) &&
      (!query.contact || i.contact) &&
      (!q || [i.title, i.filename, i.contact?.name, i.contact?.phone].some((v) => String(v ?? "").toLowerCase().includes(q))),
  );
  const upcoming = items.filter((i) => i.days_left >= 0);
  const kpi = {
    week: upcoming.filter((i) => i.days_left <= 7).length,
    month: upcoming.filter((i) => i.days_left <= 30).length,
    reachable: upcoming.filter((i) => i.days_left <= 30 && i.contact).length,
    won: items.filter((i) => i.renewal_status === "renewed").length,
  };
  const groups: [string, OfficeRenewal[]][] =
    query.range === "expired"
      ? [["Expired in the last 30 days", shown]]
      : [
          ["This week", shown.filter((i) => i.days_left <= 7)],
          ["In the next 30 days", shown.filter((i) => i.days_left > 7 && i.days_left <= 30)],
          ["31 to 90 days away", shown.filter((i) => i.days_left > 30)],
        ];
  const back = renewalsHref(query);

  return (
    <>
      <div className="stagger mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Expiring this week" value={kpi.week} hint="Call these clients first" tone="urgent" quiet={kpi.week === 0} />
        <StatCard label="Expiring in 30 days" value={kpi.month} hint="Policies to offer renewal on" tone="warning" quiet={kpi.month === 0} />
        <StatCard label="Reachable in 30 days" value={kpi.reachable} hint="Left a phone or email" tone="brand" />
        <StatCard label="Renewed with Capitup" value={kpi.won} hint="Marked by the team" tone="gold" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Chips
          current={query.range}
          options={[["7", "Next 7 days"], ["30", "Next 30 days"], ["90", "Next 90 days"], ["expired", "Recently expired"]]}
          href={(range) => renewalsHref({ ...query, range })}
        />
        <Chips
          current={query.type}
          options={[["all", "All types"], ["health", "Health"], ["motor", "Motor"], ["life", "Term life"]]}
          href={(type) => renewalsHref({ ...query, type })}
        />
        <Link
          href={renewalsHref({ ...query, contact: !query.contact })}
          className={cn("rounded-full border px-2.5 py-0.5 text-xs", query.contact ? "border-brand-600 bg-brand-600 text-white" : "hover:bg-muted")}
        >
          Only clients we can contact
        </Link>
        <form action="/office" className="ml-auto">
          <input type="hidden" name="tab" value="renewals" />
          {query.range !== "30" ? <input type="hidden" name="range" value={query.range} /> : null}
          {query.type !== "all" ? <input type="hidden" name="type" value={query.type} /> : null}
          {query.contact ? <input type="hidden" name="contact" value="1" /> : null}
          <label className="relative block">
            <span className="sr-only">Search renewals</span>
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input name="q" defaultValue={query.q} placeholder="Client or policy" className="w-56 pl-8" />
          </label>
        </form>
      </div>

      {shown.length ? (
        groups
          .filter(([, list]) => list.length)
          .map(([label, list]) => (
            <section key={label} className="mb-5">
              <h2 className="mb-2 text-sm font-semibold">
                {label} <span className="text-muted-foreground">{list.length}</span>
              </h2>
              <ul className="surface divide-y">
                {list.map((item) => (
                  <RenewalRow key={item.id} item={item} back={back} />
                ))}
              </ul>
            </section>
          ))
      ) : (
        <Empty>
          {items.length
            ? "No policies match these filters."
            : "No upcoming expiries yet. End dates are read from each gap report automatically; you can also correct a date on any policy here."}
        </Empty>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        End dates come from each client&apos;s gap report. Contact details exist only when the client asked for a call; respect their marketing choice
        when offering other services.
      </p>
    </>
  );
}

function Chips({ current, options, href }: { current: string; options: [string, string][]; href: (id: string) => string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([id, label]) => (
        <Link
          key={id}
          href={href(id)}
          className={cn("rounded-full border px-2.5 py-0.5 text-xs", current === id ? "border-brand-600 bg-brand-600 text-white" : "hover:bg-muted")}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}

function RenewalRow({ item, back }: { item: OfficeRenewal; back: string }) {
  const contact = item.contact;
  const wa = whatsappLink(contact?.phone);
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <DaysLeft days={item.days_left} />
        <div className="min-w-48 flex-1">
          <strong className="block text-sm">{item.title || `${officeType(item.policy_type)} policy`}</strong>
          <small className="block text-xs text-muted-foreground">
            {officeType(item.policy_type)} · ends {dateFormat(item.expires_on)}
            {item.expiry_source === "manual" ? " (set by the team)" : ""} · {item.filename}
          </small>
          <div className="mt-1">
            <GapChips gaps={item.gaps} />
          </div>
        </div>
        <div className="min-w-40">
          {contact ? (
            <>
              <strong className="block text-sm">{contact.name || "—"}</strong>
              <small className="text-xs text-muted-foreground">
                {contact.phone || contact.email || "—"}
                {contact.marketing_opt_in ? " · agreed to updates" : ""}
              </small>
            </>
          ) : (
            <>
              <strong className="block text-sm text-muted-foreground">No contact details</strong>
              <small className="text-xs text-muted-foreground">This visitor did not ask for a call</small>
            </>
          )}
        </div>
        <form action={updateRenewalAction} className="flex items-center gap-1.5">
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="back" value={back} />
          <NativeSelect name="renewal_status" defaultValue={item.renewal_status} size="sm" aria-label="Renewal status" className="w-44">
            {OFFICE_RENEWAL_STEPS.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </NativeSelect>
          <Button type="submit" size="sm" variant="outline">Save</Button>
        </form>
        <div className="flex gap-1.5">
          {contact?.phone ? (
            <Button asChild size="sm">
              <a href={`tel:${contact.phone}`}><Phone className="size-4" /> Call</a>
            </Button>
          ) : null}
          {wa ? (
            <Button asChild size="sm" variant="outline">
              <a href={`${wa}?text=${encodeURIComponent(renewalMessage(contact?.name, item.policy_type, item.expires_on))}`} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="size-4" /> WhatsApp
              </a>
            </Button>
          ) : null}
        </div>
      </div>
      <details className="mt-2 group">
        <summary className="cursor-pointer text-xs text-brand-700 select-none hover:underline">Note, end date and files</summary>
        <div className="mt-2 grid gap-3 md:grid-cols-[minmax(0,1fr)_260px]">
          <form action={updateRenewalAction} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={item.id} />
            <input type="hidden" name="back" value={back} />
            <label className="text-xs text-muted-foreground" htmlFor={`note-${item.id}`}>Renewal note</label>
            <Textarea id={`note-${item.id}`} name="renewal_note" defaultValue={item.renewal_note} maxLength={2000} rows={3} placeholder="Quotes sent, insurer chosen, next call…" />
            <div>
              <Button type="submit" size="sm">Save note</Button>
            </div>
          </form>
          <div className="flex flex-col gap-2">
            <form action={updateRenewalAction} className="flex flex-col gap-1.5">
              <input type="hidden" name="id" value={item.id} />
              <input type="hidden" name="back" value={back} />
              <label className="text-xs text-muted-foreground" htmlFor={`date-${item.id}`}>Correct the end date</label>
              <div className="flex gap-1.5">
                <Input id={`date-${item.id}`} type="date" name="expires_on" defaultValue={item.expires_on} required />
                <Button type="submit" size="sm" variant="outline">Save date</Button>
              </div>
            </form>
            <div className="flex flex-wrap gap-1.5">
              {contact?.id ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={requestsHref({ id: contact.id, filter: "all" })}>Open client</Link>
                </Button>
              ) : null}
              <Button asChild size="sm" variant="outline">
                <a href={`/office/policies/${item.id}/download`}><Download className="size-4" /> Policy file</a>
              </Button>
            </div>
            {item.renewal_updated_at ? (
              <small className="text-xs text-muted-foreground">
                Last updated {officeAgo(item.renewal_updated_at)}
                {item.renewal_updated_by ? ` by ${item.renewal_updated_by}` : ""}
              </small>
            ) : null}
          </div>
        </div>
      </details>
    </li>
  );
}
