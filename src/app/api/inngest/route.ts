import { serve } from "inngest/next";

import { inngest } from "@/lib/inngest/client";
import { functions } from "@/lib/inngest/functions";

// Inngest calls this endpoint to run scheduled jobs. It is signed with
// INNGEST_SIGNING_KEY in production; locally `npx inngest-cli dev` finds it.
export const { GET, POST, PUT } = serve({ client: inngest, functions });
