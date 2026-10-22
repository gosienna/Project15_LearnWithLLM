import type { BoardImage, TopicRecord } from "../types.ts";
import type { BoardImageSources } from "../ui/whiteboard.ts";

export const IMAGE_MAX_SIDE = 1280;
export const IMAGE_QUALITY = 0.85;

export interface EncodedImage {
  blob: Blob;
  width?: number;
  height?: number;
}

/**
 * Shrink a downloaded image to IMAGE_MAX_SIDE on its longest side and re-encode it as webp, so the
 * board document stays small. Keeps the original when the browser cannot decode or encode it.
 */
export async function encodeBoardImage(blob: Blob): Promise<EncodedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return { blob };
  }
  try {
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return { blob, width: bitmap.width, height: bitmap.height };
    context.drawImage(bitmap, 0, 0, width, height);
    const encoded = await canvas.convertToBlob({ type: "image/webp", quality: IMAGE_QUALITY });
    // A browser without a webp encoder hands back png, which can be bigger than the original.
    if (encoded.type !== "image/webp" && encoded.size >= blob.size && scale === 1) return { blob, width, height };
    return { blob: encoded, width, height };
  } catch {
    return { blob, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(blob);
  });
}

/**
 * data: URLs of cached copies, so repainting the board does not re-read them. Keyed by topic, id
 * and size: every read from IndexedDB hands back a new Blob for the same picture.
 */
const dataUrls = new Map<string, Promise<string>>();
const DATA_URL_MEMO = 60;

function dataUrlOf(topicId: string, image: BoardImage & { blob: Blob }): Promise<string> {
  const key = `${topicId}\0${image.id}\0${image.addedAt}\0${image.blob.size}`;
  let url = dataUrls.get(key);
  if (!url) {
    url = blobToDataUrl(image.blob);
    dataUrls.set(key, url);
    if (dataUrls.size > DATA_URL_MEMO) dataUrls.delete(dataUrls.keys().next().value!);
  }
  return url;
}

/** What each of the topic's images shows as on the board: the cached copy, or the original url. */
export async function boardImageSources(topicId: string, images: readonly BoardImage[] | undefined): Promise<BoardImageSources> {
  const out: BoardImageSources = {};
  for (const image of images ?? []) {
    out[image.id] = image.blob ? await dataUrlOf(topicId, image as BoardImage & { blob: Blob }).catch(() => image.url) : image.url;
  }
  return out;
}

export function topicImages(topic: TopicRecord): BoardImage[] {
  return topic.images ?? [];
}
