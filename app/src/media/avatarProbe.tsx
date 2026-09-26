import { useEffect, useRef, useState } from 'react';

import { File, Paths } from 'expo-file-system';

import { openAppDatabase } from '../storage/database';
import {
  createImageStore,
  expoFileSystemPort,
  type FileSystemPort,
} from '../storage/files';
import { applyAvatarSelection, readAvatarDraft } from './avatar';
import { createDeviceAvatarOps, useAvatarComposite } from './AvatarPicker';
import { PROBE_EXIF_JPEG_BASE64, PROBE_TRANSPARENT_PNG_BASE64 } from './avatarProbeFixtures';

/**
 * Dev-only avatar evidence for docs/testing/app-foundation-friends-ui.md
 * (Task 16), following the storageProbe pattern: it runs inside the app on a
 * real build ONLY when `__DEV__` is true and an `avatar-probe.enabled` flag
 * file exists in the document directory, appends to `avatar-probe.jsonl` and
 * renders nothing visible (its offscreen SVG composite scene is the only
 * thing it mounts).
 *
 * It cannot drive the OS picker (the headless simulator has no tap input),
 * so it feeds the pipeline two embedded fixtures instead: a transparent
 * 1600×1200 PNG (white composite + 1024 cap evidence) and a 320×240 JPEG
 * with EXIF Orientation=6 (orientation-normalization evidence). The first
 * run commits a staged image; after a forced terminate, the second run first
 * logs the draft restored from SQLite and whether its file still exists —
 * the relaunch-load check.
 */

export const AVATAR_PROBE_FLAG_FILE = 'avatar-probe.enabled';
export const AVATAR_PROBE_LOG_FILE = 'avatar-probe.jsonl';
export const AVATAR_PROBE_ACCOUNT = '__avatar_probe';
const TRANSPARENT_FILE = 'avatar-probe-transparent.png';
const EXIF_FILE = 'avatar-probe-exif.jpg';

interface ProbeLine {
  at: string;
  phase: string;
  [key: string]: unknown;
}

export function avatarProbeEnabled(): boolean {
  try {
    if (typeof __DEV__ === 'undefined' || !__DEV__) return false;
    const root = Paths.document;
    if (!root?.uri) return false;
    return new File(root, AVATAR_PROBE_FLAG_FILE).exists;
  } catch {
    return false;
  }
}

function appendLogLine(line: ProbeLine): void {
  try {
    const file = new File(Paths.document, AVATAR_PROBE_LOG_FILE);
    const previous = file.exists ? file.textSync() : '';
    if (!file.exists) file.create({ intermediates: true });
    file.write(`${previous}${JSON.stringify(line)}\n`);
    console.log(`[avatar-probe] ${JSON.stringify(line)}`);
  } catch (error) {
    console.warn(`[avatar-probe] log write failed: ${String(error)}`);
  }
}

function ensureFixture(fs: FileSystemPort, name: string, base64: string): string {
  const file = new File(Paths.document, name);
  if (!file.exists || file.size === 0) {
    if (file.exists) file.delete();
    file.create({ intermediates: true });
    file.write(base64, { encoding: 'base64' });
  }
  if (fs.size(file.uri) <= 0) throw new Error(`fixture ${name} could not be written`);
  return file.uri;
}

