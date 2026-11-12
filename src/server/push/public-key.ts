import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { vapidKeysFrom } from "./config";

/** The VAPID public key browsers subscribe with, or null while push is not set up. */
export async function pushPublicKey(): Promise<string | null> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    return vapidKeysFrom(env)?.publicKey ?? null;
  } catch {
    return null;
  }
}
