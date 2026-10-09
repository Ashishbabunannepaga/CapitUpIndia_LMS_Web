import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { requireSession } from "@/lib/auth";
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
  const members = (await listTeam(ctx, actor)).sort((a, b) => Number(b.is_active) - Number(a.is_active));

  return (
    <>
      <PageHeader title="Team" description="Agents and admins who can sign in. New accounts start as agents." />
      <Card className="py-0">
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {members.map((member) => (
                  <tr key={member.id} className={member.is_active ? undefined : "text-muted-foreground"}>
                    <td className="px-4 py-3 font-medium">{member.full_name}</td>
                    <td className="px-4 py-3">{member.email}</td>
                    <td className="px-4 py-3">
                      <Badge variant={member.role === "ADMIN" ? "default" : "secondary"}>{member.role}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      {member.is_active ? (
                        <span className="text-success">Active</span>
                      ) : (
                        <span>Disabled</span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{joinedFormat.format(new Date(member.created_at))}</td>
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
