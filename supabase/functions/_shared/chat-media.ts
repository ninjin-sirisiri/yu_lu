// Only the authenticated HTTP boundary may turn staging bytes into validation
// records. Never register this operation in the authenticated SQL dispatcher.
import jpeg from 'npm:jpeg-js@0.4.4';
import { PNG } from 'npm:pngjs@7.0.0';
import { Buffer } from 'node:buffer';
import {
  Z_FINISH,
  Z_OK,
  Z_STREAM_END,
  zlibInflate,
  zlibInflateEnd,
  zlibInflateInit2,
  ZStream,
} from 'npm:pako@3.0.3';
import { jsonError } from './auth.ts';
import { mapRpcError, type RpcOutcome, UUID_RE } from './commands.ts';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 2048;
export interface ValidatedImage {
  sha256: string;
  mime_type: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  byte_size: number;
}
export interface MediaRecord extends ValidatedImage {
  image_order: number;
  final_path: string;
}
export interface MediaBackend {
  downloadStaging(path: string): Promise<Uint8Array>;
  putFinal(path: string, bytes: Uint8Array, mime: string): Promise<void>;
  record(
    actor: string,
    clientKey: string,
    items: MediaRecord[],
  ): Promise<RpcOutcome>;
}
class InvalidImage extends Error {}
function invalid(): never {
  throw new InvalidImage('invalid chat image');
}
function dimensions(width: number, height: number) {
  if (
    width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION
  ) invalid();
}
function u16(b: Uint8Array, offset: number) {
  return b[offset] * 256 + b[offset + 1];
}
function u32(b: Uint8Array, offset: number) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(offset);
}
function text(b: Uint8Array) {
  return new TextDecoder().decode(b);
}

// Whitelist rendering chunks, not a blacklist of known GPS tags. Unknown chunks,
// text, EXIF, profiles, timestamps and animation are rejected. CRC and compressed
// pixel/filter validation are performed by the decoder after the bounded header.
function inspectPng(b: Uint8Array): [number, number] {
  if (
    b.length < 45 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v)
  ) invalid();
  let offset = 8;
  let width = 0;
  let height = 0;
  let ended = false;
  let idat = false;
  let idatEnded = false;
  let palette = false;
  let transparency = false;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  let paletteEntries = 0;
  const compressed: Uint8Array[] = [];
  while (offset < b.length) {
    if (offset + 12 > b.length) invalid();
    const length = u32(b, offset);
    const type = text(b.subarray(offset + 4, offset + 8));
    if (length > b.length - offset - 12) invalid();
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) invalid();
      width = u32(b, offset + 8);
      height = u32(b, offset + 12);
      dimensions(width, height);
      depth = b[offset + 16];
      color = b[offset + 17];
      interlace = b[offset + 20];
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !depths[color]?.includes(depth) || b[offset + 18] !== 0 ||
        b[offset + 19] !== 0 || interlace > 1
      ) invalid();
    } else if (type === 'PLTE') {
      if (
        palette || idat || transparency || length < 3 || length > 768 ||
        length % 3 !== 0
      ) invalid();
      if (
        color === 0 || color === 4 || color === 3 && length / 3 > 2 ** depth
      ) invalid();
      paletteEntries = length / 3;
      palette = true;
    } else if (type === 'tRNS') {
      if (transparency || idat) invalid();
      if (
        !(color === 0 && length === 2 || color === 2 && length === 6 ||
          color === 3 && palette && length > 0 && length <= paletteEntries)
      ) invalid();
      transparency = true;
    } else if (type === 'IDAT') {
      if (idatEnded) invalid();
      if (color === 3 && !palette) invalid();
      idat = true;
      compressed.push(b.subarray(offset + 8, offset + 8 + length));
    } else if (type === 'IEND') {
      if (!idat || length !== 0 || offset + 12 !== b.length) invalid();
      ended = true;
    } else invalid();
    if (idat && type !== 'IDAT') idatEnded = true;
    offset += length + 12;
  }
  if (!ended) invalid();
  // Preflight the exact decompressed scanline budget, including Adam7 passes.
  // pngjs alone truncates excess data and its interlaced inflate is unbounded.
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [
      1,
      0,
      2,
      2,
    ], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  let expected = 0;
  for (const [x, y, dx, dy] of passes) {
    const cols = Math.max(0, Math.ceil((width - x) / dx));
    const rows = Math.max(0, Math.ceil((height - y) / dy));
    if (cols && rows) {
      expected += rows * (1 + Math.ceil(cols * channels[color] * depth / 8));
    }
  }
  const input = Buffer.concat(compressed);
  // Edge Runtime's node:zlib ignores info:true. Use the pinned portable zlib
  // engine with a fixed output buffer: even a bomb can emit at most expected+1
  // bytes. Require one complete zlib member (including Adler32), exact scanline
  // length, and full input consumption; never accept gzip/raw or trailing data.
  const stream = new ZStream();
  if (zlibInflateInit2(stream, 15) !== Z_OK) invalid();
  try {
    stream.input = input;
    stream.avail_in = input.length;
    stream.output = new Uint8Array(expected + 1);
    stream.avail_out = stream.output.length;
    if (
      zlibInflate(stream, Z_FINISH) !== Z_STREAM_END ||
      stream.next_out !== expected || stream.avail_in !== 0
    ) invalid();
  } finally {
    zlibInflateEnd(stream);
  }
  return [width, height];
}

