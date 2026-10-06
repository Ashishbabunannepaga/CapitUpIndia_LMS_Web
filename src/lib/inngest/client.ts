import { Inngest } from "inngest";

// Inngest runs the scheduled work: the renewal countdown dispatcher. Jobs run
// on the server, so reminders fire whether or not anyone has the app open.
export const inngest = new Inngest({ id: "capitupindia-lms" });
