// No localEnv import: this harness must never read/write app/.env or discover
// the normal stack. The dedicated runner supplies only public config + actors.
export interface ChatJourneyEnv {
  project: 'daily-chat-home-chat-test'; url: string; anonKey: string;
  a: { id: string; token: string }; b: { id: string; token: string };
}

export function validateChatEnv(value: unknown): ChatJourneyEnv {
  const config = value as Partial<ChatJourneyEnv> | undefined;
  if (config?.project !== 'daily-chat-home-chat-test' || config.url !== 'http://127.0.0.1:55321' ||
      !config.anonKey?.trim() || !config.a?.id || !config.a.token || !config.b?.id || !config.b.token) {
    throw new Error('Missing or unsafe dedicated chat journey configuration; run scripts/test-chat-backend.mjs --suite journey.');
  }
  return config as ChatJourneyEnv;
}

export function readChatEnv(): ChatJourneyEnv {
  let config: unknown;
  try { config = JSON.parse(process.env.CHAT_JOURNEY_CONFIG ?? 'null'); }
  catch { throw new Error('Invalid dedicated chat journey configuration.'); }
  return validateChatEnv(config);
}

/** Owner fixture actions travel over the parent's private Node IPC channel.
 * No public RPC, arbitrary SQL, credential, clock, or actor injection endpoint. */
export async function relationshipFixture(action: 'end' | 'renew'): Promise<void> {
  // Jest provides a copied process EventEmitter in its VM; actual Node IPC
  // events are emitted on the outer process (same boundary as nodeFetch).
  const OuterFunction = process.nextTick.constructor as (code: string) => () => NodeJS.Process;
  const ownerProcess = OuterFunction('return process')();
  if (!ownerProcess.send) throw new Error('Dedicated fixture owner channel missing.');
  const id = `${Date.now()}:${Math.random()}`;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ownerProcess.off('message', onMessage); reject(new Error('Fixture owner timed out.')); }, 30_000);
    function onMessage(value: unknown) {
      const reply = value as { id?: string; ok?: boolean };
      if (reply?.id !== id) return;
      clearTimeout(timer); ownerProcess.off('message', onMessage);
      if (reply.ok) resolve(); else reject(new Error('Dedicated relationship fixture failed.'));
    }
    ownerProcess.on('message', onMessage);
    ownerProcess.send!({ type: 'chat-relationship-fixture', id, action });
  });
}
