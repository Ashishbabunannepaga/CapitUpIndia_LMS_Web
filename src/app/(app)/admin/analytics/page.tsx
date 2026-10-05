import type { Metadata } from "next";

import { ScreenPlaceholder } from "@/components/app-shell/screen-placeholder";

export const metadata: Metadata = { title: "Analytics" };

export default function Page() {
  return <ScreenPlaceholder href="/admin/analytics" />;
}
