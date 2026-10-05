import { requireAdmin } from "@/lib/auth";

// Server-side gate for every /admin page. RLS enforces the same rules on data.
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await requireAdmin();
  return children;
}
