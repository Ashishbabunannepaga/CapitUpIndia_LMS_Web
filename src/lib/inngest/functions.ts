import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "./client";

/**
 * Delivers every renewal reminder that has come due.
 *
 * The milestones themselves (T-30 days to T-5 minutes) are written by the
 * database when a renewal date is saved. This job turns the due ones into
 * in-app notifications and marks them sent. It runs every minute because the
 * closest milestone is five minutes out; the database function is safe to run
 * concurrently and never sends a reminder twice.
 */
export const deliverRenewalReminders = inngest.createFunction(
  {
    id: "deliver-renewal-reminders",
    name: "Deliver renewal reminders",
    triggers: [{ cron: "* * * * *" }],
    concurrency: 1,
    retries: 3,
  },
  async ({ step }) => {
    const delivered = await step.run("deliver-due-reminders", async () => {
      const { data, error } = await createAdminClient().rpc("deliver_due_reminders", { p_limit: 1000 });
      if (error) throw new Error(`Reminder delivery failed: ${error.message}`);
      return data ?? 0;
    });
    return { delivered };
  },
);

export const functions = [deliverRenewalReminders];
