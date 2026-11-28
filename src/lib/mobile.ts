/**
 * Indian mobile numbers: 10 digits starting 6-9. The phone fields only take
 * digits and stop at 10; a number pasted with +91, 91 or a leading 0 drops
 * that prefix. A landline ("040 2311 0640") is never turned into a mobile:
 * its 0 is only dropped when what's left starts 6-9.
 */
export const MOBILE_DIGITS = 10;

/** Digits only, with a +91 / 91 / 0 prefix dropped from a mobile number. */
export function toMobileDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 12 && /^91[6-9]/.test(digits)) return digits.slice(2);
  if (digits.length === 11 && /^0[6-9]/.test(digits)) return digits.slice(1);
  return digits;
}

export const isMobile = (value: string) => /^[6-9]\d{9}$/.test(value);
