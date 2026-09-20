const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function trustedImageUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "m.media-amazon.com") return null;
    if (!url.pathname.startsWith("/images/") || url.username || url.password || url.port || url.search || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function resolveProductImage(report, fetchImage = fetch) {
  const productImage = report.productImage;
  if (!productImage) return { status: "missing", dataUrl: null };
  if (productImage.asin !== report.asin || productImage.marketplace !== report.marketplace) {
    return { status: "identity_mismatch", dataUrl: null };
  }
  const url = trustedImageUrl(productImage.url);
  if (!url) return { status: "invalid_url", dataUrl: null };

  try {
    const response = await fetchImage(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    const contentLength = Number(response.headers.get("content-length"));
    if (!response.ok || !IMAGE_TYPES.has(contentType) || (contentLength > MAX_IMAGE_BYTES) || !response.body) {
      return { status: "invalid_image", dataUrl: null };
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_IMAGE_BYTES) return { status: "invalid_image", dataUrl: null };
      chunks.push(Buffer.from(chunk));
    }
    if (size === 0) return { status: "invalid_image", dataUrl: null };
    return { status: "available", dataUrl: `data:${contentType};base64,${Buffer.concat(chunks).toString("base64")}` };
  } catch {
    return { status: "fetch_failed", dataUrl: null };
  }
}
