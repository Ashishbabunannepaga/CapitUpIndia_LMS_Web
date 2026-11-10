"use client";

import { logLeadContact } from "@/app/(app)/leads/actions";
import type { ContactChannel } from "@/lib/domain";

type Props = React.ComponentProps<"a"> & { leadId: number; channel: ContactChannel; withDraft?: boolean };

/** A Call, WhatsApp or Email link that records the press on the lead's contact history. */
export function ContactLink({ leadId, channel, withDraft = false, onClick, ...props }: Props) {
  return (
    <a
      {...props}
      onClick={(event) => {
        onClick?.(event);
        // Not awaited: the call, chat or mail window opens straight away.
        void logLeadContact(leadId, channel, withDraft);
      }}
    />
  );
}
