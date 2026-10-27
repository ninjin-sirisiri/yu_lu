// Synthetic pixels, not user photographs. Encoders produce reproducible JPEG/PNG
// fixtures including valid checksums/compressed pixels for mutation tests.
import jpeg from 'npm:jpeg-js@0.4.4';
import { PNG } from 'npm:pngjs@7.0.0';
import { Buffer } from 'node:buffer';

export function png(width = 2, height = 1): Uint8Array {
  return new Uint8Array(
    PNG.sync.write({
      width,
      height,
      data: Buffer.alloc(width * height * 4, 127),
    }),
  );
}
export function jpg(width = 2, height = 1): Uint8Array {
  return new Uint8Array(
    jpeg.encode({
      width,
      height,
      data: new Uint8Array(width * height * 4).fill(127),
    }, 80).data,
  );
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }
  return bytes;
}
export function jpegMetadata(marker: number, content: string): Uint8Array {
  const text = new TextEncoder().encode(content);
  return concat(new Uint8Array([255, marker, 0, text.length + 2]), text);
}
export function pngChunk(type: string, content: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(content.length + 12);
  new DataView(bytes.buffer).setUint32(0, content.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(content, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, bytes.length - 4)) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  new DataView(bytes.buffer).setUint32(
    bytes.length - 4,
    (crc ^ 0xffffffff) >>> 0,
  );
  return bytes;
}
