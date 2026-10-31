import { latestCue } from "./timing";
import type { Scene } from "./types";

export type Actor = "self" | "friend-a" | "friend-b";
export type Flow = {
  from: Actor;
  to: Actor;
  at: number;
  kind: "send" | "receive";
};

/** Distinct identities and directed routes change on spoken cues. */
export function storyState(scene: Scene, frame: number) {
  const cue = latestCue(
    scene,
    ["approved", "outgoing", "send", "reply", "free"],
    frame,
  );
  const phase =
    cue?.id === "reply"
      ? "receive"
      : cue?.id === "free"
        ? "free"
        : cue?.id === "send"
          ? "send"
          : cue?.id === "outgoing"
            ? "choose"
            : "friends";
  const outgoing =
    scene.cues.find(
      (c) => c.id === (phase === "choose" ? "outgoing" : "send"),
    ) ?? scene.cues.find((c) => c.id === "outgoing");
  const incoming = scene.cues.find((c) => c.id === "reply");
  const flows: Flow[] = [];
  if (["choose", "send", "receive"].includes(phase)) {
    flows.push({
      from: "self",
      to: "friend-a",
      at: outgoing?.frame ?? 0,
      kind: "send",
    });
  }
  if (phase === "receive")
    flows.push({
      from: "friend-b",
      to: "self",
      at: incoming?.frame ?? 0,
      kind: "receive",
    });
  return {
    phase,
    actors: ["friend-b", "self", "friend-a"] as Actor[],
    flows,
  };
}

export const cueAt = (scene: Scene, id: string): number =>
  scene.cues.find((c) => c.id === id)?.frame ?? Number.MAX_SAFE_INTEGER;
