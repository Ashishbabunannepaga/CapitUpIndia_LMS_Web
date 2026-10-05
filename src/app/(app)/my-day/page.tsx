import type { Metadata } from "next";

import { ScreenPlaceholder } from "@/components/app-shell/screen-placeholder";

export const metadata: Metadata = { title: "My Day" };

export default function Page() {
  return <ScreenPlaceholder href="/my-day" />;
}
