/** Pure byte-level privacy boundary. No native/Node dependencies: the same
 * generated output is tested against the server's strict pixel decoders.
 * Native encoders own pixels; this whitelist owns metadata, not saveAsync(). */
export type ChatImageFormat = 'jpeg' | 'png';
const MAX_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
function invalid(): never { throw new Error('invalid encoded chat image'); }
function u16(b: Uint8Array, p: number) { return b[p] * 256 + b[p + 1]; }
function u32(b: Uint8Array, p: number) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(p);
}
function text(b: Uint8Array) { return String.fromCharCode(...b); }
function dimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048) invalid();
}
function concat(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function stripPng(b: Uint8Array) {
  if (b.length < 45 || !PNG_SIGNATURE.every((v, i) => b[i] === v)) invalid();
  const parts = [b.subarray(0, 8)];
  let p = 8, width = 0, height = 0, color = 0, depth = 0, palette = 0;
  let idat = false, idatEnded = false, transparency = false, ended = false;
  while (p < b.length) {
    if (p + 12 > b.length || ended) invalid();
    const length = u32(b, p), type = text(b.subarray(p + 4, p + 8));
    if (length > b.length - p - 12 || !/^[A-Za-z]{4}$/.test(type) ||
        crc32(b.subarray(p + 4, p + 8 + length)) !== u32(b, p + 8 + length)) invalid();
    let keep = true;
    if (p === 8) {
      if (type !== 'IHDR' || length !== 13) invalid();
      width = u32(b, p + 8); height = u32(b, p + 12); dimensions(width, height);
      depth = b[p + 16]; color = b[p + 17];
      const depths: Record<number, number[]> = { 0:[1,2,4,8,16], 2:[8,16], 3:[1,2,4,8], 4:[8,16], 6:[8,16] };
      if (!depths[color]?.includes(depth) || b[p + 18] !== 0 || b[p + 19] !== 0 || b[p + 20] > 1) invalid();
    } else if (type === 'PLTE') {
      if (palette || idat || transparency || length < 3 || length > 768 || length % 3 ||
          color === 0 || color === 4 || color === 3 && length / 3 > 2 ** depth) invalid();
      palette = length / 3;
    } else if (type === 'tRNS') {
      if (transparency || idat || !(color === 0 && length === 2 || color === 2 && length === 6 ||
          color === 3 && palette && length > 0 && length <= palette)) invalid();
      transparency = true;
    } else if (type === 'IDAT') {
      if (idatEnded || color === 3 && !palette) invalid();
      idat = true;
    } else if (type === 'IEND') {
      if (!idat || length !== 0 || p + 12 !== b.length) invalid();
      ended = true;
    } else {
      // Unknown critical chunks cannot safely be removed. Animation cannot
      // masquerade as a static output. All other ancillary data is removed,
      // including EXIF, XMP/text, ICC, color profiles and timestamps.
      if (type[0] === type[0].toUpperCase() || ['acTL','fcTL','fdAT'].includes(type)) invalid();
      keep = false;
    }
    if (idat && type !== 'IDAT') idatEnded = true;
    if (keep) parts.push(b.subarray(p, p + length + 12));
    p += length + 12;
  }
  if (!ended) invalid();
  return { bytes: concat(parts), width, height };
}

function stripJpeg(b: Uint8Array) {
  if (b[0] !== 255 || b[1] !== 216) invalid();
  const parts = [b.subarray(0, 2)];
  let p = 2, width = 0, height = 0, scans = 0, frame = false;
  while (p < b.length) {
    const start = p;
    if (b[p++] !== 255) invalid();
    while (b[p] === 255) p++;
    const marker = b[p++];
    if (marker === 217) {
      if (!frame || !scans || p !== b.length) invalid();
      parts.push(b.subarray(start, p));
      return { bytes: concat(parts), width, height };
    }
    if (p + 2 > b.length) invalid();
    const length = u16(b, p);
    if (length < 2 || p + length > b.length) invalid();
    const data = b.subarray(p + 2, p + length);
    let keep = true;
    if (marker >= 224 && marker <= 239 || marker === 254) {
      // Drop ALL APP and COM, including JFIF/JFXX thumbnails and EXIF
      // orientation (already normalized into pixels). Only Adobe's fixed
      // rendering transform is retained; arbitrary APP14 payloads are not.
      keep = marker === 238 && data.length === 12 && text(data.subarray(0,5)) === 'Adobe';
    } else if ([192,193,194].includes(marker)) {
      if (frame || data.length < 6 || data[0] !== 8 || data.length !== 6 + data[5] * 3) invalid();
      height = u16(data,1); width = u16(data,3); dimensions(width,height); frame = true;
    } else if (![196,219,221,218].includes(marker)) invalid();
    p += length;
    if (marker === 218) {
      if (!frame) invalid();
      scans++;
      while (p < b.length) {
        if (b[p] !== 255) { p++; continue; }
        let next = p + 1;
        while (b[next] === 255) next++;
        if (b[next] === 0 || b[next] >= 208 && b[next] <= 215) p = next + 1;
        else break;
      }
    }
    if (keep) parts.push(b.subarray(start,p));
  }
  invalid();
}

/** Checks framing, CRC, actual dimensions and exact EOF while removing all
 * non-rendering segments. Pixel validity is still checked by the native
 * decoder and, independently, the authenticated server before acceptance. */
export function stripChatImageMetadata(bytes: Uint8Array, format: ChatImageFormat) {
  if (!bytes.length || bytes.length > MAX_BYTES) invalid();
  return format === 'png' ? stripPng(bytes) : stripJpeg(bytes);
}
