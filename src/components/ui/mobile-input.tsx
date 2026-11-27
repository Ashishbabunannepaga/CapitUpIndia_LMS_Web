"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { MOBILE_DIGITS, toMobileDigits } from "@/lib/mobile";

/**
 * A 10-digit mobile number field: it only takes digits and stops at 10. A
 * pasted "+91 98765 43210" becomes 9876543210. The browser also refuses to
 * submit a number that isn't 10 digits (the server checks again).
 */
function MobileInput({ defaultValue, onInput, ...props }: Omit<React.ComponentProps<typeof Input>, "type" | "defaultValue"> & { defaultValue?: string | null }) {
  return (
    <Input
      type="tel"
      inputMode="numeric"
      autoComplete="tel-national"
      // No maxLength: the browser would cut a pasted "+91 98765 43210" short
      // before the prefix is dropped. onInput keeps it to 10 digits instead.
      pattern={`[0-9]{${MOBILE_DIGITS}}`}
      title={`Enter a ${MOBILE_DIGITS}-digit mobile number`}
      placeholder="9876543210"
      defaultValue={defaultValue ? toMobileDigits(defaultValue) : ""}
      onInput={(e) => {
        const el = e.currentTarget;
        const next = toMobileDigits(el.value).slice(0, MOBILE_DIGITS);
        if (next !== el.value) el.value = next;
        onInput?.(e);
      }}
      {...props}
    />
  );
}

export { MobileInput };
