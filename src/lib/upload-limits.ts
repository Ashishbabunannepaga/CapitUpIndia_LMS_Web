// next.config.ts caps server action bodies at 4.4 MB. Files are kept under
// 4 MB so the form overhead still fits. Shared by the client (early, friendly message) and
// the server actions (the real check).
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = "4 MB";
