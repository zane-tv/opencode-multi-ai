const MAX_IMAGES = 20;

export type KiroImage = {
  format: string;
  source: { bytes: Uint8Array };
};

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const encoded = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
    const bytes = Buffer.from(encoded, "base64");
    return bytes.length > 0 ? new Uint8Array(bytes) : undefined;
  } catch {
    return undefined;
  }
}

export function extractKiroContent(parts: unknown): {
  text: string;
  images: KiroImage[];
} {
  if (typeof parts === "string") return { text: parts, images: [] };
  if (!Array.isArray(parts)) return { text: "", images: [] };
  const text: string[] = [];
  const images: KiroImage[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object") continue;
    const value = part as {
      type?: unknown;
      text?: unknown;
      image_url?: { url?: unknown };
    };
    if (value.type === "text" && typeof value.text === "string") {
      text.push(value.text);
      continue;
    }
    if (value.type === "image_url" && images.length < MAX_IMAGES) {
      const url = value.image_url?.url;
      if (typeof url !== "string") continue;
      const bytes = decodeBase64(url);
      if (!bytes) continue;
      const mime = /^data:([^;,]+)/.exec(url)?.[1] ?? "image/png";
      images.push({ format: mime.split("/").at(-1) ?? "png", source: { bytes } });
    }
  }
  return { text: text.join(""), images };
}
