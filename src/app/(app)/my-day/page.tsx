import type { Metadata } from "next";

import { MyDayScreen } from "@/components/my-day/my-day-screen";
import { requireSession } from "@/lib/auth";

export const metadata: Metadata = { title: "My Day" };

export default async function MyDayPage() {
  const { ctx, actor } = await requireSession();
  return <MyDayScreen ctx={ctx} profile={actor} />;
}
