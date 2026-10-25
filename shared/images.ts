import type { ImageAttachment } from "./types.js";

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Four base64-encoded 5 MiB images, plus text and JSON overhead.
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export function isImageAttachment(value: unknown): value is ImageAttachment {
  if (!value || typeof value !== "object") return false;
  const image = value as Record<string, unknown>;
  if (!IMAGE_MIME_TYPES.includes(image.mimeType as ImageAttachment["mimeType"])) return false;
  if (image.name !== undefined && (typeof image.name !== "string" || image.name.length > 256)) return false;
  if (typeof image.data !== "string" || !image.data.length || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return false;
  if (image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return false;
  const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
  return image.data.length / 4 * 3 - padding <= MAX_IMAGE_BYTES;
}

export function imageSource(image: ImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`;
}
