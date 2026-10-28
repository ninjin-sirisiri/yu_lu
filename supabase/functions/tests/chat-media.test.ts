// Real parsers and HTTP dispatch; only external Storage/RPC I/O is injected.
import {
  createMediaBackend,
  type MediaBackend,
  type MediaRecord,
  prepareChatMedia,
  validateChatImage,
} from '../_shared/chat-media.ts';
import { executeCommand } from '../_shared/commands.ts';
import { createCommandHandler } from '../app-command/command.ts';
import {
  concat,
  jpegMetadata,
  jpg,
  png,
  pngChunk,
} from './fixtures/chat-images.ts';
import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(bytes: Uint8Array) {
  let failed = false;
  try {
    await validateChatImage(bytes);
  } catch {
    failed = true;
  }
  assert(failed, 'invalid or privacy-bearing bytes must be rejected');
}
const actor = '65000000-0000-4000-8000-000000000001';
const client = '65000000-0000-4000-8000-000000000011';
const path = `${actor}/${client}/0.png`;
function payload(stagingPath = path) {
  return { client_key: client, images: [{ staging_path: stagingPath }] };
}
function request(value: unknown, token = true) {
  return new Request('http://localhost/app-command', {
    method: 'POST',
    headers: token ? { authorization: 'Bearer user-token' } : {},
    body: JSON.stringify({
      operation_id: client,
      kind: 'prepare_chat_media',
      payload: value,
    }),
  });
}
function backend(staging = png()) {
  const finals = new Map<string, Uint8Array>();
  let recorded: MediaRecord[] = [];
  const io: MediaBackend = {
    downloadStaging: async () => staging.slice(),
    putFinal: async (p, bytes) => {
      if (!finals.has(p)) finals.set(p, bytes.slice());
      else {assert(
          finals.get(p)!.every((b, i) => b === bytes[i]),
          'immutable bytes',
        );}
    },
    record: async (a, key, items) => {
      assert(
        a === actor && key === client,
        'record uses verified actor and client key',
      );
      recorded = items;
      return {
        ok: true,
        data: {
          media: items.map((item, i) => ({ ...item, media_id: `media-${i}` })),
        },
      };
    },
  };
  return {
    io,
    finals,
    get recorded() {
      return recorded;
    },
    setStaging(b: Uint8Array) {
      staging = b;
    },
  };
}

