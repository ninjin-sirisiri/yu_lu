import { Directory, File, Paths } from 'expo-file-system';
import { randomId, requireNonEmpty, safeSegment } from './database';

/**
 * Image storage. The primitive copies an image into the app's persistent
 * (document) directory and only then returns a reference: the file is staged
 * under a temporary name, its size is verified, and it is moved into its final
 * location before anything can point at it. A failure at any step removes the
 * staged file and throws — no partial file and no reference ever exist, so a
 * broken reference can never be published (画像失敗時に文字だけ先に公開しない).
 *
 * References are stored as paths relative to the document root, which keeps
 * SQLite rows valid if the container path changes between installs; use
 * {@link ImageStore.resolvePath} to display them.
 */

/** File-system operations the image store needs; node implementation used in tests. */
export interface FileSystemPort {
  readonly documentRoot: string;
  join(...segments: string[]): string;
  ensureDirectory(path: string): void;
  exists(path: string): boolean;
  size(path: string): number;
  copyFile(from: string, to: string): Promise<void>;
  moveFile(from: string, to: string): Promise<void>;
  /** Deletes a single file. Throws on real failures, no-op when absent. */
  removeFile(path: string): void;
  /** Deletes a directory and its contents. Throws on real failures, no-op when absent. */
  removeDirectory(path: string): void;
  /**
   * Creates/overwrites `path` with `contents` (UTF-8 text by default, or raw
   * base64 bytes). Used by the avatar pipeline to persist the base64 PNG that
   * the SVG white-composite step renders, before it is encoded to JPEG.
   */
  writeFile(path: string, contents: string, encoding?: 'utf8' | 'base64'): void;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** expo-file-system implementation for device builds. */
export const expoFileSystemPort: FileSystemPort = {
  get documentRoot(): string {
    return Paths.document.uri;
  },
  join(...segments: string[]): string {
    const [root, ...rest] = segments;
    return [stripTrailingSlash(root), ...rest.map((part) => part.replace(/^\/+/, ''))].join('/');
  },
  ensureDirectory(path: string): void {
    const directory = new Directory(path);
    if (!directory.exists) {
      directory.create({ idempotent: true, intermediates: true });
    }
  },
  exists(path: string): boolean {
    // `new File(path)` throws when the path is an existing directory, so fall
    // back to a Directory probe to support both files and directories.
    try {
      if (new File(path).exists) return true;
    } catch {
      // Path exists as a directory (wrong class) or is unreadable as a file.
    }
    try {
      return new Directory(path).exists;
    } catch {
      return false;
    }
  },
  size(path: string): number {
    try {
      return new File(path).size;
    } catch {
      return 0;
    }
  },
  async copyFile(from: string, to: string): Promise<void> {
    await new File(from).copy(new File(to));
  },
  async moveFile(from: string, to: string): Promise<void> {
    await new File(from).move(new File(to));
  },
  removeFile(path: string): void {
    const file = new File(path);
    if (file.exists) file.delete();
  },
  removeDirectory(path: string): void {
    const directory = new Directory(path);
    if (directory.exists) directory.delete();
  },
  writeFile(path: string, contents: string, encoding: 'utf8' | 'base64' = 'utf8'): void {
    const file = new File(path);
    if (!file.exists) file.create({ intermediates: true });
    file.write(contents, { encoding });
  },
};

export class ImageImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageImportError';
  }
}

export interface ImageReference {
  accountId: string;
  imageId: string;
  /** Path relative to the document root; safe to persist. */
  relativePath: string;
  bytes: number;
}

export interface ImportImageOptions {
  /** Extension without the dot; defaults to the source's extension, else `bin`. */
  extension?: string;
  newId?: () => string;
}

export interface ImageStore {
  /**
   * Copies `sourcePath` into persistent storage and returns its reference.
   * The promise rejects with {@link ImageImportError} and leaves no partial
   * file behind when the copy fails or is truncated.
   */
  importImage(
    accountId: string,
    sourcePath: string,
    options?: ImportImageOptions,
  ): Promise<ImageReference>;
  /** Absolute path (file URI on devices) for a stored reference. */
  resolvePath(reference: ImageReference): string;
  removeImage(reference: ImageReference): Promise<void>;
  removeAccountImages(accountId: string): Promise<void>;
  /** Removes staged leftovers of previously failed imports. */
  clearStaging(): void;
}

