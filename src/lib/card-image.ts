// Browser-side resizing for visiting card photos. Phone photos are often
// 3-8 MB; shrinking them before upload makes card scanning and attaching much
// faster. Two sizes are sent: the card itself (sharp enough for OCR, kept in
// R2) and a small preview kept in the database for the lead page.

/** Matches MAX_CARD_PREVIEW_BYTES in src/server/data/cards.ts. */
export const CARD_PREVIEW_MAX_BYTES = 300 * 1024;

function toJpeg(bitmap: ImageBitmap, maxSide: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("Could not read the image"));
  // White behind transparent PNGs, which JPEG would otherwise turn black.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not read the image"))), "image/jpeg", quality),
  );
}

/** The card for upload (longest side 1600 px) and its preview (640 px, under 300 KB), both JPEG. */
export async function prepareCardImages(file: Blob): Promise<{ card: Blob; preview: Blob }> {
  const bitmap = await createImageBitmap(file);
  try {
    const card = await toJpeg(bitmap, 1600, 0.85);
    let preview = await toJpeg(bitmap, 640, 0.72);
    for (const [side, quality] of [[560, 0.6], [480, 0.5], [360, 0.45]] as const) {
      if (preview.size <= CARD_PREVIEW_MAX_BYTES) break;
      preview = await toJpeg(bitmap, side, quality);
    }
    return { card, preview };
  } finally {
    bitmap.close();
  }
}

/** FormData with the "card" and "preview" files the upload actions expect. */
export function cardFormData(images: { card: Blob; preview: Blob }): FormData {
  const formData = new FormData();
  formData.set("card", new File([images.card], "card.jpg", { type: "image/jpeg" }));
  formData.set("preview", new File([images.preview], "card-preview.jpg", { type: "image/jpeg" }));
  return formData;
}
