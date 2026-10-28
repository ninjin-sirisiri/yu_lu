// Account lifetimes, not reusable singletons. Logout calls this synchronously
// before its first await/mutation; a fresh login must register a fresh owner.
const owners = new Map<string, Set<() => void>>();

export function registerChatLifetime(accountId: string, stop: () => void): () => void {
  const stops = owners.get(accountId) ?? new Set();
  stops.add(stop); owners.set(accountId, stops);
  return () => {
    stops.delete(stop);
    if (!stops.size) owners.delete(accountId);
  };
}

export function stopAccountChat(accountId: string): void {
  for (const stop of [...owners.get(accountId) ?? []]) stop();
}
