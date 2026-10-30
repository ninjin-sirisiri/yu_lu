// No localEnv import: this harness must never read/write app/.env or discover
// the normal stack. The dedicated runner supplies only public config + actors.
export interface ChatJourneyEnv {
  project: 'daily-chat-home-chat-test'; url: string; anonKey: string;
  a: { id: string; token: string }; b: { id: string; token: string };
}

export interface AppearanceJourneyEnv {
  project: 'daily-chat-home-chat-test'; url: string; anonKey: string;
  a: { id: string; token: string }; b: { id: string; token: string };
  fourth: { id: string; token: string };
}

type Actor = { id: string; token: string };

function isActor(value: unknown): value is Actor {
  const actor = value as Partial<Actor> | undefined;
  return typeof actor?.id === 'string' && actor.id.length > 0 &&
    typeof actor.token === 'string' && actor.token.length > 0;
}

function dedicatedBase(config: Partial<AppearanceJourneyEnv> | undefined): boolean {
  return config?.project === 'daily-chat-home-chat-test' &&
    config.url === 'http://127.0.0.1:55321' &&
    typeof config.anonKey === 'string' && config.anonKey.trim().length > 0;
}

export function validateChatEnv(value: unknown): ChatJourneyEnv {
  const config = value as Partial<ChatJourneyEnv> | undefined;
  if (!dedicatedBase(config) || !isActor(config?.a) || !isActor(config?.b)) {
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

export function validateAppearanceEnv(value: unknown): AppearanceJourneyEnv {
  const config = value as Partial<AppearanceJourneyEnv> | undefined;
  if (!dedicatedBase(config) || !isActor(config?.a) || !isActor(config?.b) || !isActor(config?.fourth)) {
    throw new Error('Missing or unsafe dedicated appearance journey configuration; run scripts/test-chat-backend.mjs --suite appearance.');
  }
  return config as AppearanceJourneyEnv;
}

export function readAppearanceEnv(): AppearanceJourneyEnv {
  let config: unknown;
  try { config = JSON.parse(process.env.CHAT_APPEARANCE_CONFIG ?? 'null'); }
  catch { throw new Error('Invalid dedicated appearance journey configuration.'); }
  return validateAppearanceEnv(config);
}

export type AppearanceFixtureAction =
  | { action: 'seed-chat-growth'; days: number; preset?: 'b-pop' | 'b-candy' | 'b-soda' | null }
  | { action: 'seed-streak'; actor: 'a' | 'b' | 'fourth'; currentStreak: number; earnedDays: number }
  | { action: 'cleanup' };

/** Owner fixture actions travel over the parent's private Node IPC channel.
 * No public RPC, arbitrary SQL, credential, clock, or actor injection endpoint. */
async function fixtureRequest(message: Record<string, unknown>): Promise<unknown> {
  // Jest provides a copied process EventEmitter in its VM; actual Node IPC
  // events are emitted on the outer process (same boundary as nodeFetch).
  const OuterFunction = process.nextTick.constructor as (code: string) => () => NodeJS.Process;
  const ownerProcess = OuterFunction('return process')();
  if (!ownerProcess.send) throw new Error('Dedicated fixture owner channel missing.');
  const id = `${Date.now()}:${Math.random()}`;
  return await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => { ownerProcess.off('message', onMessage); reject(new Error('Fixture owner timed out.')); }, 45_000);
    function onMessage(value: unknown) {
      const reply = value as { id?: string; ok?: boolean; result?: unknown };
      if (reply?.id !== id) return;
      clearTimeout(timer); ownerProcess.off('message', onMessage);
      if (reply.ok) resolve(reply.result); else reject(new Error('Dedicated fixture action failed.'));
    }
    ownerProcess.on('message', onMessage);
    ownerProcess.send!({ ...message, id });
  });
}

export async function relationshipFixture(action: 'end' | 'renew'): Promise<void> {
  await fixtureRequest({ type: 'chat-relationship-fixture', action });
}

export async function appearanceFixture(request: AppearanceFixtureAction): Promise<unknown> {
  return await fixtureRequest({ type: 'appearance-fixture', ...request });
}
