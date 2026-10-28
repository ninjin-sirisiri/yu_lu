// Task13: the shipped client scrubber must emit bytes the existing strict
// authenticated-media validator can decode. No HTTP stack or fake business flow.
import { stripChatImageMetadata } from '../../../app/src/media/chatImageBytes.ts';
import { validateChatImage } from '../_shared/chat-media.ts';
import { concat, jpegMetadata, jpg, png, pngChunk } from './fixtures/chat-images.ts';
import { PNG } from 'npm:pngjs@7.0.0';
import { Buffer } from 'node:buffer';

function assert(value:unknown):asserts value { if (!value) throw new Error('assertion failed'); }
Deno.test('client-scrubbed JPEG/PNG pass server framing and real pixel decoders', async () => {
  const jpeg = jpg();
  const dirtyJpeg = concat(jpeg.subarray(0,2),jpegMetadata(0xe1,'Exif\0\0GPS'),jpegMetadata(0xe2,'ICC_PROFILE'),
    jpegMetadata(0xfe,'camera'),jpegMetadata(0xe0,'JFXX\0thumbnail'),jpeg.subarray(2));
  const image = png();
  const dirtyPng = concat(image.subarray(0,33),pngChunk('eXIf',new TextEncoder().encode('GPS')),
    pngChunk('iCCP',new TextEncoder().encode('camera')),pngChunk('tEXt',new TextEncoder().encode('location')),
    pngChunk('sRGB',new Uint8Array([0])),image.subarray(33));
  for (const [dirty,format] of [[dirtyJpeg,'jpeg'],[dirtyPng,'png']] as const) {
    const result = stripChatImageMetadata(dirty,format);
    const validated = await validateChatImage(result.bytes);
    assert(validated.width === 2 && validated.height === 1);
    assert(validated.mime_type === `image/${format}`);
    assert(validated.byte_size === result.bytes.length);
  }
  const pixels = PNG.sync.read(Buffer.from(stripChatImageMetadata(dirtyPng,'png').bytes));
  assert(pixels.data[3] === 127 && pixels.data[7] === 127);
});
Deno.test('client removes metadata after JPEG scans and retains the 2048px PNG boundary', async () => {
  const clean = stripChatImageMetadata(jpg(),'jpeg');
  const end = clean.bytes.length - 2;
  const between = concat(clean.bytes.subarray(0,end),jpegMetadata(0xe1,'XMP GPS'),clean.bytes.subarray(end));
  const output = stripChatImageMetadata(between,'jpeg');
  assert((await validateChatImage(output.bytes)).width === 2);
  assert(output.bytes.every((v,i) => v === clean.bytes[i]));
  assert((await validateChatImage(stripChatImageMetadata(png(2048,1),'png').bytes)).width === 2048);
});
