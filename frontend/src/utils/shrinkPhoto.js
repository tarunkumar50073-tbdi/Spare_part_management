// A phone photo is 3-8 MB; the part photo needs a fraction of that. Shrink it in
// the browser to `max` px on its long side as a JPEG before it is uploaded, so
// a store LAN upload takes a second, not a minute, and stays far under the
// server's upload limit. The browser draws the picture upright (EXIF
// orientation applied), and the canvas copy carries no EXIF (no GPS) at all.
// Falls back to the original file if the browser cannot decode it here — the
// server re-encodes every upload anyway (part_image_service.py).
export async function shrinkPhoto(file, max = 1600, quality = 0.85) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";                                // a transparent PNG goes on white
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}
