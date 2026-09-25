import { File, Paths } from 'expo-file-system';
import { openAppDatabase, randomId } from './database';
import { readDraft, saveDraft } from './drafts';

/**
 * Dev-only persistence evidence for docs/testing/app-foundation-friends-ui.md.
 *
 * The probe runs on app start only when `__DEV__` is true and a
 * `storage-probe.enabled` flag file exists in the document directory. Each run
 * stores a fresh random token as an account draft through the real storage
 * layer, restores the token written by the previous run, and appends the
 * result to `storage-probe.jsonl`. Terminating and relaunching the app proves
 * a real write → process exit → relaunch → restore cycle on device SQLite.
 */

export const PROBE_ACCOUNT_ID = '__device_probe';
export const PROBE_DRAFT_KEY = 'relaunch';
export const PROBE_FLAG_FILE = 'storage-probe.enabled';
export const PROBE_LOG_FILE = 'storage-probe.jsonl';

export interface ProbeLogLine {
  at: string;
  token: string;
  restoredFrom: string | null;
  restored: boolean;
  schemaVersion: number;
  error?: string;
}

function appendLogLine(line: ProbeLogLine): void {
  const file = new File(Paths.document, PROBE_LOG_FILE);
  const previous = file.exists ? file.textSync() : '';
  if (!file.exists) file.create({ intermediates: true });
  file.write(`${previous}${JSON.stringify(line)}\n`);
}

async function runProbe(): Promise<void> {
  const storage = await openAppDatabase();
  try {
    const previous = await readDraft<{ token?: string }>(storage, PROBE_ACCOUNT_ID, PROBE_DRAFT_KEY);
    const restoredFrom = typeof previous?.body?.token === 'string' ? previous.body.token : null;
    const token = randomId();
    await saveDraft(storage, PROBE_ACCOUNT_ID, PROBE_DRAFT_KEY, { token, restoredFrom });
    const line: ProbeLogLine = {
      at: new Date().toISOString(),
      token,
      restoredFrom,
      restored: restoredFrom !== null,
      schemaVersion: await storage.schemaVersion(),
    };
    appendLogLine(line);
    console.log(`[storage-probe] ${JSON.stringify(line)}`);
  } finally {
    await storage.close();
  }
}

/**
 * Runs the probe when enabled; resolves always (failures are logged, never
 * thrown into navigation startup) and stays silent when the flag file is
 * absent so normal development sessions are unaffected.
 */
export async function runPersistenceProbeIfEnabled(): Promise<void> {
  let enabled = false;
  try {
    if (typeof __DEV__ !== 'undefined' && !__DEV__) return;
    const root = Paths.document;
    if (!root?.uri) return;
    if (!new File(root, PROBE_FLAG_FILE).exists) return;
    enabled = true;
    await runProbe();
  } catch (error) {
    if (!enabled) return;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[storage-probe] failed: ${message}`);
    try {
      appendLogLine({
        at: new Date().toISOString(),
        token: '',
        restoredFrom: null,
        restored: false,
        schemaVersion: -1,
        error: message,
      });
    } catch {
      // Nothing else we can do from a dev probe.
    }
  }
}
