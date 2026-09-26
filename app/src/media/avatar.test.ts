import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  openAppDatabase,
  type AppStorage,
  type Storage,
} from '../storage/database';
import { saveDraft } from '../storage/drafts';
import {
  createImageStore,
  type FileSystemPort,
  type ImageReference,
  type ImageStore,
} from '../storage/files';
import { NodeSqliteDriver, createNodeFileSystemPort } from '../storage/testSupport/nodePorts';
import {
  AVATAR_DRAFT_FAILED,
  AVATAR_DRAFT_KEY,
  AVATAR_MAX_DIMENSION,
  AVATAR_PROCESSING_FAILED,
  applyAvatarSelection,
  clearAvatarWork,
  detectAvatarFormat,
  discardAvatarDraft,
  fitAvatarGeometry,
  pngDimensionsFromBase64,
  readAvatarDraft,
  saveAvatarDraft,
  validateAvatarSource,
  type AvatarGeometry,
  type AvatarImage,
  type AvatarOps,
  type PickedAvatarSource,
} from './avatar';
import { MAX_IMAGE_BYTES } from './images';

/**
 * Task 16 pipeline tests: pick result → validate → orient → square-fit →
 * 1024 cap → white composite → JPEG → persistent commit → draft.
 *
 * REAL layers: SQLite (node:sqlite through the production SQL), the real file
 * system (ImageStore staging/move over node fs). MOCKED layers: the native
 * image stages only (injected as {@link AvatarOps}) — they are plain
 * file-producing functions here; their real decoder/white-composite behaviour
 * is device evidence (docs/testing/app-foundation-friends-ui.md), never
 * claimed by these tests.
 */

const ACCOUNT = 'avatar_tester';
const SOURCE_BYTES = 'source-image-bytes';

interface Harness {
  root: string;
  documentRoot: string;
  fs: FileSystemPort;
  db: AppStorage;
  store: ImageStore;
  sourcePath: string;
  reopen(): Promise<AppStorage>;
  workFiles(): string[];
  accountFiles(): string[];
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'avatar-test-'));
  const documentRoot = path.join(root, 'Documents');
  nodeFs.mkdirSync(documentRoot, { recursive: true });
  const fsPort = createNodeFileSystemPort(documentRoot);
  const dbPath = path.join(root, 'app.db');
  const db = await openAppDatabase({ driver: new NodeSqliteDriver(dbPath) });
  const sourcePath = path.join(root, 'picked-source.png');
  nodeFs.writeFileSync(sourcePath, SOURCE_BYTES);
  let imageSeq = 0;
  const open: AppStorage[] = [db];
  const store = createImageStore({
    fs: fsPort,
    newId: () => `img-${(imageSeq += 1).toString().padStart(3, '0')}`,
  });
  const workDirectory = path.join(documentRoot, 'images', '.avatar-work');
  const accountDirectory = path.join(documentRoot, 'images', ACCOUNT);
  return {
    root,
    documentRoot,
    fs: fsPort,
    db,
    store,
    sourcePath,
    async reopen() {
      const next = await openAppDatabase({ driver: new NodeSqliteDriver(dbPath) });
      open.push(next);
      return next;
    },
    workFiles() {
      if (!nodeFs.existsSync(workDirectory)) return [];
      return nodeFs.readdirSync(workDirectory).sort();
    },
    accountFiles() {
      if (!nodeFs.existsSync(accountDirectory)) return [];
      return nodeFs.readdirSync(accountDirectory).sort();
    },
    async cleanup() {
      for (const storage of open) {
        try {
          await storage.close();
        } catch {
          // Already closed by a test.
        }
      }
      nodeFs.rmSync(root, { recursive: true, force: true });
    },
  };
}

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

// ---------------------------------------------------------------------------
// Fake native stages
// ---------------------------------------------------------------------------

