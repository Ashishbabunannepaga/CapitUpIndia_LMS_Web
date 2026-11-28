"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { isMobile, MOBILE_DIGITS, toMobileDigits } from "@/lib/mobile";

/** A saved number as 10 digits when it is one; anything else (a landline, two numbers) as saved, for the person to fix. */
function shown(value: string | null | undefined): string {
  if (!value) return "";
  const digits = toMobileDigits(value);
  return isMobile(digits) ? digits : value;
}

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
      pattern="[6-9][0-9]{9}"
      title="Enter a 10-digit mobile number (starts with 6, 7, 8 or 9)"
      placeholder="9876543210"
      defaultValue={shown(defaultValue)}
      onInput={(e) => {
        const el = e.currentTarget;
        // An old value holding two numbers: keep the first one's digits.
        const first = el.value.split(/[,/;&]|\band\b/)[0] ?? "";
        const next = toMobileDigits(first).slice(0, MOBILE_DIGITS);
        if (next !== el.value) el.value = next;
        onInput?.(e);
      }}
      {...props}
    />
  );
}

export { MobileInput };
