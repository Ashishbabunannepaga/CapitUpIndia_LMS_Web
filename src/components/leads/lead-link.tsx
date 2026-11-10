"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * A link to a lead that prefetches only once the user shows intent (pointer
 * over it, touch or keyboard focus). Lists show up to a hundred leads; letting
 * each link prefetch as it scrolled into view sent a hundred requests to the
 * Worker at once, which queued behind each other and slowed the click the
 * user actually made. Hovering still fetches the lead's loading screen ahead
 * of the click, so the page responds at once.
 */
export function LeadLink({ onMouseEnter, onTouchStart, onFocus, ...props }: React.ComponentProps<typeof Link>) {
  const [intent, setIntent] = useState(false);
  return (
    <Link
      {...props}
      prefetch={intent ? null : false}
      onMouseEnter={(event) => {
        setIntent(true);
        onMouseEnter?.(event);
      }}
      onTouchStart={(event) => {
        setIntent(true);
        onTouchStart?.(event);
      }}
      onFocus={(event) => {
        setIntent(true);
        onFocus?.(event);
      }}
    />
  );
}
