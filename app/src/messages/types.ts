import type { ImageReference } from '../storage/files';

/** Local DTO of a server receipt. Keep acceptedAt as the server's ISO string
 * (including microseconds); sequence, not local time, orders confirmed history. */
export interface MessageReceipt {
  messageId: string;
  conversationId: string;
  sequence: number;
  acceptedAt: string;
}

export interface AcceptedMessage extends MessageReceipt {
  accountId: string;
  peerId: string;
  senderId: string;
  recipientId: string;
  clientKey: string;
  withdrawn: boolean;
  body: string | null;
  /** Authorized remote paths, never temporary download URLs. */
  imagePaths: string[];
}

/** Exactly one current composer per account/peer, separate from outbox rows,
 * including cancelled ones. Attachments must already exist in ImageStore. */
export interface ChatDraft {
  accountId: string;
  peerId: string;
  body: string;
  attachments: ImageReference[];
  updatedAt: number;
}

/** Immutable captured read bound. Normal visibility uses messageIds and a null
 * throughSequence; explicit latest navigation may use the fetched sequence.
 * Retrying an intent must never widen it to include a subsequent arrival. */
export interface ChatReadIntent {
  accountId: string;
  intentId: string;
  peerId: string;
  conversationId: string;
  messageIds: string[];
  throughSequence: number | null;
  createdAt: number;
}

export type AttachmentOwner = 'draft' | 'outbox' | 'message';

/** Viewing copies only. Draft/outbox references are independently protected;
 * the media task owns the 100MiB LRU eviction policy, not this storage module. */
export interface ChatImageCacheEntry {
  accountId: string;
  remotePath: string;
  image: ImageReference;
  lastAccessedAt: number;
}

/** Null in an outbox row means no stage evidence (including migrated rows).
 * Storage never infers delivery from a legacy state or performs transitions. */
export type MessageReachStage = 'not_started' | 'preparing' | 'request_started' | 'accepted' | 'rejected';
