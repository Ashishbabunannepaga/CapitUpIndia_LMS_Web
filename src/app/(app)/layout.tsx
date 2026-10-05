import { AppShell } from "@/components/app-shell/app-shell";
import { RealtimeRefresh } from "@/components/app-shell/realtime-refresh";
import { requireProfile } from "@/lib/auth";
import { getUnreadNoteCount } from "@/lib/leads";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const profile = await requireProfile();
  const unreadNotes = await getUnreadNoteCount();

  return (
    <AppShell
      user={{ full_name: profile.full_name, email: profile.email, role: profile.role }}
      badges={{ "/my-day": unreadNotes }}
    >
      <RealtimeRefresh />
      {children}
    </AppShell>
  );
}
