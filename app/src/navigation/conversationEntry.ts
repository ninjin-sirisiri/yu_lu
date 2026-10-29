const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type ConversationOrigin = 'home' | 'chat' | 'profile';
function origin(value: unknown): ConversationOrigin {
  return value === 'home' || value === 'profile' ? value : 'chat';
}
export function parseConversationEntry(params: { peerId?: unknown; origin?: unknown }) {
  if (typeof params.peerId !== 'string' || !UUID.test(params.peerId)) return null;
  return { peerId: params.peerId, origin: origin(params.origin) };
}
export function conversationEntry(peerId: string, from: ConversationOrigin) {
  if (!UUID.test(peerId)) throw new Error('Invalid conversation peer.');
  return { pathname: '/conversations/[peerId]' as const, params: { peerId, origin: origin(from) } };
}
export function conversationFallback(peerId: string, from: unknown): string {
  return origin(from) === 'home' ? '/home' : origin(from) === 'profile' && UUID.test(peerId) ? `/friends/${peerId}` : '/chat';
}
export function isConversationDestination(path: string): boolean {
  const match = /^\/conversations\/([^/?#]+)(?:\?origin=(home|chat|profile))?$/.exec(path);
  return !!match && UUID.test(match[1]);
}
