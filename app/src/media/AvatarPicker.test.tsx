import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { openAppDatabase, type AppStorage } from '../storage/database';
import { saveAvatarDraft } from './avatar';
import {
  createImageStore,
  type FileSystemPort,
  type ImageReference,
  type ImageStore,
} from '../storage/files';
import { NodeSqliteDriver, createNodeFileSystemPort } from '../storage/testSupport/nodePorts';
import { ThemeProvider } from '../theme/provider';
import { AvatarPicker } from './AvatarPicker';

// Task 16: AvatarPicker wiring tests. MOCKED-LAYER: the OS image picker
// (native UI). REAL: SQLite drafts, the file system and the ImageStore.
// The native image stages never run here — validation and cancel/delete are
// decided before any stage, which is exactly what these tests pin down.

let mockLaunchLibrary: jest.Mock;
let mockLaunchCamera: jest.Mock;
let mockRequestCamera: jest.Mock;

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchLibrary(...args),
  launchCameraAsync: (...args: unknown[]) => mockLaunchCamera(...args),
  requestCameraPermissionsAsync: (...args: unknown[]) => mockRequestCamera(...args),
}));

interface Harness {
  root: string;
  db: AppStorage;
  fs: FileSystemPort;
  store: ImageStore;
  sourcePath: string;
  cleanup(): Promise<void>;
}

const ACCOUNT = 'picker_tester';

async function createHarness(): Promise<Harness> {
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'avatar-picker-'));
  const documentRoot = path.join(root, 'Documents');
  nodeFs.mkdirSync(documentRoot, { recursive: true });
  const fsPort = createNodeFileSystemPort(documentRoot);
  const db = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(root, 'app.db')) });
  const sourcePath = path.join(root, 'picked.png');
  nodeFs.writeFileSync(sourcePath, 'picked-bytes');
  let seq = 0;
  const store = createImageStore({ fs: fsPort, newId: () => `img-${(seq += 1)}` });
  return {
    root,
    db,
    fs: fsPort,
    store,
    sourcePath,
    async cleanup() {
      try {
        await db.close();
      } catch {
        // Already closed.
      }
      nodeFs.rmSync(root, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
let changes: Array<ImageReference | null>;

beforeEach(async () => {
  harness = await createHarness();
  changes = [];
  mockLaunchLibrary = jest.fn();
  mockLaunchCamera = jest.fn();
  mockRequestCamera = jest.fn().mockResolvedValue({ granted: true, status: 'granted' });
});

afterEach(async () => {
  await harness.cleanup();
});

function renderPicker() {
  return render(
    <ThemeProvider>
      <AvatarPicker
        accountId={ACCOUNT}
        db={harness.db}
        store={harness.store}
        fs={harness.fs}
        onChange={(reference) => changes.push(reference)}
      />
    </ThemeProvider>,
  );
}

async function seedDraftImage(): Promise<ImageReference> {
  const reference = await harness.store.importImage(ACCOUNT, harness.sourcePath, {
    extension: 'png',
    newId: () => 'staged',
  });
  await saveAvatarDraft(harness.db, ACCOUNT, reference);
  return reference;
}

describe('AvatarPicker', () => {
  it('shows the labeled controls and keeps 削除 disabled while nothing is staged', async () => {
    const view = await renderPicker();

    expect(view.getByText('プロフィール画像')).toBeTruthy();
    expect(view.getByTestId('avatar-preview-empty')).toBeTruthy();
    expect(view.getByTestId('avatar-camera').props.accessibilityState?.disabled).toBe(false);
    expect(view.getByTestId('avatar-remove').props.accessibilityState?.disabled).toBe(true);
  });

  it('restores a staged draft and enables 削除', async () => {
    const staged = await seedDraftImage();
    const view = await renderPicker();

    await waitFor(() => {
      expect(view.getByTestId('avatar-remove').props.accessibilityState?.disabled).toBe(false);
    });
    expect(view.getByTestId('avatar-preview').props.source.uri).toBe(
      harness.store.resolvePath(staged),
    );
  });

  it('treats the OS cancel as no-op: no error, no draft change, no callback', async () => {
    const staged = await seedDraftImage();
    mockLaunchLibrary.mockResolvedValue({ canceled: true, assets: null });
    const view = await renderPicker();
    await waitFor(() => {
      expect(view.getByTestId('avatar-remove').props.accessibilityState?.disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.press(view.getByTestId('avatar-library'));
    });

    expect(mockLaunchLibrary).toHaveBeenCalledTimes(1);
    expect(view.queryByTestId('avatar-error')).toBeNull();
    expect(changes).toEqual([]);
    const draft = await harness.db.getFirstAsync<{ body: string }>(
      'SELECT body FROM drafts WHERE account_id = ? AND draft_key = ?',
      [ACCOUNT, 'profile.avatar'],
    );
    expect(draft?.body).toContain(staged.imageId);
    expect(nodeFs.existsSync(harness.store.resolvePath(staged))).toBe(true);
  });

  it('explains a denied camera permission and never opens the camera', async () => {
    mockRequestCamera.mockResolvedValue({ granted: false, status: 'denied' });
    const view = await renderPicker();

    await act(async () => {
      fireEvent.press(view.getByTestId('avatar-camera'));
    });

    const error = await view.findByText(/カメラが許可されていない/);
    expect(error).toBeTruthy();
    expect(mockLaunchCamera).not.toHaveBeenCalled();
  });

  it('surfaces the format rejection message and leaves the draft alone', async () => {
    const staged = await seedDraftImage();
    mockLaunchLibrary.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/anim.gif', mimeType: 'image/gif', fileName: 'anim.gif', fileSize: 512 }],
    });
    const view = await renderPicker();
    await waitFor(() => {
      expect(view.getByTestId('avatar-remove').props.accessibilityState?.disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.press(view.getByTestId('avatar-library'));
    });

    const error = await view.findByText(/JPEG・PNG・HEIC形式の画像を選べます/);
    expect(error).toBeTruthy();
    expect(changes).toEqual([]);
    const draft = await harness.db.getFirstAsync<{ body: string }>(
      'SELECT body FROM drafts WHERE account_id = ? AND draft_key = ?',
      [ACCOUNT, 'profile.avatar'],
    );
    expect(draft?.body).toContain(staged.imageId);
  });

  it('deletes only the staged image on 削除 press', async () => {
    const published = await harness.store.importImage(ACCOUNT, harness.sourcePath, {
      extension: 'png',
      newId: () => 'published',
    });
    const staged = await seedDraftImage();
    const view = await renderPicker();
    await waitFor(() => {
      expect(view.getByTestId('avatar-remove').props.accessibilityState?.disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.press(view.getByTestId('avatar-remove'));
    });

    expect(changes).toEqual([null]);
    expect(nodeFs.existsSync(harness.store.resolvePath(staged))).toBe(false);
    expect(nodeFs.existsSync(harness.store.resolvePath(published))).toBe(true);
    await waitFor(() => {
      expect(view.getByTestId('avatar-remove').props.accessibilityState?.disabled).toBe(true);
    });
  });
});