async function runAvatarProbe(flatten: ReturnType<typeof useAvatarComposite>['flatten']): Promise<void> {
  const fs = expoFileSystemPort;
  const store = createImageStore({ fs });
  const baseOps = createDeviceAvatarOps(flatten);
  const now = () => new Date().toISOString();

  // Per-stage timing + failure capture: the pipeline reports one generic
  // failure message (by design), so the probe wraps each stage to record
  // WHICH native stage failed and how long it took on the device.
  const stageStats: Record<string, { ok: number; failed: number; lastError: string; lastMs: number }> = {};
  const watched = <A extends unknown[], R>(stage: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const startedAt = Date.now();
      const stat = (stageStats[stage] ??= { ok: 0, failed: 0, lastError: '', lastMs: 0 });
      try {
        const result = await fn(...args);
        stat.ok += 1;
        stat.lastMs = Date.now() - startedAt;
        return result;
      } catch (error) {
        stat.failed += 1;
        stat.lastMs = Date.now() - startedAt;
        stat.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    };
  const ops: typeof baseOps = {
    decode: watched('decode', baseOps.decode),
    fit: watched('fit', baseOps.fit),
    flattenOntoWhite: watched('flatten', baseOps.flattenOntoWhite),
    encodeJpeg: watched('encodeJpeg', baseOps.encodeJpeg),
  };
  const probeStore = {
    ...store,
    importImage: watched('commit', store.importImage),
  };

  let storage: Awaited<ReturnType<typeof openAppDatabase>> | null = null;
  try {
    // 1) Relaunch-load evidence: what a NEW process sees in the draft first.
    storage = await openAppDatabase();
    const previous = await readAvatarDraft(storage, AVATAR_PROBE_ACCOUNT);
    appendLogLine({
      at: now(),
      phase: 'restore',
      draft: previous?.relativePath ?? null,
      draftExists: previous !== null ? fs.exists(fs.join(fs.documentRoot, previous.relativePath)) : false,
      draftBytes: previous !== null ? fs.size(fs.join(fs.documentRoot, previous.relativePath)) : 0,
    });

    // 2) EXIF orientation evidence: 320×240 + Orientation=6 must decode to
    //    240×320 when the platform decoder normalizes orientation.
    const exifPath = ensureFixture(fs, EXIF_FILE, PROBE_EXIF_JPEG_BASE64);
    const decoded = await ops.decode(exifPath);
    appendLogLine({
      at: now(),
      phase: 'exif-decode',
      source: '320x240 jpeg, EXIF Orientation=6',
      width: decoded.width,
      height: decoded.height,
      normalized: decoded.width === 240 && decoded.height === 320,
    });
    try {
      if (fs.exists(decoded.uri)) fs.removeFile(decoded.uri);
    } catch {
      // Cache cleanup is best effort.
    }

    // 3) End-to-end: transparent 1600×1200 → white composite → 1024² JPEG →
    //    persistent commit → draft save (real SQLite + real file system).
    const transparentPath = ensureFixture(fs, TRANSPARENT_FILE, PROBE_TRANSPARENT_PNG_BASE64);
    const outcome = await applyAvatarSelection(
      storage,
      AVATAR_PROBE_ACCOUNT,
      {
        uri: transparentPath,
        mimeType: 'image/png',
        fileName: TRANSPARENT_FILE,
        fileSize: fs.size(transparentPath),
      },
      { ops, store: probeStore, fs },
    );
    const line: ProbeLine = { at: now(), phase: 'commit', status: outcome.status, stages: stageStats };
    if (outcome.status === 'committed') {
      line.width = outcome.width;
      line.height = outcome.height;
      line.relativePath = outcome.reference.relativePath;
      line.bytes = outcome.reference.bytes;
      line.restoredDraft = (await readAvatarDraft(storage, AVATAR_PROBE_ACCOUNT))?.relativePath ?? null;
    } else if ('message' in outcome) {
      line.message = outcome.message;
    }
    appendLogLine(line);
  } catch (error) {
    appendLogLine({
      at: now(),
      phase: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (storage !== null) {
      try {
        await storage.close();
      } catch {
        // Nothing else to do in a dev probe.
      }
    }
  }
}

/**
 * Mounts the probe scene and runs the pipeline once when the flag file is
 * present. Renders null (and does nothing at all) otherwise, so normal
 * development sessions and the test suite are unaffected.
 */
export function AvatarProbeHost() {
  const [enabled, setEnabled] = useState(false);
  const composite = useAvatarComposite(expoFileSystemPort);
  const started = useRef(false);

  useEffect(() => {
    setEnabled(avatarProbeEnabled());
  }, []);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    void runAvatarProbe(composite.flatten);
  }, [enabled, composite.flatten]);

  if (!enabled) return null;
  return <>{composite.host}</>;
}
