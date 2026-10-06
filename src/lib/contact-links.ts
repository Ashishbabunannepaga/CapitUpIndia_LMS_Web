// Links for calling, emailing and WhatsApp-ing a POC. A POC phone field may
// hold several numbers separated by commas or slashes; the first is used.

export function firstPhone(phone: string): string {
  return phone.split(/[,/]/)[0]?.trim() ?? "";
}

export function telHref(phone: string): string | null {
  const number = firstPhone(phone).replace(/[^\d+]/g, "");
  return number.replace(/\D/g, "").length >= 6 ? `tel:${number}` : null;
}

/** wa.me link, optionally with a prefilled message; 10-digit Indian mobiles get the 91 country code. */
export function whatsappHref(phone: string, text?: string): string | null {
  let digits = firstPhone(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length < 11) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export function mailtoHref(email: string, subject?: string, body?: string): string | null {
  if (!email.includes("@")) return null;
  const params = [
    subject ? `subject=${encodeURIComponent(subject)}` : "",
    body ? `body=${encodeURIComponent(body)}` : "",
  ].filter(Boolean);
  return `mailto:${email}${params.length ? `?${params.join("&")}` : ""}`;
}
