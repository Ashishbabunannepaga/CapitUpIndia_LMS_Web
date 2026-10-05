"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ExternalLink, Loader2, UserPlus } from "lucide-react";

import {
  checkDuplicates,
  createLead,
  mergeIntoExistingLead,
  updateLead,
  type LeadFormState,
  type SimilarLead,
} from "@/app/(app)/leads/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { Lead } from "@/lib/database.types";
import { BUSINESS_TYPES, LEAD_STATUSES, LEAD_TYPES, POLICY_PRODUCTS } from "@/lib/domain";
import { cn } from "@/lib/utils";

type Agent = { id: string; full_name: string };

type Props = {
  mode: "create" | "edit";
  lead?: Lead;
  /** Present for admins: who the lead can be assigned to. */
  agents?: Agent[];
  currentUserId: string;
  isAdmin: boolean;
};

const EMPTY: Record<string, string> = {
  client_name: "",
  type: "New",
  business_type: "Corporate",
  policy_product: "Health",
  sub_product_name: "",
  renewal_date: "",
  poc_name: "",
  poc_designation: "",
  poc_contact_number: "",
  poc_email_id: "",
  poc2_name: "",
  poc2_designation: "",
  poc2_contact_number: "",
  poc2_email_id: "",
  notes: "",
  status: "Prospect",
  assigned_agent_id: "",
};

function initialValues(lead?: Lead): Record<string, string> {
  if (!lead) return EMPTY;
  const values: Record<string, string> = {};
  for (const key of Object.keys(EMPTY)) {
    const value = lead[key as keyof Lead];
    values[key] = value == null ? "" : String(value);
  }
  return values;
}