export interface CreateImageStoreOptions {
  fs: FileSystemPort;
  newId?: () => string;
}

const STAGING_DIRECTORY = ['images', '.staging'] as const;

function extensionOf(sourcePath: string): string {
  const lastSlash = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'));
  const name = sourcePath.slice(lastSlash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'bin';
  return name.slice(dot + 1).toLowerCase();
}

function normalizeExtension(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return cleaned.length > 0 ? cleaned : 'bin';
}

export function createImageStore(options: CreateImageStoreOptions): ImageStore {
  const fs = options.fs;
  const newId = options.newId ?? randomId;
  const stagingDirectory = fs.join(fs.documentRoot, ...STAGING_DIRECTORY);

  function accountDirectory(accountId: string): string {
    return fs.join(fs.documentRoot, 'images', safeSegment(accountId));
  }

  return {
    async importImage(accountId, sourcePath, importOptions = {}) {
      requireNonEmpty('accountId', accountId);
      requireNonEmpty('sourcePath', sourcePath);
      const imageId = (importOptions.newId ?? newId)();
      const extension = normalizeExtension(importOptions.extension ?? extensionOf(sourcePath));
      const stagingPath = fs.join(stagingDirectory, `${imageId}.part`);
      const finalPath = fs.join(accountDirectory(accountId), `${imageId}.${extension}`);
      let movedIntoPlace = false;
      try {
        fs.ensureDirectory(stagingDirectory);
        await fs.copyFile(sourcePath, stagingPath);
        const sourceSize = fs.size(sourcePath);
        const stagedSize = fs.size(stagingPath);
        if (stagedSize <= 0) {
          throw new ImageImportError('copied file is empty');
        }
        if (sourceSize > 0 && stagedSize !== sourceSize) {
          throw new ImageImportError(
            `copied file is truncated (${stagedSize} of ${sourceSize} bytes)`,
          );
        }
        fs.ensureDirectory(accountDirectory(accountId));
        await fs.moveFile(stagingPath, finalPath);
        movedIntoPlace = true;
        const finalSize = fs.size(finalPath);
        if (finalSize !== stagedSize) {
          throw new ImageImportError(
            `file lost data while moving into place (${finalSize} of ${stagedSize} bytes)`,
          );
        }
        return {
          accountId,
          imageId,
          relativePath: `images/${safeSegment(accountId)}/${imageId}.${extension}`,
          bytes: finalSize,
        };
      } catch (error) {
        // Never leave a partial file behind: an incomplete copy must not be
        // referencable.
        try {
          if (fs.exists(stagingPath)) fs.removeFile(stagingPath);
        } catch {
          // Staging is rebuilt on the next import; ignore cleanup failures.
        }
        if (movedIntoPlace) {
          try {
            if (fs.exists(finalPath)) fs.removeFile(finalPath);
          } catch {
            // Same as above: best effort.
          }
        }
        if (error instanceof ImageImportError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new ImageImportError(`failed to copy image into storage: ${message}`);
      }
    },

    resolvePath(reference) {
      requireNonEmpty('relativePath', reference.relativePath);
      return fs.join(fs.documentRoot, reference.relativePath);
    },

    async removeImage(reference) {
      requireNonEmpty('relativePath', reference.relativePath);
      const path = fs.join(fs.documentRoot, reference.relativePath);
      if (fs.exists(path)) fs.removeFile(path);
    },

    async removeAccountImages(accountId) {
      requireNonEmpty('accountId', accountId);
      const directory = accountDirectory(accountId);
      if (fs.exists(directory)) fs.removeDirectory(directory);
    },

    clearStaging() {
      if (fs.exists(stagingDirectory)) fs.removeDirectory(stagingDirectory);
    },
  };
}
