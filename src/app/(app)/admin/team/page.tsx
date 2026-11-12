import type { Metadata } from "next";
import Link from "next/link";
import { Eye, KeyRound, ShieldAlert, Snowflake, UserPlus } from "lucide-react";

import { AddMemberForm, MemberControls, StaleDaysForm } from "@/components/admin/team-controls";
import { StatCard } from "@/components/analytics/charts";
import { PageHeader } from "@/components/app-shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { pipelineAnalytics } from "@/server/data/analytics";
import { recentSignInFailures } from "@/server/data/sign-in-failures";
import { getStaleDays } from "@/server/data/stale";
import { listTeam } from "@/server/data/users";

export const metadata: Metadata = { title: "Team" };

const attemptFormat = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

const FAILURE_LABELS = { invalid: "Wrong email or password", inactive: "Disabled account" } as const;

const joinedFormat = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

export default async function TeamPage() {
  const { ctx, actor } = await requireSession();
  // Active people first, then by name.
  const [team, pipeline, failures, staleDays] = await Promise.all([
    listTeam(ctx, actor),
    pipelineAnalytics(ctx, actor),
    recentSignInFailures(ctx, actor, 25),
    getStaleDays(ctx),
  ]);
  const members = team.sort((a, b) => Number(b.is_active) - Number(a.is_active));
  const owned = new Map(pipeline.agents.map((a) => [a.agent_id, a]));
  const active = members.filter((m) => m.is_active);
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Team"
        description="Agents and admins who can sign in. Only admins add people; there is no public sign-up."
      />
      <div className="stagger mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="People" value={members.length} tone="brand" />
        <StatCard label="Active" value={active.length} tone="success" />
        <StatCard label="Admins" value={active.filter((m) => m.role === "ADMIN").length} tone="gold" />
        <StatCard
          label="Disabled"
          value={members.length - active.length}
          tone="urgent"
          quiet={members.length === active.length}
        />
      </div>
      <Card className="mb-6 animate-rise">
        <CardHeader>
          <CardTitle className="flex items-center gap-2.5 text-base">
            <span className="flex size-7 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
              <UserPlus className="size-4" />
            </span>
            Add a person
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AddMemberForm />
        </CardContent>
      </Card>
      <Card className="animate-rise overflow-hidden py-0 [animation-delay:120ms]">
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/60 text-left text-xs font-medium text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Leads</th>
                  <th className="px-4 py-3 font-medium">Joined</th>
                  <th className="px-4 py-3 font-medium">Manage</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {members.map((member) => (
                  <tr
                    key={member.id}
                    className={cn("transition-colors hover:bg-muted/40", !member.is_active && "text-muted-foreground")}
                  >
                    <td className="px-4 py-3 font-medium">
                      <span className="flex items-center gap-3">
                        <span
                          aria-hidden="true"
                          className={cn(
                            "flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                            !member.is_active
                              ? "bg-muted text-muted-foreground"
                              : member.role === "ADMIN"
                                ? "bg-gold-200 text-gold-900"
                                : "bg-brand-100 text-brand-900",
                          )}
                        >
                          {initials(member.full_name)}
                        </span>
                        {member.full_name}
                      </span>
                    </td>
                    <td className="px-4 py-3">{member.email}</td>
                    <td className="px-4 py-3">
                      <Badge
                        variant="outline"
                        className={
                          member.role === "ADMIN" ? "border-gold-200 bg-gold-50 text-gold-800" : "border-brand-200 bg-brand-50 text-brand-800"
                        }
                      >
                        {member.role}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {member.is_active && member.must_change_password ? (
                        <span className="inline-flex items-center gap-1.5 text-gold-800" title="Signs in with the password an admin set, then must choose their own.">
                          <KeyRound className="size-3.5" aria-hidden="true" />
                          New password due
                        </span>
                      ) : member.is_active ? (
                        <span className="inline-flex items-center gap-1.5 text-success">
                          <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                          Disabled
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {owned.get(member.id)?.total ?? 0}
                      {owned.get(member.id)?.overdue_renewals ? (
                        <span className="ml-1.5 text-xs font-medium text-urgent">
                          ({owned.get(member.id)!.overdue_renewals} overdue)
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{joinedFormat.format(new Date(member.created_at))}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <MemberControls key={`${member.role}-${member.is_active}`} member={member} isSelf={member.id === actor.id} />
                        {member.role === "AGENT" ? (
                          <Button asChild size="sm" variant="outline" title={`See ${member.full_name}'s My Day, read-only`}>
                            <Link href={`/admin/team/${member.id}/view`}>
                              <Eye />
                              View as agent
                            </Link>
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      <Card className="mt-6 animate-rise [animation-delay:160ms]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2.5 text-base">
            <span className="flex size-7 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
              <Snowflake className="size-4" />
            </span>
            Stale lead alerts
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Open leads (not Closed Won or Closed Lost) with no activity for this long get a Stale badge on Leads, and the
            count shows on My Day, so you can nudge the agent before they go cold.
          </p>
        </CardHeader>
        <CardContent>
          <StaleDaysForm key={staleDays} days={staleDays} />
        </CardContent>
      </Card>
      <Card className="mt-6 animate-rise overflow-hidden py-0 [animation-delay:200ms]">
        <CardHeader className="pt-6">
          <CardTitle className="flex items-center gap-2.5 text-base">
            <span className="flex size-7 items-center justify-center rounded-lg bg-urgent/10 text-urgent">
              <ShieldAlert className="size-4" />
            </span>
            Failed sign-ins
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            The latest 25. Admins get a bell alert when one account has 5 failures, or one address 10, within 15 minutes.
          </p>
        </CardHeader>
        <CardContent className="px-0">
          {failures.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No failed sign-ins in the last 90 days.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/60 text-left text-xs font-medium text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">When</th>
                    <th className="px-4 py-3 font-medium">Email tried</th>
                    <th className="px-4 py-3 font-medium">Why</th>
                    <th className="px-4 py-3 font-medium">From</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {failures.map((f) => (
                    <tr key={f.id}>
                      <td className="px-4 py-3 tabular-nums">{attemptFormat.format(new Date(f.created_at))}</td>
                      <td className="px-4 py-3">{f.email}</td>
                      <td className="px-4 py-3">{FAILURE_LABELS[f.reason]}</td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">{f.ip ?? "unknown"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
