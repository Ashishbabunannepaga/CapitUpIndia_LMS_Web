import { AppShell } from "@/components/app-shell/app-shell";
import { requireProfile } from "@/lib/auth";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const profile = await requireProfile();

  return (
    <AppShell user={{ full_name: profile.full_name, email: profile.email, role: profile.role }}>
      {children}
    </AppShell>
  );
}
