import * as SecureStore from 'expo-secure-store';
import { randomId, safeSegment, utf8ByteLength, StorageError } from './database';

/**
 * Credential storage backed by expo-secure-store (Keychain / Keystore).
 *
 * The platform refuses large values — some iOS releases reject anything above
 * roughly 2048 bytes — while Supabase session objects easily exceed that. The
 * chunked adapter therefore splits oversized values into byte-bounded pieces
 * under write-unique keys and records a manifest at the logical key; reading
 * reassembles and verifies the pieces, so a session larger than the platform
 * limit still restores exactly.
 */

export interface SecretBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** expo-secure-store as the production backend. */
export const secureStoreBackend: SecretBackend = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};

/**
 * SecureStore accepts only alphanumeric characters plus `.`, `-` and `_`.
 * Builds a safe key such as `session.<accountId>`.
 */
export function secureKey(...parts: string[]): string {
  return parts.map((part) => safeSegment(part)).join('.');
}

/**
 * Chunk size kept below the smallest documented iOS Keychain value limit
 * (~2048 bytes), leaving room for keychain bookkeeping.
 */
export const DEFAULT_MAX_CHUNK_BYTES = 1024;

export class ChunkedSecretError extends StorageError {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkedSecretError';
  }
}

interface SecretManifest {
  v: 1;
  id: string;
  chunks: number;
  bytes: number;
}

function isManifest(value: unknown): value is SecretManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SecretManifest>;
  return (
    candidate.v === 1 &&
    typeof candidate.id === 'string' &&
    typeof candidate.chunks === 'number' &&
    typeof candidate.bytes === 'number'
  );
}

/** Splits a string so no piece exceeds `maxBytes` UTF-8 bytes (never splits a surrogate pair). */
export function splitUtf8Bytes(value: string, maxBytes: number): string[] {
  if (maxBytes < 1) {
    throw new ChunkedSecretError('maxBytes must be at least 1');
  }
  const pieces: string[] = [];
  let current = '';
  let currentBytes = 0;
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    let pieceLength = 1;
    let pieceBytes: number;
    if (code < 0x80) pieceBytes = 1;
    else if (code < 0x800) pieceBytes = 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        pieceLength = 2;
        pieceBytes = 4;
      } else {
        pieceBytes = 3;
      }
    } else pieceBytes = 3;
    if (currentBytes + pieceBytes > maxBytes && current.length > 0) {
      pieces.push(current);
      current = '';
      currentBytes = 0;
    }
    current += value.slice(index, index + pieceLength);
    currentBytes += pieceBytes;
    index += pieceLength;
  }
  if (current.length > 0 || pieces.length === 0) {
    pieces.push(current);
  }
  return pieces;
}

export interface ChunkedSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface CreateChunkedSecretsOptions {
  backend?: SecretBackend;
  /** Upper UTF-8 byte size of one stored piece. */
  maxChunkBytes?: number;
  newId?: () => string;
}

/**
 * Splits values across several SecureStore entries when they exceed
 * `maxChunkBytes`. Each write uses fresh piece keys and publishes the manifest
 * last, so an interrupted write leaves the previous value readable instead of
 * a half-written one; stale pieces of the previous write are then cleaned up.
 */
export function createChunkedSecrets(
  options: CreateChunkedSecretsOptions = {},
): ChunkedSecretStore {
  const backend = options.backend ?? secureStoreBackend;
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  const newId = options.newId ?? randomId;

  async function get(key: string): Promise<string | null> {
    const raw = await backend.getItem(key);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not a manifest: a plain value stored by an earlier writer.
      return raw;
    }
    if (!isManifest(parsed)) return raw;
    const pieces: string[] = [];
    let totalBytes = 0;
    for (let index = 0; index < parsed.chunks; index += 1) {
      const piece = await backend.getItem(`${key}.${parsed.id}.${index}`);
      if (piece === null) {
        throw new ChunkedSecretError(`secret ${key} is missing chunk ${index}`);
      }
      pieces.push(piece);
      totalBytes += utf8ByteLength(piece);
    }
    const joined = pieces.join('');
    if (totalBytes !== parsed.bytes) {
      throw new ChunkedSecretError(
        `secret ${key} is corrupt: expected ${parsed.bytes} bytes, read ${totalBytes}`,
      );
    }
    return joined;
  }

  async function set(key: string, value: string): Promise<void> {
    const id = newId();
    const pieces = splitUtf8Bytes(value, maxChunkBytes);
    // Pieces first: until the manifest below is replaced, readers still see
    // the previous complete value.
    for (let index = 0; index < pieces.length; index += 1) {
      await backend.setItem(`${key}.${id}.${index}`, pieces[index]);
    }
    const previous = await readManifest(await backend.getItem(key));
    const manifest: SecretManifest = {
      v: 1,
      id,
      chunks: pieces.length,
      bytes: utf8ByteLength(value),
    };
    await backend.setItem(key, JSON.stringify(manifest));
    if (previous && previous.id !== id) {
      for (let index = 0; index < previous.chunks; index += 1) {
        try {
          await backend.removeItem(`${key}.${previous.id}.${index}`);
        } catch {
          // Leftover pieces are unreadable once the manifest moved on;
          // cleanup failure must not fail the write.
        }
      }
    }
  }

  async function remove(key: string): Promise<void> {
    const manifest = readManifest(await backend.getItem(key));
    if (manifest) {
      for (let index = 0; index < manifest.chunks; index += 1) {
        try {
          await backend.removeItem(`${key}.${manifest.id}.${index}`);
        } catch {
          // Best effort: the manifest below already hides the pieces.
        }
      }
    }
    await backend.removeItem(key);
  }

  return { get, set, remove };
}

function readManifest(raw: string | null): SecretManifest | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
