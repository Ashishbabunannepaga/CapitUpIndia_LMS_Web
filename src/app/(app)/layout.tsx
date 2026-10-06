import { AppShell } from "@/components/app-shell/app-shell";
import { RealtimeRefresh } from "@/components/app-shell/realtime-refresh";
import { requireProfile } from "@/lib/auth";
import { getRecentNotifications, getUnreadNoteCount } from "@/lib/leads";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const profile = await requireProfile();
  const [unreadNotes, notifications] = await Promise.all([getUnreadNoteCount(), getRecentNotifications()]);

  return (
    <AppShell
      user={{ full_name: profile.full_name, email: profile.email, role: profile.role }}
      badges={{ "/my-day": unreadNotes }}
      notifications={notifications.items}
      unreadNotifications={notifications.unread}
    >
      <RealtimeRefresh />
      {children}
    </AppShell>
  );
}
