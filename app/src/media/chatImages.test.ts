import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { openAppDatabase, type AppStorage } from '../storage/database';
import { readChatDraft, saveChatDraft } from '../storage/chat';
import { createImageStore, type FileSystemPort, type ImageStore } from '../storage/files';
import { createNodeFileSystemPort, NodeSqliteDriver } from '../storage/testSupport/nodePorts';
import { applyChatImageSelection, fitChatImage, prepareChatImage, removeChatDraftImage,
  type ChatImageOps, type PickedChatImage } from './chatImages';
import { stripChatImageMetadata } from './chatImageBytes';
import { PROBE_EXIF_JPEG_BASE64 } from './avatarProbeFixtures';

const MAX = 10 * 1024 * 1024;
const crc = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of bytes) { c ^= byte; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Uint8Array) {
  const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(type, 4);
  b.set(data, 8); b.writeUInt32BE(crc(b.subarray(4, -4)), b.length - 4); return b;
}
function png(width = 2, height = 1) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels[y * (1 + width * 4) + 1 + x * 4] = 255; // red, fully transparent
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const jpg = () => Buffer.from(PROBE_EXIF_JPEG_BASE64, 'base64');
let root: string, db: AppStorage, disk: FileSystemPort, images: ImageStore, counter: number;
let ops: ChatImageOps;
function source(bytes = png(), name = 'source.png'): PickedChatImage {
  const uri = path.join(root, name); fs.writeFileSync(uri, bytes); return { uri, fileName: name };
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-images-'));
  disk = createNodeFileSystemPort(path.join(root, 'documents'));
  db = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(root, 'app.db')) });
  counter = 0; images = createImageStore({ fs: disk, newId: () => `image-${++counter}` });
  // Only native decoding/encoding is substituted. SQL, bytes inspection,
  // metadata stripping, staging, persistent files and composer writes are real.
  ops = {
    decode: async uri => ({ uri, width: 2, height: 1 }),
    encode: async (_image, size, format) => {
      const uri = path.join(root, `encoded-${++counter}.${format}`);
      fs.writeFileSync(uri, format === 'png' ? png(size.width, size.height) : jpg());
      return { uri, ...size };
    },
  };
});
afterEach(async () => { await db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const deps = () => ({ fs: disk, store: images, ops });

it.each([[4000,3000,2048,1536], [3000,4000,1536,2048], [2,1,2,1], [1,9999,1,2048]])(
  'fits %i x %i without cropping/upscaling', (w,h,width,height) => {
    expect(fitChatImage(w,h)).toEqual({ width,height });
  });
it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid geometry %s', width => {
  expect(() => fitChatImage(width, 1)).toThrow();
});
it('preserves PNG transparency and strips every non-rendering chunk from actual encoded bytes', async () => {
  const picked = source();
  const original = png();
  ops.encode = async () => {
    const uri = path.join(root, 'encoded.png');
    fs.writeFileSync(uri, Buffer.concat([original.subarray(0,33),
      chunk('eXIf', Buffer.from('GPS')), chunk('iCCP', Buffer.from('camera')),
      chunk('tEXt', Buffer.from('location')), chunk('sRGB', Buffer.from([0])), original.subarray(33)]));
    return { uri, width: 2, height: 1 };
  };
  const prepared = await prepareChatImage('alice', picked, deps());
  const actual = fs.readFileSync(images.resolvePath(prepared.reference));
  expect(actual).toEqual(original);
  const raw = inflateSync(actual.subarray(41, actual.length - 16));
  expect([raw[4], raw[8]]).toEqual([0,0]);
  expect(fs.existsSync(picked.uri)).toBe(true); // never delete library sources
});
it('orients before geometry, uses JPEG .8 for HEIC and JPEG, and validates byte dimensions', async () => {
  for (const picked of [source(jpg(), 'source.jpg'), source(Buffer.from([0,0,0,24,102,116,121,112,104,101,105,99,0,0,0,0,104,101,105,99,109,105,102,49]), 'source.heic')]) {
    let decoded = false;
    ops.decode = async uri => { decoded = true; return { uri, width: 240, height: 320 }; };
    ops.encode = async (_image, size, format, quality) => {
      expect(decoded).toBe(true); expect(size).toEqual({ width:240,height:320 });
      expect(format).toBe('jpeg'); expect(quality).toBe(0.8);
      // Fixture has EXIF orientation 6. Native substitute emits oriented SOF.
      const bytes = jpg(); const sof = bytes.indexOf(Buffer.from([255,192]));
      bytes.writeUInt16BE(320, sof + 5); bytes.writeUInt16BE(240, sof + 7);
      const uri = path.join(root, 'oriented.jpg'); fs.writeFileSync(uri, bytes);
      return { uri, ...size };
    };
    const result = await prepareChatImage('alice', picked, deps());
    const bytes = fs.readFileSync(images.resolvePath(result.reference));
    expect(bytes.includes(Buffer.from('Exif'))).toBe(false);
    expect(bytes.includes(Buffer.from('Photoshop'))).toBe(false);
    expect(result).toMatchObject({ width:240, height:320, mimeType:'image/jpeg' });
  }
});
it.each(['gif','webp','avif','txt'])('rejects unsupported %s even when renamed PNG', async ext => {
  await expect(prepareChatImage('alice', source(Buffer.from(`fake ${ext}`)), deps())).rejects.toThrow();
});
it('rejects actual or reported oversized sources before native decode; accepts inclusive 10MiB', async () => {
  let calls = 0; ops.decode = async uri => { calls++; return { uri, width:2,height:1 }; };
  const picked = source();
  fs.truncateSync(picked.uri, MAX + 1);
  await expect(prepareChatImage('alice', { ...picked, fileSize:1 }, deps())).rejects.toThrow();
  expect(calls).toBe(0);
  fs.truncateSync(picked.uri, MAX);
  await expect(prepareChatImage('alice', { ...picked, fileSize:MAX + 1 }, deps())).rejects.toThrow();
  await expect(prepareChatImage('alice', picked, deps())).resolves.toMatchObject({ width:2 });
});
it.each(['size','dimensions','mismatch','truncated','format','crc'])('rejects invalid generated output: %s', async issue => {
  ops.encode = async () => {
    let bytes = png();
    if (issue === 'size') bytes = Buffer.alloc(MAX + 1);
    if (issue === 'dimensions') bytes = png(2049, 1);
    if (issue === 'mismatch') bytes = png(3, 1);
    if (issue === 'truncated') bytes = bytes.subarray(0,-1);
    if (issue === 'format') bytes = jpg();
    if (issue === 'crc') bytes[40] ^= 1;
    const uri = path.join(root,'bad.png'); fs.writeFileSync(uri,bytes); return { uri,width:2,height:1 };
  };
  await expect(prepareChatImage('alice', source(), deps())).rejects.toThrow();
});
it('accepts an exactly 10MiB encoded JPEG before scrubbing and persists only clean bytes', async () => {
  const original = jpg();
  const chunks:Buffer[] = [original.subarray(0,2)];
  let remaining = MAX - original.length;
  while (remaining) {
    const size = Math.min(remaining,65537);
    // Avoid a tail shorter than the four-byte COM marker/length header.
    const length = remaining - size > 0 && remaining - size < 4 ? size - 4 : size;
    const segment = Buffer.alloc(length); segment[0] = 255; segment[1] = 254;
    segment.writeUInt16BE(length - 2,2); chunks.push(segment); remaining -= length;
  }
  chunks.push(original.subarray(2));
  ops.decode = async uri => ({ uri,width:320,height:240 });
  ops.encode = async () => {
    const uri = path.join(root,'full.jpg'); fs.writeFileSync(uri,Buffer.concat(chunks));
    return { uri,width:320,height:240 };
  };
  const result = await prepareChatImage('alice',source(original,'source.jpg'),deps());
  expect(result.reference.bytes).toBeLessThan(original.length);
});
it('uses oriented decoded dimensions for the 2048px long-edge pipeline cap', async () => {
  ops.decode = async uri => ({ uri,width:3000,height:4000 });
  const result = await prepareChatImage('alice',source(),deps());
  expect(result).toMatchObject({ width:1536,height:2048 });
});
it('partial scrubbed writes fail before a reference is published', async () => {
  const write = disk.writeBytes;
  disk.writeBytes = (uri,bytes) => write(uri,bytes.subarray(0,-1));
  expect((await applyChatImageSelection(db,'alice','bob',[source()],deps())).status).toBe('failed');
  expect(await readChatDraft(db,'alice','bob')).toBeNull();
});
it('two competing selections cannot exceed four attachments or overwrite each other', async () => {
  const picked = source();
  const results = await Promise.all([
    applyChatImageSelection(db,'alice','bob',[picked,picked,picked],deps()),
    applyChatImageSelection(db,'alice','bob',[picked,picked,picked],deps()),
  ]);
  expect(results.map(r => r.status).sort()).toEqual(['committed','failed']);
  expect((await readChatDraft(db,'alice','bob'))?.attachments).toHaveLength(3);
});
it('strips JPEG metadata between scans, preserves entropy and rejects trailing/truncated bytes', () => {
  const original = stripChatImageMetadata(jpg(), 'jpeg');
  const end = original.bytes.length - 2;
  const comment = Buffer.from([255,254,0,5,71,80,83]);
  const withComment = Buffer.concat([original.bytes.subarray(0,end),comment,original.bytes.subarray(end)]);
  expect(stripChatImageMetadata(withComment, 'jpeg').bytes).toEqual(original.bytes);
  expect(() => stripChatImageMetadata(Buffer.concat([jpg(),Buffer.from([1])]),'jpeg')).toThrow();
  expect(() => stripChatImageMetadata(jpg().subarray(0,-2),'jpeg')).toThrow();
});
it('appends at most four and keeps body/references across cancellation and reopen', async () => {
  await saveChatDraft(db, { accountId:'alice',peerId:'bob',body:'keep\n本文',attachments:[],updatedAt:1 });
  const picked = source();
  expect((await applyChatImageSelection(db,'alice','bob',null,deps())).status).toBe('canceled');
  expect((await readChatDraft(db,'alice','bob'))?.updatedAt).toBe(1);
  expect((await applyChatImageSelection(db,'alice','bob',Array(4).fill(picked),deps())).status).toBe('committed');
  const old = await readChatDraft(db,'alice','bob');
  expect(old?.attachments).toHaveLength(4); expect(old?.body).toBe('keep\n本文');
  expect((await applyChatImageSelection(db,'alice','bob',[picked],deps())).status).toBe('failed');
  expect(await readChatDraft(db,'alice','bob')).toEqual(old);
  await db.close(); db = await openAppDatabase({ driver:new NodeSqliteDriver(path.join(root,'app.db')) });
  expect(await readChatDraft(db,'alice','bob')).toEqual(old);
  await removeChatDraftImage(db,'alice','bob',old!.attachments[1].imageId);
  expect((await readChatDraft(db,'alice','bob'))?.attachments).toHaveLength(3);
  expect(fs.existsSync(images.resolvePath(old!.attachments[1]))).toBe(true); // may be outbox-owned
});
it.each(['decode','encode','write','copy','move','sql'])('a %s failure preserves the previous whole draft', async stage => {
  const picked = source();
  await applyChatImageSelection(db,'alice','bob',[picked],deps());
  const previous = await readChatDraft(db,'alice','bob');
  if (stage === 'decode' || stage === 'encode') ops[stage] = async () => { throw new Error('native failed'); };
  if (stage === 'write') disk.writeBytes = () => { throw new Error('disk full'); };
  if (stage === 'copy') disk.copyFile = async () => { throw new Error('disk full'); };
  if (stage === 'move') disk.moveFile = async () => { throw new Error('disk full'); };
  if (stage === 'sql') await db.execAsync("CREATE TRIGGER fail_draft BEFORE UPDATE ON chat_drafts BEGIN SELECT RAISE(ABORT,'disk full'); END;");
  expect((await applyChatImageSelection(db,'alice','bob',[picked],deps())).status).toBe('failed');
  expect(await readChatDraft(db,'alice','bob')).toEqual(previous);
  expect(fs.existsSync(images.resolvePath(previous!.attachments[0]))).toBe(true);
});
it('keeps edits made while processing and revokes a stale scope before committing', async () => {
  ops.decode = async uri => {
    await saveChatDraft(db,{ accountId:'alice',peerId:'bob',body:'new text',attachments:[],updatedAt:3 });
    return { uri,width:2,height:1 };
  };
  await applyChatImageSelection(db,'alice','bob',[source()],deps());
  expect((await readChatDraft(db,'alice','bob'))?.body).toBe('new text');
  const old = await readChatDraft(db,'alice','bob');
  expect((await applyChatImageSelection(db,'alice','bob',[source()],{ ...deps(),isCurrent:() => false })).status).toBe('failed');
  expect(await readChatDraft(db,'alice','bob')).toEqual(old);
});