interface FakeOpsOptions {
  /** Dimensions the decode stage reports (orientation already normalized). */
  decoded?: { width: number; height: number };
  /** Fail a stage with this error. */
  failAt?: 'decode' | 'fit' | 'flatten' | 'encode';
  /** Dimensions the flatten stage reports (rasterizer can overshoot scale). */
  flattened?: { width: number; height: number };
  /** Dimensions the JPEG stage reports (defaults to its input). */
  encoded?: { width: number; height: number };
  /** Append a file to disk that importImage will try to copy (disk-full path). */
  skipOutputFile?: boolean;
}

interface FakeOps {
  ops: AvatarOps;
  calls: string[];
  geometries: AvatarGeometry[];
  flatInputs: AvatarImage[];
  qualities: number[];
}

function createFakeOps(fs: FileSystemPort, options: FakeOpsOptions = {}): FakeOps {
  const calls: string[] = [];
  const geometries: AvatarGeometry[] = [];
  const flatInputs: AvatarImage[] = [];
  const qualities: number[] = [];
  const workDirectory = fs.join(fs.documentRoot, 'images', '.avatar-work');
  let counter = 0;

  const output = (suffix: string): string => {
    fs.ensureDirectory(workDirectory);
    counter += 1;
    const uri = fs.join(workDirectory, `fake-${counter}.${suffix}`);
    fs.writeFile(uri, `fake-stage-${counter}`);
    return uri;
  };

  const fail = (stage: FakeOpsOptions['failAt']): void => {
    if (options.failAt === stage) throw new Error(`${stage} stage exploded`);
  };

  const ops: AvatarOps = {
    async decode(sourceUri: string): Promise<AvatarImage> {
      calls.push('decode');
      fail('decode');
      const dims = options.decoded ?? { width: 4000, height: 3000 };
      return { uri: output(`decode.${path.extname(sourceUri) || 'png'}`), ...dims };
    },
    async fit(_image: AvatarImage, geometry: AvatarGeometry): Promise<AvatarImage> {
      calls.push('fit');
      geometries.push(geometry);
      fail('fit');
      return {
        uri: output('fit.png'),
        width: geometry.outWidth,
        height: geometry.outHeight,
      };
    },
    async flattenOntoWhite(image: AvatarImage): Promise<AvatarImage> {
      calls.push('flatten');
      flatInputs.push(image);
      fail('flatten');
      const dims = options.flattened ?? { width: image.width, height: image.height };
      return { uri: output('composite.png'), ...dims };
    },
    async encodeJpeg(image: AvatarImage, quality: number): Promise<AvatarImage> {
      calls.push('encodeJpeg');
      qualities.push(quality);
      fail('encode');
      const dims = options.encoded ?? { width: image.width, height: image.height };
      if (options.skipOutputFile) {
        return { uri: fs.join(workDirectory, `missing-${counter += 1}.jpg`), ...dims };
      }
      return { uri: output('out.jpg'), ...dims };
    },
  };
  return { ops, calls, geometries, flatInputs, qualities };
}

function picked(uri: string, overrides: Partial<PickedAvatarSource> = {}): PickedAvatarSource {
  return { uri, mimeType: 'image/png', ...overrides };
}

function deps(fake: FakeOps): { ops: AvatarOps; store: ImageStore; fs: FileSystemPort } {
  return { ops: fake.ops, store: harness.store, fs: harness.fs };
}

async function seedDraftImage(): Promise<ImageReference> {
  const reference = await harness.store.importImage(ACCOUNT, harness.sourcePath, {
    extension: 'png',
    newId: () => 'old-staged',
  });
  await saveAvatarDraft(harness.db, ACCOUNT, reference);
  return reference;
}

// ---------------------------------------------------------------------------
// Geometry (square fit + 1024 cap)
// ---------------------------------------------------------------------------

