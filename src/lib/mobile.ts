/**
 * Indian mobile numbers are 10 digits. The phone fields only take digits and
 * stop at 10; a number pasted with +91, 91 or a leading 0 drops that prefix.
 */
export const MOBILE_DIGITS = 10;

/** Digits only, with a +91 / 91 / 0 prefix dropped from an otherwise 10-digit number. */
export function toMobileDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export const isMobile = (value: string) => new RegExp(`^\\d{${MOBILE_DIGITS}}$`).test(value);
