import type { Metadata } from "next";

import { ScreenPlaceholder } from "@/components/app-shell/screen-placeholder";

export const metadata: Metadata = { title: "Leads" };

export default function Page() {
  return <ScreenPlaceholder href="/leads" />;
}
