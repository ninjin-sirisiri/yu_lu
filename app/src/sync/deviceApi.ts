import type { SupabaseClient } from '@supabase/supabase-js';
import type { Storage } from '../storage/database';
import { createDeviceProfileSendApi } from '../profiles/editor';
import { createCommandApi, type CommandApi } from './api';
import { createDeviceChatSendApi } from './chatPipeline';

/** Every device queue pump may claim any kind. Keep both preprocessing
 * decorators here so an unrelated foreground action cannot send local-only
 * chat/avatar fields through a raw command client. */
export function createDeviceSyncApi(storage: Storage, client?: SupabaseClient): CommandApi {
  const base = createCommandApi(client ? { client } : {});
  return createDeviceChatSendApi(createDeviceProfileSendApi(base, storage), storage, client);
}