// Walk all segments, including between progressive scans. Only the fixed JFIF
// header (no thumbnail) and Adobe color-transform marker may remain as APP data.
// No EXIF orientation is accepted: orientation must already be applied to pixels.
function inspectJpeg(b: Uint8Array): [number, number] {
  if (b[0] !== 255 || b[1] !== 216) invalid();
  let offset = 2;
  let width = 0;
  let height = 0;
  let scans = 0;
  let frame = false;
  while (offset < b.length) {
    if (b[offset++] !== 255) invalid();
    while (b[offset] === 255) offset++;
    const marker = b[offset++];
    if (marker === 217) {
      if (!frame || scans === 0 || offset !== b.length) invalid();
      return [width, height];
    }
    if (offset + 2 > b.length) invalid();
    const length = u16(b, offset);
    if (length < 2 || offset + length > b.length) invalid();
    const data = b.subarray(offset + 2, offset + length);
    if (marker === 224) {
      if (
        data.length !== 14 || text(data.subarray(0, 5)) !== 'JFIF\0' ||
        data[12] !== 0 || data[13] !== 0
      ) invalid();
    } else if (marker === 238) {
      if (data.length !== 12 || text(data.subarray(0, 5)) !== 'Adobe') {
        invalid();
      }
    } else if (marker >= 224 && marker <= 239 || marker === 254) invalid();
    else if ([192, 193, 194].includes(marker)) {
      if (
        frame || data.length < 6 || data[0] !== 8 ||
        data.length !== 6 + data[5] * 3
      ) invalid();
      height = u16(data, 1);
      width = u16(data, 3);
      dimensions(width, height);
      frame = true;
    } else if (![196, 219, 221, 218].includes(marker)) invalid();
    offset += length;
    if (marker === 218) {
      if (!frame) invalid();
      scans++;
      // Entropy data: stuffed FF00 and restart markers are not segment headers.
      while (offset < b.length) {
        if (b[offset] !== 255) {
          offset++;
          continue;
        }
        let next = offset + 1;
        while (b[next] === 255) next++;
        if (b[next] === 0 || b[next] >= 208 && b[next] <= 215) {
          offset = next + 1;
          continue;
        }
        break;
      }
    }
  }
  invalid();
}