Deno.test('valid decoded JPEG and transparent PNG use actual sizes, dimensions and SHA-256', async () => {
  for (
    const [bytes, mime] of [[jpg(), 'image/jpeg'], [
      png(),
      'image/png',
    ]] as const
  ) {
    const result = await validateChatImage(bytes);
    assert(
      result.mime_type === mime && result.width === 2 && result.height === 1,
    );
    assert(result.byte_size === bytes.length);
    const hash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    );
    assert(
      result.sha256 ===
        Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join(''),
    );
  }
  assert((await validateChatImage(png(2048, 1))).width === 2048);
});
Deno.test('fake magic, HEIC, truncation, trailing data and corrupted compressed pixels fail closed', async () => {
  const image = png();
  const corrupt = image.slice();
  corrupt[45] ^= 0xff;
  for (
    const bad of [
      new Uint8Array(),
      new TextEncoder().encode('ftypheic'),
      new Uint8Array([255, 216, 255, 217]),
      image.slice(0, -4),
      jpg().slice(0, -2),
      concat(image, new Uint8Array([1])),
      concat(jpg(), new Uint8Array([1])),
      corrupt,
    ]
  ) await rejects(bad);
});
Deno.test('actual byte limit and width/height limits cannot be caller asserted', async () => {
  for (
    const bad of [
      new Uint8Array(10 * 1024 * 1024 + 1),
      png(2049, 1),
      png(1, 2049),
      jpg(2049, 1),
      jpg(1, 2049),
    ]
  ) await rejects(bad);
});
Deno.test('JPEG EXIF/GPS, XMP, comments, ICC and embedded thumbnails are rejected', async () => {
  const image = jpg();
  for (
    const segment of [
      jpegMetadata(0xe1, 'Exif\0\0GPS'),
      jpegMetadata(0xe1, 'XMP location'),
      jpegMetadata(0xe2, 'ICC_PROFILE'),
      jpegMetadata(0xfe, 'camera serial'),
      jpegMetadata(0xe0, 'JFXX\0thumbnail'),
    ]
  ) {
    await rejects(concat(image.subarray(0, 2), segment, image.subarray(2)));
  }
});
Deno.test('PNG metadata and APNG chunks are rejected even with correct CRCs', async () => {
  const image = png();
  for (
    const type of [
      'eXIf',
      'tEXt',
      'zTXt',
      'iTXt',
      'tIME',
      'iCCP',
      'acTL',
      'vpAg',
    ]
  ) {
    await rejects(
      concat(
        image.subarray(0, 33),
        pngChunk(type, new TextEncoder().encode('GPS camera')),
        image.subarray(33),
      ),
    );
  }
});
Deno.test('PNG forbidden transparency on RGBA is rejected rather than silently ignored', async () => {
  const image = png();
  // RGBA has its own alpha channel: a tRNS chunk is forbidden by PNG, even
  // though common decoders silently ignore it. Valid CRC must not excuse it.
  await rejects(
    concat(
      image.subarray(0, 33),
      pngChunk('tRNS', new Uint8Array([1])),
      image.subarray(33),
    ),
  );
});
Deno.test('PNG excess decompressed data is rejected rather than silently truncated', async () => {
  const image = png();
  const header = image.subarray(0, 33);
  const end = pngChunk('IEND', new Uint8Array());
  // 2x1 RGBA8 expects exactly nine filtered bytes, not a truncated/hidden tail.
  await rejects(
    concat(header, pngChunk('IDAT', deflateSync(new Uint8Array(100))), end),
  );
});
Deno.test('PNG trailing compressed data is rejected rather than silently ignored', async () => {
  const header = png().subarray(0, 33);
  const end = pngChunk('IEND', new Uint8Array());
  await rejects(
    concat(
      header,
      pngChunk(
        'IDAT',
        concat(deflateSync(new Uint8Array(9)), new Uint8Array([1, 2, 3])),
      ),
      end,
    ),
  );
});
Deno.test('PNG validates one complete zlib stream, its Adler checksum and exact bounded output', async () => {
  const header = png().subarray(0, 33);
  const end = pngChunk('IEND', new Uint8Array());
  const pixels = new Uint8Array(9); // 2x1 RGBA8: filter byte plus eight samples
  const compressed = deflateSync(pixels);
  const badChecksum = new Uint8Array(compressed);
  badChecksum[badChecksum.length - 1] ^= 1;
  for (const idat of [
    deflateSync(new Uint8Array(8)),
    deflateSync(new Uint8Array(10)),
    deflateSync(new Uint8Array(1024 * 1024)), // expansion bomb, not a bigger image
    concat(compressed, new Uint8Array([0])),
    concat(compressed, deflateSync(new Uint8Array())),
    compressed.subarray(0, -1),
    badChecksum,
    deflateRawSync(pixels),
    gzipSync(pixels),
  ]) await rejects(concat(header, pngChunk('IDAT', idat), end));
  // Separate IDAT chunks are one zlib stream, not individually inflated members.
  const split = concat(
    header,
    pngChunk('IDAT', compressed.subarray(0, 5)),
    pngChunk('IDAT', compressed.subarray(5)),
    end,
  );
  assert((await validateChatImage(split)).width === 2);
});
Deno.test('PNG Adam7 preflight counts each nonempty pass rather than ordinary rows', async () => {
  const ihdr = png().subarray(16, 29).slice();
  ihdr[12] = 1;
  const header = concat(png().subarray(0, 8), pngChunk('IHDR', ihdr));
  const end = pngChunk('IEND', new Uint8Array());
  // 2x1 RGBA8 has two nonempty Adam7 passes: (filter + one pixel) twice.
  const image = concat(
    header,
    pngChunk('IDAT', deflateSync(new Uint8Array(10))),
    end,
  );
  const result = await validateChatImage(image);
  assert(result.width === 2 && result.height === 1);
  for (const length of [9, 11]) {
    await rejects(
      concat(header, pngChunk('IDAT', deflateSync(new Uint8Array(length))), end),
    );
  }
});
Deno.test('PNG preflight does not replace CRC or decoded-pixel filter validation', async () => {
  const image = png();
  for (const crcByte of [29, image.length - 13, image.length - 1]) {
    const corrupt = image.slice();
    corrupt[crcByte] ^= 1; // intact zlib pixels, corrupt IHDR/IDAT/IEND checksum
    await rejects(corrupt);
  }
  const pixels = new Uint8Array(9);
  pixels[0] = 5; // only PNG filter types 0..4 are defined
  await rejects(
    concat(
      image.subarray(0, 33),
      pngChunk('IDAT', deflateSync(pixels)),
      pngChunk('IEND', new Uint8Array()),
    ),
  );
});
Deno.test('prepare refuses other owners, wrong client keys, wrong index, traversal, five images and spoofed extension', async () => {
  for (
    const value of [
      payload(path.replace(actor, client)),
      payload(path.replace(client, actor)),
      payload(path.replace('/0.png', '/1.png')),
      payload(`${actor}/${client}/../0.png`),
      { client_key: client, images: [] },
      { client_key: client, images: Array(5).fill({ staging_path: path }) },
      { ...payload(), actor_id: client },
      { ...payload(), server_now: '2020-01-01' },
      payload(path.replace('.png', '.jpg')),
    ]
  ) {
    const b = backend();
    const result = await prepareChatMedia(actor, value, b.io);
    assert(result.status === 400 || result.status === 403);
    assert(
      b.finals.size === 0 && b.recorded.length === 0,
      'rejection must not publish or record',
    );
  }
});
Deno.test('validated copies are hash addressed, retries reuse objects, and staging replacement cannot alter final bytes', async () => {
  const b = backend();
  const original = png();
  assert((await prepareChatMedia(actor, payload(), b.io)).status === 200);
  const first = b.recorded[0];
  assert(first.image_order === 0 && first.byte_size === original.length);
  assert(first.final_path === `${actor}/${client}/0/${first.sha256}.png`);
  assert((await prepareChatMedia(actor, payload(), b.io)).status === 200);
  assert(b.finals.size === 1, 'same validated object reused');
  b.setStaging(png(3, 1));
  assert(
    b.finals.get(first.final_path as string)!.every((byte, i) =>
      byte === original[i]
    ),
  );
});
Deno.test('batch validation completes before any final write; RPC and storage errors are generic', async () => {
  const b = backend();
  b.io.downloadStaging = async (p) =>
    p.endsWith('1.png') ? new Uint8Array([1]) : png();
  const res = await prepareChatMedia(actor, {
    client_key: client,
    images: [{ staging_path: path }, {
      staging_path: path.replace('0.png', '1.png'),
    }],
  }, b.io);
  assert(res.status === 400 && b.finals.size === 0);
  b.io.downloadStaging = async () => {
    throw new Error('secret storage details');
  };
  const failure = await prepareChatMedia(actor, payload(), b.io);
  assert(failure.status === 500 && !(await failure.text()).includes('secret'));
});
Deno.test('four images retain order and a failed copy never creates validation records', async () => {
  const b = backend();
  const value = {
    client_key: client,
    images: Array.from({ length: 4 }, (_, i) => ({
      staging_path: `${actor}/${client}/${i}.png`,
    })),
  };
  const response = await prepareChatMedia(actor, value, b.io);
  assert(
    response.status === 200 && b.recorded.length === 4 && b.finals.size === 4,
  );
  assert(b.recorded.every((r, i) => r.image_order === i));
  const failing = backend();
  failing.io.putFinal = async () => {
    throw new Error('server-only-key');
  };
  const failed = await prepareChatMedia(actor, value, failing.io);
  assert(
    failed.status === 500 && failing.recorded.length === 0 &&
      !(await failed.text()).includes('server-only-key'),
  );
  b.io.record = async () => ({
    ok: false,
    code: '23505',
    message: 'secret database internals',
  });
  const conflict = await prepareChatMedia(actor, value, b.io);
  assert(
    conflict.status === 409 && !(await conflict.text()).includes('secret'),
  );
});
Deno.test('HTTP requires authentication before media IO and never dispatches prepare through app_command RPC', async () => {
  const b = backend();
  const handler = createCommandHandler({
    requireActor: async (req) =>
      req.headers.has('authorization')
        ? { actorId: actor }
        : new Response(null, { status: 401 }),
    executeCommand: (req, auth, transport, context) =>
      executeCommand(req, auth, transport, {
        actorId: context?.actorId ?? '',
        mediaBackend: b.io,
      }),
  });
  assert(
    (await handler(request(payload(), false))).status === 401 &&
      b.finals.size === 0,
  );
  assert((await handler(request(payload()))).status === 200);
  const direct = await executeCommand(
    request(payload()),
    'Bearer user-token',
    () => {
      throw new Error('must not reach RPC');
    },
  );
  assert(
    direct.status === 403,
    'verified actor context required outside normal RPC dispatch',
  );
});
Deno.test('service transport reads bounded bytes, refuses overwrites and hides service failures', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const image = png();
  const io = createMediaBackend(
    'http://storage.test',
    'server-only-key',
    async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === 'POST' && url.includes('/object/')) {
        assert(new Headers(init.headers).get('x-upsert') === 'false');
        return new Response(
          JSON.stringify({ statusCode: '409', error: 'Duplicate' }),
          { status: 400 },
        );
      }
      return new Response(new Uint8Array(image));
    },
  );
  assert((await io.downloadStaging(path)).length === image.length);
  await io.putFinal('immutable.png', image, 'image/png');
  assert(
    calls.length === 3,
    'duplicate requires comparing actual existing bytes',
  );
  const oversized = createMediaBackend(
    'http://storage.test',
    'server-only-key',
    async () => new Response(new Uint8Array(10 * 1024 * 1024 + 1)),
  );
  let denied = false;
  try {
    await oversized.downloadStaging(path);
  } catch {
    denied = true;
  }
  assert(denied);
});
Deno.test('service-only RPC transport sends authoritative fields and rejects malformed responses', async () => {
  const io = createMediaBackend(
    'http://storage.test',
    'server-only-key',
    async (url, init) => {
      assert(
        String(url) === 'http://storage.test/rest/v1/rpc/record_chat_media',
      );
      assert(
        new Headers(init?.headers).get('authorization') ===
          'Bearer server-only-key',
      );
      const body = JSON.parse(String(init?.body));
      assert(
        body.p_actor === actor && body.p_client_key === client &&
          body.p_items[0].image_order === 0,
      );
      return new Response(JSON.stringify({ media: [{ media_id: client }] }));
    },
  );
  const info = await validateChatImage(png());
  const outcome = await io.record(actor, client, [{
    ...info,
    image_order: 0,
    final_path: 'immutable.png',
  }]);
  assert(outcome.ok && Array.isArray(outcome.data.media));
  const invalid = createMediaBackend(
    'http://storage.test',
    'server-only-key',
    async () => new Response('not JSON'),
  );
  assert(!(await invalid.record(actor, client, [])).ok);
});
