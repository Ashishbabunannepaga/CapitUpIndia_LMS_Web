/** Where a bell item or push notification opens: its task's thread, its lead, or My Day. */
export function notificationHref(n: { lead_id: number | null; task_id?: number | null }): string {
  if (n.task_id) return `/tasks/${n.task_id}`;
  return n.lead_id ? `/leads/${n.lead_id}` : "/my-day";
}
