import type { Cue } from "./timing";

export type Line = {
  id: string;
  text: string;
  headline: string;
  visual: string;
  screen?: string;
  from: number;
  audioFrom: number;
  audioFrames: number;
  durationInFrames: number;
  audio: string;
};
export type Scene = {
  id: string;
  title: string;
  chapter: string;
  durationInFrames: number;
  lines: Line[];
  cues: Cue[];
};
export type Timeline = {
  durationInFrames: number;
  seconds: number;
  voiceCredit: string;
  scenes: Scene[];
};
