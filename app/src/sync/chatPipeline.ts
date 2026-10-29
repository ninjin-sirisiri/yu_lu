import type { SupabaseClient } from '@supabase/supabase-js';
import { getAppClient } from '../backend/client';
import { randomId, safeSegment, type Storage } from '../storage/database';
import { createImageStore, expoFileSystemPort, type FileSystemPort, type ImageReference, type ImageStore } from '../storage/files';
import { getOperation, updateOperation, type OutboxPatch, type OutboxRecord } from '../storage/outbox';
import { readDeviceSetting } from '../storage/settings';
import { validateChatBody } from '../messages/text';
import { stripChatImageMetadata } from '../media/chatImageBytes';
import type { CommandApi, CommandOutcome } from './api';

export interface ChatSendApiDeps {
  storage: Storage;
  fs: FileSystemPort;
  store: ImageStore;
  getAccountId(): Promise<string | null>;
  now?: () => number;
  newPreparationId?: () => string;
  uploadImage(path: string, bytes: Uint8Array, contentType: string, beforeRequest: () => Promise<void>): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_STAGED_KEY = 'images_staged';
export const CHAT_PREPARED_KEY = 'chat_prepared';
export const CHAT_PREPARATION_ID_KEY = 'chat_preparation_id';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function invalid(): never { throw new Error('Chat preparation is invalid.'); }
class RevokedClaim extends Error {}

export interface PreparedChatMedia {
  media_id: string;
  image_order: number;
  sha256: string;
  mime_type: string;
  width: number;
  height: number;
  byte_size: number;
  final_path: string;
}

function references(value: unknown, accountId: string): ImageReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) invalid();
  return value.map(item => {
    const image = record(item);
    if (!image || image.accountId !== accountId || typeof image.imageId !== 'string' || !image.imageId ||
        typeof image.relativePath !== 'string' ||
        !image.relativePath.startsWith(`images/${safeSegment(accountId)}/`) ||
        !/^[A-Za-z0-9_-]+\.(png|jpe?g)$/.test(image.relativePath.split('/')[2] ?? '') ||
        image.relativePath.split('/').length !== 3 ||
        typeof image.bytes !== 'number' || !Number.isSafeInteger(image.bytes) || image.bytes <= 0 || image.bytes > MAX_BYTES) invalid();
    return image as unknown as ImageReference;
  });
}

function messageFields(payload: Record<string, unknown>, imageCount: number): Record<string, unknown> {
  if (!uuid(payload.recipient_id) || !uuid(payload.client_key) || !uuid(payload.friendship_epoch) ||
      typeof payload.body !== 'string') invalid();
  const body = validateChatBody(payload.body, imageCount);
  if (!body.ok) invalid();
  return { recipient_id: payload.recipient_id, client_key: payload.client_key,
    friendship_epoch: payload.friendship_epoch, body: body.value };
}

function sendPayload(payload: Record<string, unknown>, ids: unknown): Record<string, unknown> {
  if (!Array.isArray(ids) || ids.length > 4 || !ids.every(uuid) || new Set(ids).size !== ids.length) invalid();
  return { ...messageFields(payload, ids.length), media_ids: [...ids] };
}

function mediaResult(value: unknown, accountId: string, key: string, count: number): PreparedChatMedia[] {
  if (!Array.isArray(value) || value.length !== count) invalid();
  const result = value.map((item, i) => {
    const m = record(item);
    if (!m || !uuid(m.media_id) || m.image_order !== i || typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256) ||
        !['image/jpeg', 'image/png'].includes(String(m.mime_type)) ||
        ![m.width, m.height].every(n => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 2048) ||
        typeof m.byte_size !== 'number' || !Number.isSafeInteger(m.byte_size) || m.byte_size <= 0 || m.byte_size > MAX_BYTES ||
        m.final_path !== `${accountId}/${key}/${i}/${m.sha256}.${m.mime_type === 'image/png' ? 'png' : 'jpg'}`) invalid();
    return { media_id: m.media_id, image_order: i, sha256: m.sha256, mime_type: m.mime_type as string,
      width: m.width as number, height: m.height as number, byte_size: m.byte_size, final_path: m.final_path as string };
  });
  if (new Set(result.map(m => m.media_id)).size !== count) invalid();
  return result;
}

