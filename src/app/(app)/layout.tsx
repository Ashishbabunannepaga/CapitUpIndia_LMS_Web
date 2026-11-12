import { AppShell } from "@/components/app-shell/app-shell";
import { RealtimeRefresh } from "@/components/app-shell/realtime-refresh";
import { requireSession } from "@/lib/auth";
import { shellSummary } from "@/server/data/shell";
import { pushPublicKey } from "@/server/push/public-key";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { ctx, actor: profile } = await requireSession();
  const [shell, pushKey] = await Promise.all([shellSummary(ctx, profile), pushPublicKey()]);

  return (
    <AppShell
      user={{ full_name: profile.full_name, email: profile.email, role: profile.role }}
      badges={{ "/my-day": shell.unreadNotes }}
      notifications={shell.notifications}
      unreadNotifications={shell.unreadNotifications}
      pushPublicKey={pushKey}
    >
      <RealtimeRefresh stamp={shell.stamp} />
      {children}
    </AppShell>
  );
}
