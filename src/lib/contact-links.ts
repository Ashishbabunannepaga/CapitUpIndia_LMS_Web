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
  return draftMailtoHref(email, subject, body);
}

function emailParams(subject?: string, body?: string): string[] {
  return [
    subject ? `subject=${encodeURIComponent(subject)}` : "",
    body ? `body=${encodeURIComponent(body)}` : "",
  ].filter(Boolean);
}

/** mailto link for a ready draft; the recipient is left blank when the POC has no valid email. */
export function draftMailtoHref(email: string, subject?: string, body?: string): string {
  const to = email.includes("@") ? email.trim() : "";
  const params = emailParams(subject, body);
  return `mailto:${to}${params.length ? `?${params.join("&")}` : ""}`;
}

/** Gmail web compose link, for agents whose browser has no mail app set up. */
export function gmailComposeHref(email: string, subject?: string, body?: string): string {
  const params = ["view=cm", "fs=1"];
  if (email.includes("@")) params.push(`to=${encodeURIComponent(email.trim())}`);
  if (subject) params.push(`su=${encodeURIComponent(subject)}`);
  if (body) params.push(`body=${encodeURIComponent(body)}`);
  return `https://mail.google.com/mail/?${params.join("&")}`;
}