describe('fitAvatarGeometry', () => {
  it('center-crops a landscape image and caps at 1024', () => {
    expect(fitAvatarGeometry(4000, 3000)).toEqual({
      originX: 500,
      originY: 0,
      cropSize: 3000,
      outWidth: AVATAR_MAX_DIMENSION,
      outHeight: AVATAR_MAX_DIMENSION,
    });
  });

  it('center-crops a portrait image', () => {
    expect(fitAvatarGeometry(3000, 4000)).toMatchObject({
      originX: 0,
      originY: 500,
      cropSize: 3000,
      outWidth: 1024,
      outHeight: 1024,
    });
  });

  it('never upscales small images and stays square', () => {
    const small = fitAvatarGeometry(500, 800);
    expect(small).toEqual({
      originX: 0,
      originY: 150,
      cropSize: 500,
      outWidth: 500,
      outHeight: 500,
    });
  });

  it('keeps the exact boundary at 1024 and reduces 1025', () => {
    expect(fitAvatarGeometry(1024, 1024).outWidth).toBe(1024);
    expect(fitAvatarGeometry(1025, 900)).toMatchObject({ cropSize: 900, outWidth: 900 });
    expect(fitAvatarGeometry(2048, 2048)).toMatchObject({ outWidth: 1024, outHeight: 1024 });
  });

  it('rejects unusable dimensions', () => {
    expect(() => fitAvatarGeometry(0, 100)).toThrow();
    expect(() => fitAvatarGeometry(100, Number.NaN)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Source format + 10MB boundary
// ---------------------------------------------------------------------------

describe('detectAvatarFormat', () => {
  it('accepts JPEG, PNG and HEIC mime types (including aliases)', () => {
    expect(detectAvatarFormat({ uri: 'x', mimeType: 'image/jpeg' })).toBe('jpeg');
    expect(detectAvatarFormat({ uri: 'x', mimeType: 'image/jpg' })).toBe('jpeg');
    expect(detectAvatarFormat({ uri: 'x', mimeType: 'image/png' })).toBe('png');
    expect(detectAvatarFormat({ uri: 'x', mimeType: 'image/heic' })).toBe('heic');
    expect(detectAvatarFormat({ uri: 'x', mimeType: 'image/heif' })).toBe('heic');
    expect(detectAvatarFormat({ uri: 'x', mimeType: 'image/jpeg; charset=binary' })).toBe('jpeg');
  });

  it('falls back to the file name, then the URI extension, without a mime type', () => {
    expect(detectAvatarFormat({ uri: 'file:///tmp/a', mimeType: null, fileName: 'IMG.HEIC' })).toBe('heic');
    expect(detectAvatarFormat({ uri: 'file:///tmp/photo.PNG', mimeType: null, fileName: null })).toBe('png');
    expect(detectAvatarFormat({ uri: 'file:///tmp/raw.jpg?w=1', mimeType: undefined })).toBe('jpeg');
  });

  it('rejects other formats even when the extension lies', () => {
    expect(detectAvatarFormat({ uri: 'file:///tmp/x.jpg', mimeType: 'image/gif' })).toBeNull();
    expect(detectAvatarFormat({ uri: 'file:///tmp/x.mp4', mimeType: 'video/mp4' })).toBeNull();
    expect(detectAvatarFormat({ uri: 'file:///tmp/doc.pdf', mimeType: null, fileName: 'doc.pdf' })).toBeNull();
    expect(detectAvatarFormat({ uri: 'file:///tmp/noext', mimeType: null, fileName: null })).toBeNull();
  });
});

describe('validateAvatarSource', () => {
  const source = { uri: 'file:///tmp/picked.jpg', mimeType: 'image/jpeg' };

  it('accepts exactly 10MB (inclusive boundary)', () => {
    expect(validateAvatarSource(source, MAX_IMAGE_BYTES)).toBeNull();
  });

  it('rejects one byte over 10MB with a clear message', () => {
    const problem = validateAvatarSource(source, MAX_IMAGE_BYTES + 1);
    expect(problem).toMatchObject({ code: 'size' });
    expect(problem?.message).toContain('10MB');
  });

  it('rejects with a format message naming every accepted format', () => {
    const problem = validateAvatarSource({ uri: 'file:///tmp/a.gif', mimeType: 'image/gif' }, 100);
    expect(problem).toMatchObject({ code: 'format' });
    expect(problem?.message).toMatch(/JPEG/);
    expect(problem?.message).toMatch(/PNG/);
    expect(problem?.message).toMatch(/HEIC/);
  });

  it('reports unreadable files instead of blaming the format', () => {
    expect(validateAvatarSource(source, 0)).toMatchObject({ code: 'unreadable' });
    expect(validateAvatarSource(source, -1)).toMatchObject({ code: 'unreadable' });
    expect(validateAvatarSource(source, Number.NaN)).toMatchObject({ code: 'unreadable' });
  });
});

// ---------------------------------------------------------------------------
// End-to-end pipeline: JPEG / PNG / HEIC in, committed JPEG + draft out
// ---------------------------------------------------------------------------

describe('applyAvatarSelection — accepted inputs', () => {
  it.each([
    ['jpeg', 'image/jpeg', 'photo.jpg'],
    ['png', 'image/png', 'screenshot.png'],
    ['heic', 'image/heic', 'IMG_0001.HEIC'],
  ])('processes a %s source into a committed JPEG draft', async (format, mime, fileName) => {
    const fake = createFakeOps(harness.fs);
    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath, { mimeType: mime, fileName }),
      deps(fake),
    );

    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') throw new Error('unreachable');
    expect(outcome.reference.relativePath).toMatch(
      new RegExp(`^images/${ACCOUNT}/img-\\d{3}\\.jpg$`),
    );
    expect(outcome.reference.bytes).toBeGreaterThan(0);
    expect(nodeFs.existsSync(harness.store.resolvePath(outcome.reference))).toBe(true);
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toEqual(outcome.reference);
    expect(harness.workFiles()).toHaveLength(0);
    // The picker's source file is never consumed or deleted.
    expect(nodeFs.readFileSync(harness.sourcePath, 'utf8')).toBe(SOURCE_BYTES);
  });

  it('runs the stages in order: decode → fit → flatten → JPEG (white before encode)', async () => {
    const fake = createFakeOps(harness.fs, { decoded: { width: 3000, height: 4000 } });
    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath),
      deps(fake),
    );

    expect(outcome.status).toBe('committed');
    expect(fake.calls).toEqual(['decode', 'fit', 'flatten', 'encodeJpeg']);
    // The composite step receives the geometry-fitted image, so transparency
    // is flattened at the final dimensions and never reaches the JPEG encoder
    // (the encoder input is the flatten output — see the flatInputs record).
    expect(fake.flatInputs).toHaveLength(1);
    expect(fake.flatInputs[0]).toMatchObject({ width: 1024, height: 1024 });
    expect(fake.qualities).toEqual([0.9]);
    if (outcome.status !== 'committed') throw new Error('unreachable');
    expect(outcome).toMatchObject({ width: 1024, height: 1024 });
  });

  it('computes the crop from the ORIENTATION-CORRECTED dimensions (EXIF rotation)', async () => {
    // A landscape sensor image carrying EXIF orientation 6: the platform
    // decoder normalizes it, so decode reports PORTRAIT dimensions. The crop
    // must be derived from that result, not from the raw sensor size.
    const fake = createFakeOps(harness.fs, { decoded: { width: 300, height: 400 } });
    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath, { mimeType: 'image/jpeg', fileName: 'rotated.jpg' }),
      deps(fake),
    );

    expect(outcome.status).toBe('committed');
    expect(fake.geometries).toEqual([fitAvatarGeometry(300, 400)]);
    expect(fake.geometries[0]).toMatchObject({
      originX: 0,
      originY: 50,
      cropSize: 300,
      outWidth: 300,
      outHeight: 300,
    });
    // Orientation is resolved entirely inside decode: exactly one decode and
    // no other geometry-changing stage ran (no second rotation can happen).
    expect(fake.calls.filter((call) => call === 'decode')).toHaveLength(1);
    expect(fake.calls).toEqual(['decode', 'fit', 'flatten', 'encodeJpeg']);
    if (outcome.status !== 'committed') throw new Error('unreachable');
    expect(outcome).toMatchObject({ width: 300, height: 300 });
  });

  it('re-applies the 1024 cap when the rasterizer overshoots (screen-scale composite)', async () => {
    // iOS rasterizes the offscreen SVG scene at the device screen scale, so
    // a 1024² request can come back as 3072² (3×). The pipeline must trust
    // the ACTUAL composite size and cap it before the JPEG encode instead of
    // committing an oversized image (or failing the whole run).
    const fake = createFakeOps(harness.fs, {
      decoded: { width: 1600, height: 1200 },
      flattened: { width: 3072, height: 3072 },
    });
    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath),
      deps(fake),
    );

    expect(outcome.status).toBe('committed');
    expect(fake.calls).toEqual(['decode', 'fit', 'flatten', 'fit', 'encodeJpeg']);
    expect(fake.geometries).toHaveLength(2);
    expect(fake.geometries[0]).toEqual(fitAvatarGeometry(1600, 1200));
    expect(fake.geometries[1]).toEqual(fitAvatarGeometry(3072, 3072));
    expect(fake.geometries[1]).toMatchObject({ outWidth: 1024, outHeight: 1024 });
    if (outcome.status !== 'committed') throw new Error('unreachable');
    expect(outcome).toMatchObject({ width: 1024, height: 1024 });
    expect(harness.workFiles()).toHaveLength(0);
  });

  it('uses the file system size when the picker reports no fileSize', async () => {
    const fake = createFakeOps(harness.fs);
    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath, { fileSize: null }),
      deps(fake),
    );
    expect(outcome.status).toBe('committed');
  });

  it('replaces the staged draft image and reclaims the previous file', async () => {
    const oldRef = await seedDraftImage();
    const fake = createFakeOps(harness.fs);
    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath),
      deps(fake),
    );

    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') throw new Error('unreachable');
    expect(outcome.reference.imageId).not.toBe(oldRef.imageId);
    expect(nodeFs.existsSync(harness.store.resolvePath(oldRef))).toBe(false);
    expect(nodeFs.existsSync(harness.store.resolvePath(outcome.reference))).toBe(true);
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toEqual(outcome.reference);
  });
});

