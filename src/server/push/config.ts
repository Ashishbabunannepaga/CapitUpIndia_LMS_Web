import { hasVapidKeys, type VapidKeys } from "./web-push";

/** Where push services can reach us if a message is refused (RFC 8292 "sub"). */
const DEFAULT_SUBJECT = "https://lms.capitupindia.com";

type PushEnv = { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string; BETTER_AUTH_URL?: string };

/** The VAPID key pair from the Worker's secrets, or null when push is not set up. */
export function vapidKeysFrom(env: PushEnv): VapidKeys | null {
  const keys = {
    publicKey: env.VAPID_PUBLIC_KEY?.trim() ?? "",
    privateKey: env.VAPID_PRIVATE_KEY?.trim() ?? "",
    subject: env.VAPID_SUBJECT?.trim() || env.BETTER_AUTH_URL?.trim() || DEFAULT_SUBJECT,
  };
  return hasVapidKeys(keys) ? keys : null;
}
