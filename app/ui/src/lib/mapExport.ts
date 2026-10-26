/**
 * The content of a `data:` URL as base64, as the backend's `save_image` takes it: a PNG's is
 * base64 already; an SVG's is URL-encoded text (what html-to-image makes), encoded as UTF-8 here.
 */
export function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (header.endsWith(";base64")) return body;
  const bytes = new TextEncoder().encode(decodeURIComponent(body));
  // `btoa` takes a "binary string" (one character per byte).
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** `routes-demo-edge-20261026-2130` */
export function mapFileName(cluster: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `routes-${cluster}-${date}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
