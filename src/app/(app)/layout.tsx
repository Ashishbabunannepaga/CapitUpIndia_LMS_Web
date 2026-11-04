import { AppShell } from "@/components/app-shell/app-shell";
import { RealtimeRefresh } from "@/components/app-shell/realtime-refresh";
import { requireSession } from "@/lib/auth";
import { getRecentNotifications, getUnreadNoteCount } from "@/lib/leads";
import { changeStamp } from "@/server/data/changes";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { ctx, actor: profile } = await requireSession();
  // The stamp is read first so a change made while the page renders still
  // counts as new on the next poll.
  const stamp = await changeStamp(ctx, profile);
  const [unreadNotes, notifications] = await Promise.all([getUnreadNoteCount(), getRecentNotifications()]);

  return (
    <AppShell
      user={{ full_name: profile.full_name, email: profile.email, role: profile.role }}
      badges={{ "/my-day": unreadNotes }}
      notifications={notifications.items}
      unreadNotifications={notifications.unread}
    >
      <RealtimeRefresh stamp={stamp} />
      {children}
    </AppShell>
  );
}