/** Validates actual file structure AND decodes pixels; client MIME is never used. */
export async function validateChatImage(
  bytes: Uint8Array,
): Promise<ValidatedImage> {
  if (bytes.length < 1 || bytes.length > MAX_BYTES) invalid();
  let width: number;
  let height: number;
  let mime: ValidatedImage['mime_type'];
  try {
    if (bytes[0] === 137) {
      [width, height] = inspectPng(bytes);
      mime = 'image/png';
      const decoded = PNG.sync.read(Buffer.from(bytes), { checkCRC: true });
      if (
        decoded.width !== width || decoded.height !== height ||
        decoded.data.length !== width * height * 4
      ) invalid();
    } else {
      [width, height] = inspectJpeg(bytes);
      mime = 'image/jpeg';
      const decoded = jpeg.decode(bytes, {
        useTArray: true,
        tolerantDecoding: false,
        maxResolutionInMP: 4.2,
        maxMemoryUsageInMB: 96,
      });
      if (
        decoded.width !== width || decoded.height !== height ||
        decoded.data.length !== width * height * 4
      ) invalid();
    }
  } catch {
    invalid();
  }
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
  );
  return {
    width,
    height,
    mime_type: mime,
    byte_size: bytes.length,
    sha256: Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join(''),
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function prepareChatMedia(
  actor: string,
  payload: Record<string, unknown>,
  backend?: MediaBackend,
): Promise<Response> {
  const key = payload.client_key;
  const images = payload.images;
  if (
    !UUID_RE.test(actor) || typeof key !== 'string' || !UUID_RE.test(key) ||
    Object.keys(payload).some((k) => !['client_key', 'images'].includes(k)) ||
    !Array.isArray(images) || images.length < 1 || images.length > 4
  ) return jsonError(400, 'invalid media payload');
  const paths: string[] = [];
  for (let index = 0; index < images.length; index++) {
    const image: unknown = images[index];
    if (
      !object(image) || Object.keys(image).length !== 1 ||
      typeof image.staging_path !== 'string' ||
      !['png', 'jpg', 'jpeg'].some((ext) =>
        image.staging_path === `${actor}/${key}/${index}.${ext}`
      )
    ) {
      return jsonError(400, 'invalid staging path');
    }
    paths.push(image.staging_path);
  }
  try {
    const io = backend ?? defaultMediaBackend();
    const validated: Array<{ bytes: Uint8Array; item: MediaRecord }> = [];
    // Sequential/bounded decoding avoids four simultaneous 2048px pixel buffers.
    for (let index = 0; index < paths.length; index++) {
      const bytes = await io.downloadStaging(paths[index]);
      const info = await validateChatImage(bytes);
      if ((info.mime_type === 'image/png') !== paths[index].endsWith('.png')) {
        invalid();
      }
      const ext = info.mime_type === 'image/png' ? 'png' : 'jpg';
      validated.push({
        bytes,
        item: {
          ...info,
          image_order: index,
          final_path: `${actor}/${key}/${index}/${info.sha256}.${ext}`,
        },
      });
    }
    for (const { bytes, item } of validated) {
      await io.putFinal(item.final_path, bytes, item.mime_type);
    }
    const outcome = await io.record(actor, key, validated.map((v) => v.item));
    if (!outcome.ok) {
      const status = mapRpcError(outcome.code).status;
      return jsonError(
        status,
        status === 409
          ? 'media preparation conflict'
          : 'media preparation failed',
      );
    }
    return new Response(JSON.stringify({ result: outcome.data }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    return error instanceof InvalidImage
      ? jsonError(400, 'invalid chat image')
      : jsonError(500, 'media preparation failed');
  }
}

// Bounds actual streamed bytes even when Content-Length is absent or dishonest.
async function readBounded(res: Response): Promise<Uint8Array> {
  if (!res.ok || !res.body) throw new Error('storage read failed');
  if (Number(res.headers.get('content-length')) > MAX_BYTES) {
    await res.body.cancel();
    invalid();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BYTES) {
        await reader.cancel();
        invalid();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Service key stays exclusively in server headers; never in response/error/logs. */
export function createMediaBackend(
  url: string,
  serviceKey: string,
  send: typeof fetch = fetch,
): MediaBackend {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const objectUrl = (bucket: string, path: string) =>
    `${url}/storage/v1/object/${bucket}/${
      path.split('/').map(encodeURIComponent).join('/')
    }`;
  return {
    downloadStaging: async (path) =>
      readBounded(await send(objectUrl('chat-staging', path), { headers })),
    putFinal: async (path, bytes, mime) => {
      const res = await send(objectUrl('chat-images', path), {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': mime,
          'x-upsert': 'false',
          'cache-control': 'private, no-store',
        },
        body: new Uint8Array(bytes),
      });
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
      // Storage may answer 400 with statusCode=409 for an existing object.
      let error: unknown;
      try {
        error = await res.json();
      } catch {
        error = null;
      }
      if (
        res.status !== 409 &&
        !(object(error) && String(error.statusCode) === '409')
      ) throw new Error('storage write failed');
      const existing = await readBounded(
        await send(objectUrl('chat-images', path), { headers }),
      );
      if (
        existing.length !== bytes.length ||
        !existing.every((b, i) => b === bytes[i])
      ) throw new Error('immutable object conflict');
    },
    record: async (actor, key, items) => {
      const res = await send(`${url}/rest/v1/rpc/record_chat_media`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          p_actor: actor,
          p_client_key: key,
          p_items: items,
        }),
      });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (res.ok && object(body)) return { ok: true, data: body };
      return {
        ok: false,
        code: object(body) && typeof body.code === 'string' ? body.code : null,
        message: 'media preparation failed',
      };
    },
  };
}
function defaultMediaBackend(): MediaBackend {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('media endpoint not configured');
  return createMediaBackend(url, key);
}
