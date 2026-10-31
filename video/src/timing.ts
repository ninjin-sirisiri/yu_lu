export type Cue = { id: string; frame: number; lineId?: string };
type TimedLine = { from: number; durationInFrames: number; visual: string };
type TimedScene<L extends TimedLine> = { lines: L[]; cues: Cue[] };

export const activeLine = <L extends TimedLine>(
  scene: TimedScene<L>,
  frame: number,
): L =>
  [...scene.lines].reverse().find((line) => frame >= line.from) ??
  scene.lines[0];

export const latestCue = <L extends TimedLine>(
  scene: TimedScene<L>,
  ids: readonly string[],
  frame: number,
): Cue | undefined =>
  [...scene.cues]
    .reverse()
    .find((cue) => ids.includes(cue.id) && frame >= cue.frame);
