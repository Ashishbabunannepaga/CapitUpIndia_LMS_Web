import type { Metadata } from "next";
import { ShieldCheck, UserCheck, UserPlus, Users, UserX } from "lucide-react";

import { AddMemberForm, MemberControls } from "@/components/admin/team-controls";
import { StatCard } from "@/components/analytics/charts";
import { PageHeader } from "@/components/app-shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { pipelineAnalytics } from "@/server/data/analytics";
import { listTeam } from "@/server/data/users";

export const metadata: Metadata = { title: "Team" };

const joinedFormat = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

export default async function TeamPage() {
  const { ctx, actor } = await requireSession();
  // Active people first, then by name.
  const [team, pipeline] = await Promise.all([listTeam(ctx, actor), pipelineAnalytics(ctx, actor)]);
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
        <StatCard label="People" value={members.length} icon={Users} tone="brand" />
        <StatCard label="Active" value={active.length} icon={UserCheck} tone="success" />
        <StatCard label="Admins" value={active.filter((m) => m.role === "ADMIN").length} icon={ShieldCheck} tone="gold" />
        <StatCard
          label="Disabled"
          value={members.length - active.length}
          icon={UserX}
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
              <thead className="border-b bg-muted/60 text-left text-[11px] tracking-wide text-muted-foreground uppercase">
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
                                ? "bg-gradient-to-br from-gold-200 to-gold-400 text-gold-900"
                                : "bg-gradient-to-br from-brand-100 to-brand-300 text-brand-900",
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
                      {member.is_active ? (
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
                      <MemberControls key={`${member.role}-${member.is_active}`} member={member} isSelf={member.id === actor.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
