import { redirect } from "next/navigation";

// AI Intake and New lead are one page now; old links and bookmarks land there.
export default function IntakePage() {
  redirect("/leads/new");
}
