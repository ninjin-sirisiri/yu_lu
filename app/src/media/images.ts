export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function validImageCount(count: number): boolean {
  return count >= 0 && count <= MAX_IMAGES;
}

export function validImageSize(bytes: number): boolean {
  return bytes > 0 && bytes <= MAX_IMAGE_BYTES;
}
