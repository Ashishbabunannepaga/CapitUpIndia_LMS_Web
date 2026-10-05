import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Team" };

const joinedFormat = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

export default async function TeamPage() {
  const supabase = await createClient();
  const { data: members, error } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, is_active, created_at")
    .order("is_active", { ascending: false })
    .order("full_name");

  if (error) {
    throw new Error(`Could not load the team: ${error.message}`);
  }

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
