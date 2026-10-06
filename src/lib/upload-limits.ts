// Server actions on Vercel cannot receive a request body over 4.5 MB, and
// next.config.ts caps them at 4.4 MB. Files are kept under 4 MB so the form
// overhead still fits. Shared by the client (early, friendly message) and
// the server actions (the real check).
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = "4 MB";
