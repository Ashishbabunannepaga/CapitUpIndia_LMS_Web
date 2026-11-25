import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Users } from "lucide-react";

import { PageHeader } from "@/components/app-shell/page-header";
import { PriorityBadge, TagChips } from "@/components/work-tasks/task-badges";
import { DeleteTemplateButton, TemplateDialog } from "@/components/work-tasks/task-templates";
import { isAdmin, requireSession } from "@/lib/auth";
import { parseTags } from "@/lib/work-tasks";
import { listTaskTemplates } from "@/server/data/work-tasks";

export const metadata: Metadata = { title: "Task templates" };

export default async function TaskTemplatesPage() {
  const { ctx, actor } = await requireSession();
  const admin = isAdmin(actor);
  const templates = await listTaskTemplates(ctx, actor);

  return (
    <>
      <Link href="/tasks" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary">
        <ArrowLeft className="size-4" /> Task Grid
      </Link>
      <PageHeader
        eyebrow="Task Grid"
        title="Templates"
        description={
          admin
            ? "Reusable tasks. Share one with the team and everyone can start from it under New task."
            : "Your reusable tasks, plus the ones your admins shared. Pick one under New task."
        }
        actions={<TemplateDialog admin={admin} trigger="new" />}
      />
      {templates.length ? (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((t) => {
            const mine = t.owner_id === actor.id;
            const manage = mine || (t.shared && admin);
            return (
              <li key={t.id} className="surface flex flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{t.name}</p>
                    <p className="truncate text-sm text-muted-foreground">{t.title}</p>
                  </div>
                  {manage ? (
                    <div className="flex shrink-0 items-center">
                      <TemplateDialog
                        admin={admin}
                        trigger="edit"
                        draft={{
                          id: t.id,
                          name: t.name,
                          title: t.title,
                          description: t.description,
                          priority: t.priority,
                          tags: t.tags,
                          due_in_days: t.due_in_days,
                          shared: t.shared,
                        }}
                      />
                      <DeleteTemplateButton id={t.id} name={t.name} />
                    </div>
                  ) : null}
                </div>
                {t.description ? <p className="line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">{t.description}</p> : null}
                <div className="mt-auto flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <PriorityBadge priority={t.priority} short />
                  <span>{t.due_in_days == null ? "No deadline" : t.due_in_days === 0 ? "Due the same day" : `Due in ${t.due_in_days} day${t.due_in_days === 1 ? "" : "s"}`}</span>
                  {t.shared ? (
                    <span className="inline-flex items-center gap-1">
                      <Users className="size-3" /> Team
                    </span>
                  ) : null}
                </div>
                <TagChips tags={parseTags(t.tags)} />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="surface p-8 text-center text-sm text-muted-foreground">
          No templates yet. Make one here, or open a task and choose Save as template.
        </p>
      )}
    </>
  );
}