/** Durable preprocessing decorator. Only the actual send boundary may create
 * an unknown outcome. Every callback uses the worker's claim capability; no
 * draft/settings insert can resurrect a purged account. Local source fields
 * stay local, and a prepared payload is replayed byte-for-byte after restart. */
export function createChatSendApi(base: CommandApi, deps: ChatSendApiDeps): CommandApi {
  const now = deps.now ?? Date.now;
  return {
    async send(envelope): Promise<CommandOutcome> {
      if (envelope.kind !== 'send_message') return base.send(envelope);
      let requestStarted = false;
      async function checkpoint(patch?: OutboxPatch): Promise<OutboxRecord> {
        if (await deps.getAccountId() !== envelope.accountId) throw new RevokedClaim();
        return deps.storage.withWriteTransaction(async tx => {
          const row = await getOperation(tx, envelope.accountId, envelope.operationId);
          const pendingLogout = await readDeviceSetting(tx, 'logout.pending');
          if (!row || row.state !== 'sending' || row.claimGeneration !== envelope.claimGeneration ||
              (pendingLogout !== null && pendingLogout !== '')) throw new RevokedClaim();
          if ((row.reachStage === 'not_started' || row.reachStage === 'preparing') && now() >= row.expiresAt) {
            await updateOperation(tx, row.accountId, row.operationId,
              { state: 'needs_confirmation', reachStage: 'not_started', claimedAt: null, nextAttemptAt: null },
              { expectState: 'sending', expectClaimGeneration: envelope.claimGeneration });
            // Do not throw inside the transaction: the expiry must commit.
            return { ...row, state: 'needs_confirmation' };
          }
          if (patch && !await updateOperation(tx, row.accountId, row.operationId, patch,
            { expectState: 'sending', expectClaimGeneration: envelope.claimGeneration })) throw new RevokedClaim();
          return row;
        }).then(row => { if (row.state !== 'sending') throw new RevokedClaim(); return row; });
      }
      try {
        const row = await checkpoint();
        const payload = record(row.payload);
        if (!payload) invalid();
        const refs = references(payload[CHAT_STAGED_KEY], envelope.accountId);
        let prepared = record(payload[CHAT_PREPARED_KEY]);
        let wire: Record<string, unknown>;
        if (prepared) {
          const storedWire = record(prepared.send_payload);
          if (prepared.operation_id !== envelope.operationId || !storedWire) invalid();
          wire = sendPayload(payload, storedWire.media_ids);
          if (JSON.stringify(wire) !== JSON.stringify(storedWire)) invalid();
          const media = mediaResult(prepared.media, envelope.accountId, wire.client_key as string, refs.length);
          if (refs.length && JSON.stringify(media.map(m => m.media_id)) !== JSON.stringify(wire.media_ids)) invalid();
        } else {
          // No persisted payload means there is nothing safe to replay for a
          // legacy unknown request. In particular, never rebuild it after expiry.
          if (row.reachStage === 'request_started' || row.reachStage === null) return { status: 'unknown' };
          // Validate the body with the whole intended batch, never truncate.
          messageFields(payload, refs.length || (Array.isArray(payload.media_ids) ? payload.media_ids.length : 0));
          let media: PreparedChatMedia[] = [];
          if (refs.length) {
            const preparationId = payload[CHAT_PREPARATION_ID_KEY] ?? (deps.newPreparationId ?? randomId)();
            if (!uuid(preparationId)) invalid();
            payload[CHAT_PREPARATION_ID_KEY] = preparationId;
            await checkpoint({ payload });
            const staging: { staging_path: string }[] = [];
            for (const [i, ref] of refs.entries()) {
              await checkpoint();
              const bytes = deps.fs.readBytes(deps.store.resolvePath(ref));
              if (bytes.length !== ref.bytes) invalid();
              const format = ref.relativePath.endsWith('.png') ? 'png' : 'jpeg';
              const clean = stripChatImageMetadata(bytes, format).bytes;
              // Task13 already scrubbed these bytes. Never silently mutate a
              // queued source (or upload metadata from a tampered local file).
              if (clean.length !== bytes.length || clean.some((b, j) => b !== bytes[j])) invalid();
              const stagingPath = `${envelope.accountId}/${payload.client_key}/${i}.${format === 'png' ? 'png' : 'jpg'}`;
              await checkpoint();
              await deps.uploadImage(stagingPath, bytes, `image/${format}`, async () => { await checkpoint(); });
              await checkpoint();
              staging.push({ staging_path: stagingPath });
            }
            await checkpoint();
            const outcome = await base.send({ accountId: envelope.accountId, operationId: preparationId,
              kind: 'prepare_chat_media', payload: { client_key: payload.client_key, images: staging },
              async beforeRequest() { await checkpoint(); },
            });
            await checkpoint();
            if (outcome.status !== 'ok') return outcome.status === 'rejected' || outcome.status === 'conflict'
              ? outcome : { status: 'transient', message: 'Image preparation unavailable.' };
            media = mediaResult(record(outcome.data?.result)?.media, envelope.accountId, payload.client_key as string, refs.length);
          }
          wire = sendPayload(payload, refs.length ? media.map(m => m.media_id) : payload.media_ids ?? []);
          prepared = { operation_id: envelope.operationId, media, send_payload: wire };
          payload[CHAT_PREPARED_KEY] = prepared;
          await checkpoint({ payload });
        }
        await checkpoint();
        const outcome = await base.send({ ...envelope, payload: JSON.parse(JSON.stringify(wire)),
          async beforeRequest() {
            await checkpoint({ reachStage: 'request_started' });
            requestStarted = true;
          },
        });
        // A receipt from a different client_key cannot release FIFO.
        if (outcome.status === 'ok' && record(outcome.data?.result)?.client_key !== wire.client_key) return { status: 'unknown' };
        if (outcome.status === 'transient' && requestStarted) return { status: 'unknown', message: outcome.message };
        if (outcome.status === 'ok' && !requestStarted) return { status: 'unknown' };
        return outcome;
      } catch (error) {
        return { status: requestStarted ? 'unknown' : 'transient',
          message: error instanceof RevokedClaim ? 'Chat claim is no longer active.' : 'Chat preparation or delivery unavailable.' };
      }
    },
  };
}

/** Same signed-in singleton as other commands; staging grants no recipient
 * access. Recheck identity immediately before each platform upload. */
export function createDeviceChatSendApi(base: CommandApi, storage: Storage, client?: SupabaseClient): CommandApi {
  const currentClient = () => client ?? getAppClient();
  return createChatSendApi(base, { storage, fs: expoFileSystemPort, store: createImageStore({ fs: expoFileSystemPort }),
    async getAccountId() {
      const { data } = await currentClient().auth.getSession();
      return data.session?.user.id ?? null;
    },
    async uploadImage(path, bytes, contentType, beforeRequest) {
      const c = currentClient();
      const { data } = await c.auth.getSession();
      if (!data.session?.access_token || !path.startsWith(`${data.session.user.id}/`)) throw new RevokedClaim();
      const authorization = `Bearer ${data.session.access_token}`;
      await beforeRequest();
      const { error } = await c.storage.from('chat-staging').upload(path, bytes,
        { contentType, upsert: true, headers: { Authorization: authorization } });
      if (error) throw new Error('Image upload unavailable.');
    },
  });
}