// ---------------------------------------------------------------------------
// Rejections (format / size boundary)
// ---------------------------------------------------------------------------

describe('applyAvatarSelection — rejected sources', () => {
  it('rejects a source over 10MB before any stage runs and keeps the old draft', async () => {
    const oldRef = await seedDraftImage();
    const fake = createFakeOps(harness.fs);

    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath, { fileSize: MAX_IMAGE_BYTES + 1 }),
      deps(fake),
    );

    expect(outcome).toMatchObject({ status: 'rejected', code: 'size' });
    if (outcome.status !== 'rejected') throw new Error('unreachable');
    expect(outcome.message).toContain('10MB');
    expect(fake.calls).toHaveLength(0);
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toEqual(oldRef);
    expect(nodeFs.existsSync(harness.store.resolvePath(oldRef))).toBe(true);
    expect(harness.accountFiles()).toEqual([`${oldRef.imageId}.png`]);
  });

  it('accepts a source of exactly 10MB', async () => {
    const fake = createFakeOps(harness.fs);
    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath, { fileSize: MAX_IMAGE_BYTES }),
      deps(fake),
    );
    expect(outcome.status).toBe('committed');
  });

  it('rejects a non-JPEG/PNG/HEIC source with a format message', async () => {
    const oldRef = await seedDraftImage();
    const fake = createFakeOps(harness.fs);

    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath, { mimeType: 'image/gif' }),
      deps(fake),
    );

    expect(outcome).toMatchObject({ status: 'rejected', code: 'format' });
    if (outcome.status !== 'rejected') throw new Error('unreachable');
    expect(outcome.message).toMatch(/JPEG/);
    expect(outcome.message).toMatch(/HEIC/);
    expect(fake.calls).toHaveLength(0);
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toEqual(oldRef);
  });

  it('rejects a missing/unreadable source file', async () => {
    const fake = createFakeOps(harness.fs);
    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(path.join(harness.root, 'does-not-exist.png'), { fileSize: null }),
      deps(fake),
    );
    expect(outcome).toMatchObject({ status: 'rejected', code: 'unreadable' });
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cancel (OS のキャンセルはエラーにしない・削除しない)
// ---------------------------------------------------------------------------

describe('applyAvatarSelection — OS cancel', () => {
  it('returns canceled without reading, writing or deleting anything', async () => {
    const oldRef = await seedDraftImage();
    const fake = createFakeOps(harness.fs);

    const outcome = await applyAvatarSelection(harness.db, ACCOUNT, null, deps(fake));

    expect(outcome).toEqual({ status: 'canceled' });
    expect(fake.calls).toHaveLength(0);
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toEqual(oldRef);
    expect(nodeFs.existsSync(harness.store.resolvePath(oldRef))).toBe(true);
    expect(harness.workFiles()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Processing / disk failures keep the OLD draft
// ---------------------------------------------------------------------------

describe('applyAvatarSelection — failures keep the previous draft', () => {
  it('keeps the old draft when a stage fails (decoder crash)', async () => {
    const oldRef = await seedDraftImage();
    const fake = createFakeOps(harness.fs, { failAt: 'decode' });

    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath),
      deps(fake),
    );

    expect(outcome).toEqual({ status: 'failed', message: AVATAR_PROCESSING_FAILED });
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toEqual(oldRef);
    expect(nodeFs.existsSync(harness.store.resolvePath(oldRef))).toBe(true);
    expect(harness.accountFiles()).toEqual([`${oldRef.imageId}.png`]);
    expect(harness.workFiles()).toHaveLength(0);
  });

  it('keeps the old draft when white compositing fails (透過合成の失敗)', async () => {
    const oldRef = await seedDraftImage();
    const fake = createFakeOps(harness.fs, { failAt: 'flatten' });

    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath),
      deps(fake),
    );

    expect(outcome.status).toBe('failed');
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toEqual(oldRef);
    expect(nodeFs.existsSync(harness.store.resolvePath(oldRef))).toBe(true);
    expect(harness.accountFiles()).toEqual([`${oldRef.imageId}.png`]);
  });

  it('keeps the old draft on disk-full during the commit copy (ENOSPC)', async () => {
    const oldRef = await seedDraftImage();
    const fake = createFakeOps(harness.fs);
    const healthyFs = harness.fs;
    const failingFs: FileSystemPort = {
      ...healthyFs,
      async copyFile(): Promise<void> {
        const error = new Error('ENOSPC: no space left on device, copyfile');
        error.name = 'ENOSPC';
        throw error;
      },
    };

    const outcome = await applyAvatarSelection(harness.db, ACCOUNT, picked(harness.sourcePath), {
      ops: fake.ops,
      store: createImageStore({ fs: failingFs }),
      fs: healthyFs,
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.message).toBe(AVATAR_PROCESSING_FAILED);
    // Draft row AND the old file are exactly as before; staging was cleaned.
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toEqual(oldRef);
    expect(nodeFs.existsSync(harness.store.resolvePath(oldRef))).toBe(true);
    expect(harness.accountFiles()).toEqual([`${oldRef.imageId}.png`]);
    expect(harness.workFiles()).toHaveLength(0);
  });

  it('refuses an over-sized processed image instead of committing it', async () => {
    const oldRef = await seedDraftImage();
    const fake = createFakeOps(harness.fs, {
      encoded: { width: 2048, height: 2048 },
    });

    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath),
      deps(fake),
    );

    expect(outcome.status).toBe('failed');
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toEqual(oldRef);
    expect(harness.accountFiles()).toEqual([`${oldRef.imageId}.png`]);
  });

  it('rolls the committed file back when the draft write fails (reference/draft consistency)', async () => {
    const oldRef = await seedDraftImage();
    const fake = createFakeOps(harness.fs);
    const order: string[] = [];
    const failingDraftDb: Storage = {
      ...harness.db,
      withWriteTransaction<T>(): Promise<T> {
        order.push('draft-save');
        return Promise.reject(new Error('database is locked'));
      },
    };
    const orderedStore: ImageStore = {
      ...harness.store,
      async importImage(...args): Promise<ImageReference> {
        order.push('commit');
        return harness.store.importImage(...args);
      },
    };

    const outcome = await applyAvatarSelection(failingDraftDb, ACCOUNT, picked(harness.sourcePath), {
      ops: fake.ops,
      store: orderedStore,
      fs: harness.fs,
    });

    expect(outcome).toEqual({ status: 'failed', message: AVATAR_DRAFT_FAILED });
    // The commit happened first and was rolled back: no file, no draft change.
    expect(order).toEqual(['commit', 'draft-save']);
    expect(harness.accountFiles()).toEqual([`${oldRef.imageId}.png`]);
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toEqual(oldRef);
    expect(harness.workFiles()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Commit/draft ordering (no published/persisted mismatch)
// ---------------------------------------------------------------------------

describe('commit and draft stay consistent', () => {
  it('commits the file before writing the draft reference', async () => {
    const order: string[] = [];
    const orderedDb: Storage = {
      ...harness.db,
      withWriteTransaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T> {
        order.push('draft-save');
        return harness.db.withWriteTransaction(fn);
      },
    };
    const orderedStore: ImageStore = {
      ...harness.store,
      async importImage(...args): Promise<ImageReference> {
        order.push('commit');
        return harness.store.importImage(...args);
      },
    };

    const fake = createFakeOps(harness.fs);
    const outcome = await applyAvatarSelection(orderedDb, ACCOUNT, picked(harness.sourcePath), {
      ops: fake.ops,
      store: orderedStore,
      fs: harness.fs,
    });

    expect(outcome.status).toBe('committed');
    expect(order).toEqual(['commit', 'draft-save']);
  });

  it('never writes a draft when the commit fails', async () => {
    const order: string[] = [];
    const orderedDb: Storage = {
      ...harness.db,
      withWriteTransaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T> {
        order.push('draft-save');
        return harness.db.withWriteTransaction(fn);
      },
    };
    const fake = createFakeOps(harness.fs, { skipOutputFile: true });

    const outcome = await applyAvatarSelection(orderedDb, ACCOUNT, picked(harness.sourcePath), {
      ops: fake.ops,
      store: harness.store,
      fs: harness.fs,
    });

    expect(outcome.status).toBe('failed');
    expect(order).not.toContain('draft-save');
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toBeNull();
    expect(harness.accountFiles()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Relaunch restore (JS-level; device relaunch is recorded separately)
// ---------------------------------------------------------------------------

describe('draft survives a database reopen (relaunch restore)', () => {
  it('reads back the committed reference from a fresh handle', async () => {
    const fake = createFakeOps(harness.fs);
    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath),
      deps(fake),
    );
    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') throw new Error('unreachable');

    await harness.db.close();
    const reopened = await harness.reopen();

    await expect(readAvatarDraft(reopened, ACCOUNT)).resolves.toEqual(outcome.reference);
    expect(nodeFs.existsSync(harness.store.resolvePath(outcome.reference))).toBe(true);
    // Work cleanup never touches committed images.
    clearAvatarWork(harness.fs);
    expect(nodeFs.existsSync(harness.store.resolvePath(outcome.reference))).toBe(true);
  });

  it('degrades a corrupt draft body to "no image" instead of throwing', async () => {
    await saveDraft(harness.db, ACCOUNT, AVATAR_DRAFT_KEY, { avatar: 'not-a-reference' });
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 削除 (discard the staged image, never the published one)
// ---------------------------------------------------------------------------

describe('pngDimensionsFromBase64', () => {
  function pngHeadBase64(width: number, height: number): string {
    const head = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
    head.writeUInt32BE(13, 8); // IHDR length
    head.write('IHDR', 12, 'ascii');
    head.writeUInt32BE(width, 16);
    head.writeUInt32BE(height, 20);
    return head.toString('base64');
  }

  it('reads the rasterized dimensions from a PNG header', () => {
    expect(pngDimensionsFromBase64(pngHeadBase64(3072, 3072))).toEqual({
      width: 3072,
      height: 3072,
    });
    expect(pngDimensionsFromBase64(pngHeadBase64(1024, 768))).toEqual({
      width: 1024,
      height: 768,
    });
  });

  it('tolerates line-wrapped base64 (iOS NSData encoding adds newlines)', () => {
    const base64 = pngHeadBase64(1024, 1024).replace(/(.{16})/g, '$1\n');
    expect(pngDimensionsFromBase64(base64)).toEqual({ width: 1024, height: 1024 });
  });

  it('returns null for non-PNG or truncated prefixes', () => {
    expect(pngDimensionsFromBase64('')).toBeNull();
    expect(pngDimensionsFromBase64('iVBOR')).toBeNull();
    // JPEG SOI marker instead of the PNG signature.
    expect(pngDimensionsFromBase64(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64'))).toBeNull();
  });
});

describe('discardAvatarDraft', () => {
  async function seedPublishedImage(): Promise<ImageReference> {
    return harness.store.importImage(ACCOUNT, harness.sourcePath, {
      extension: 'png',
      newId: () => 'published',
    });
  }

  it('removes the staged draft image and keeps the published image', async () => {
    const publishedRef = await seedPublishedImage();
    const fake = createFakeOps(harness.fs);
    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath),
      deps(fake),
    );
    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') throw new Error('unreachable');
    const stagedRef = outcome.reference;

    const discarded = await discardAvatarDraft(harness.db, ACCOUNT, harness.store);

    expect(discarded).toEqual({ status: 'cleared', removed: stagedRef });
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toBeNull();
    expect(nodeFs.existsSync(harness.store.resolvePath(stagedRef))).toBe(false);
    // The published image is a different reference and must survive.
    expect(nodeFs.existsSync(harness.store.resolvePath(publishedRef))).toBe(true);
    expect(harness.accountFiles()).toEqual([`${publishedRef.imageId}.png`]);
  });

  it('is a no-op when no image is staged', async () => {
    const publishedRef = await seedPublishedImage();
    const discarded = await discardAvatarDraft(harness.db, ACCOUNT, harness.store);
    expect(discarded).toEqual({ status: 'cleared', removed: null });
    expect(nodeFs.existsSync(harness.store.resolvePath(publishedRef))).toBe(true);
    expect(harness.accountFiles()).toEqual([`${publishedRef.imageId}.png`]);
  });

  it('keeps the staged image when clearing the draft row fails', async () => {
    const fake = createFakeOps(harness.fs);
    const outcome = await applyAvatarSelection(
      harness.db,
      ACCOUNT,
      picked(harness.sourcePath),
      deps(fake),
    );
    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') throw new Error('unreachable');

    const failingDb: Storage = {
      ...harness.db,
      withWriteTransaction<T>(): Promise<T> {
        return Promise.reject(new Error('database is locked'));
      },
    };

    await expect(discardAvatarDraft(failingDb, ACCOUNT, harness.store)).rejects.toThrow();
    // Draft row still points at a file that exists: no dangling reference.
    await expect(readAvatarDraft(harness.db, ACCOUNT)).resolves.toEqual(outcome.reference);
    expect(nodeFs.existsSync(harness.store.resolvePath(outcome.reference))).toBe(true);
  });
});