function Field({
  label,
  name,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  name: string;
  error?: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={name}>{label}</Label>
      {children}
      {error ? (
        <p id={`${name}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="mb-4">
        <h2 className="font-semibold">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function DuplicatePanel({
  matches,
  confirmRequired,
  canOpen,
  busy,
}: {
  matches: SimilarLead[];
  confirmRequired: boolean;
  canOpen: (match: SimilarLead) => boolean;
  busy: boolean;
}) {
  const exact = matches.some((m) => m.is_exact);
  return (
    <div
      role="alert"
      className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="font-semibold">
            {exact ? "This company is already in the CRM." : "A similar company is already in the CRM."}
          </p>
          <p className="text-red-800/80 dark:text-red-100/80">
            Check before reaching out so two agents don&apos;t pursue the same account. If it&apos;s the same company,
            add your contacts to the existing lead instead.
          </p>
        </div>
      </div>
      <ul className="divide-y divide-red-200 rounded-lg border border-red-200 bg-white/70 dark:divide-red-900 dark:border-red-900 dark:bg-transparent">
        {matches.map((match) => (
          <li key={match.lead_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <div className="min-w-0">
              <p className="font-medium">
                {match.client_name}
                <span className="ml-2 text-xs font-normal text-red-800/70 dark:text-red-100/70">
                  {match.is_exact ? "Same company" : `${Math.round(match.similarity * 100)}% similar`}
                </span>
              </p>
              <p className="text-xs text-red-800/80 dark:text-red-100/80">Handled by {match.assigned_agent_name}</p>
            </div>
            {canOpen(match) ? (
              <div className="flex items-center gap-2">
                <Button asChild size="sm" variant="outline" className="bg-white dark:bg-transparent">
                  <Link href={`/leads/${match.lead_id}`} target="_blank">
                    <ExternalLink />
                    Open
                  </Link>
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  name="merge_into"
                  value={match.lead_id}
                  formNoValidate
                  disabled={busy}
                >
                  <UserPlus />
                  Add my contacts to this lead
                </Button>
              </div>
            ) : (
              <span className="text-xs text-red-800/70 dark:text-red-100/70">Ask your admin before contacting them</span>
            )}
          </li>
        ))}
      </ul>
      {confirmRequired ? (
        <label className="flex items-start gap-2 font-medium">
          <input type="checkbox" name="confirm_duplicate" className="mt-0.5 size-4 accent-red-600" required />
          <span>
            It&apos;s a different company, or I&apos;ve agreed it with the team. Save it as a separate lead.
            {exact ? " It will be flagged as a duplicate for admin review." : ""}
          </span>
        </label>
      ) : null}
    </div>
  );
}

export function LeadForm({ mode, lead, agents = [], currentUserId, isAdmin }: Props) {
  // One action for the form: "Add my contacts to this lead" buttons carry
  // merge_into and go to the merge action; everything else saves.
  const [state, formAction, pending] = useActionState<LeadFormState, FormData>(async (prev, formData) => {
    if (formData.get("merge_into")) return mergeIntoExistingLead(prev, formData);
    return mode === "edit" && lead ? updateLead(lead.id, prev, formData) : createLead(prev, formData);
  }, {});

  const values = state.values ?? initialValues(lead);
  const errors = state.fieldErrors ?? {};
  const error = state.error;

  // Live fuzzy duplicate check while typing the company name. Results are
  // kept with the name they were fetched for, so stale ones are ignored.
  const [clientName, setClientName] = useState(values.client_name);
  const [live, setLive] = useState<{ name: string; matches: SimilarLead[] }>({ name: "", matches: [] });
  const [checking, setChecking] = useState(false);
  const originalName = lead?.client_name ?? "";
  const requestId = useRef(0);
  const trimmedName = clientName.trim();
  const shouldCheck = trimmedName.length >= 3 && trimmedName.toLowerCase() !== originalName.trim().toLowerCase();

  useEffect(() => {
    if (!shouldCheck) return;
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        const matches = await checkDuplicates(trimmedName, lead?.id);
        if (id === requestId.current) setLive({ name: trimmedName, matches });
      } catch {
        // The save action repeats the check, so a failed lookup is not fatal.
      } finally {
        if (id === requestId.current) setChecking(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [trimmedName, shouldCheck, lead?.id]);

  const liveMatches = shouldCheck && live.name === trimmedName ? live.matches : [];
  const serverMatches = state.duplicates ?? [];
  const matches = serverMatches.length > 0 ? serverMatches : liveMatches;
  const canOpen = (match: SimilarLead) => isAdmin || match.assigned_agent_id === currentUserId;

  const formKey = JSON.stringify(values);

  return (
    <form
      key={formKey}
      action={formAction}
      className="space-y-5"
    >
      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <Section title="Company and policy">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field
            label="Client or company name"
            name="client_name"
            error={errors.client_name}
            hint={checking && shouldCheck ? "Checking for existing records…" : undefined}
            className="md:col-span-2 xl:col-span-3"
          >
            <div className="relative">
              <Input
                id="client_name"
                name="client_name"
                required
                maxLength={300}
                autoComplete="off"
                defaultValue={values.client_name}
                onChange={(event) => setClientName(event.target.value)}
                aria-invalid={Boolean(errors.client_name)}
                placeholder="e.g. Renee Systems Pvt Ltd"
              />
              {checking && shouldCheck ? (
                <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              ) : null}
            </div>
          </Field>

          {matches.length > 0 ? (
            <div className="md:col-span-2 xl:col-span-3">
              <DuplicatePanel
                matches={matches}
                confirmRequired
                canOpen={canOpen}
                busy={pending}
              />
            </div>
          ) : null}

          <Field label="New or renewal" name="type">
            <NativeSelect id="type" name="type" defaultValue={values.type}>
              {LEAD_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Corporate or retail" name="business_type">
            <NativeSelect id="business_type" name="business_type" defaultValue={values.business_type}>
              {BUSINESS_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Status" name="status">
            <NativeSelect id="status" name="status" defaultValue={values.status}>
              {LEAD_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Policy product" name="policy_product">
            <NativeSelect id="policy_product" name="policy_product" defaultValue={values.policy_product}>
              {POLICY_PRODUCTS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Sub-product" name="sub_product_name" error={errors.sub_product_name}>
            <Input
              id="sub_product_name"
              name="sub_product_name"
              maxLength={200}
              defaultValue={values.sub_product_name}
              placeholder="e.g. Group health, WC"
            />
          </Field>
          <Field
            label="Renewal date"
            name="renewal_date"
            error={errors.renewal_date}
            hint="Reminders are scheduled from T-30 days to T-5 minutes."
          >
            <Input id="renewal_date" name="renewal_date" type="date" defaultValue={values.renewal_date} />
          </Field>
          {isAdmin ? (
            <Field label="Assigned agent" name="assigned_agent_id">
              <NativeSelect id="assigned_agent_id" name="assigned_agent_id" defaultValue={values.assigned_agent_id || "unassigned"}>
                <option value="unassigned">Unassigned</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.full_name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
        </div>
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        {(["poc", "poc2"] as const).map((prefix) => (
          <Section
            key={prefix}
            title={prefix === "poc" ? "Primary POC" : "Secondary POC"}
            description={prefix === "poc" ? "Designation defaults to poc unless you enter one." : "Optional."}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" name={`${prefix}_name`} error={errors[`${prefix}_name`]}>
                <Input id={`${prefix}_name`} name={`${prefix}_name`} maxLength={120} defaultValue={values[`${prefix}_name`]} />
              </Field>
              <Field label="Designation" name={`${prefix}_designation`} error={errors[`${prefix}_designation`]}>
                <Input
                  id={`${prefix}_designation`}
                  name={`${prefix}_designation`}
                  maxLength={120}
                  defaultValue={values[`${prefix}_designation`]}
                  placeholder="poc"
                />
              </Field>
              <Field label="Phone" name={`${prefix}_contact_number`} error={errors[`${prefix}_contact_number`]}>
                <Input
                  id={`${prefix}_contact_number`}
                  name={`${prefix}_contact_number`}
                  type="tel"
                  maxLength={32}
                  defaultValue={values[`${prefix}_contact_number`]}
                  aria-invalid={Boolean(errors[`${prefix}_contact_number`])}
                />
              </Field>
              <Field label="Email" name={`${prefix}_email_id`} error={errors[`${prefix}_email_id`]}>
                <Input
                  id={`${prefix}_email_id`}
                  name={`${prefix}_email_id`}
                  type="email"
                  maxLength={200}
                  defaultValue={values[`${prefix}_email_id`]}
                  aria-invalid={Boolean(errors[`${prefix}_email_id`])}
                />
              </Field>
            </div>
          </Section>
        ))}
      </div>

      <Section
        title="Lead notes"
        description="Background captured with the lead. Use the notes thread on the lead page for timestamped updates."
      >
        <Textarea
          id="notes"
          name="notes"
          rows={4}
          maxLength={20000}
          defaultValue={values.notes}
          placeholder="Current insurer, premium, family size, anything the next person should know"
        />
      </Section>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button asChild variant="ghost">
          <Link href={lead ? `/leads/${lead.id}` : "/leads"}>Cancel</Link>
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          {mode === "edit" ? "Save changes" : "Save lead"}
        </Button>
      </div>
    </form>
  );
}
