import { Audio } from "@remotion/media";
import { TransitionSeries } from "@remotion/transitions";
import {
  AbsoluteFill,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import rawTimeline from "./generated/timeline.json";
import { Captions } from "./generated/Captions";
import type { Scene, Timeline } from "./types";
import { AssignmentBoard } from "./visuals/Assignment";
import { ChapterHeader, clamp, type VisualProps } from "./visuals/elements";
import {
  Opening,
  Problem,
  Screens,
  Outlook,
  Closing,
} from "./visuals/Narratives";
import { Growth, Streak } from "./visuals/Progress";
import { Reliability, Architecture } from "./visuals/Engineering";
import "./styles.css";

export const timeline = rawTimeline as Timeline;

const Background = ({ dark }: { dark: boolean }) => (
  <AbsoluteFill
    style={{ overflow: "hidden", pointerEvents: "none" }}
    aria-hidden="true"
  >
    <div
      style={{
        position: "absolute",
        width: 920,
        height: 920,
        borderRadius: "50%",
        background: dark ? "#40284e" : "var(--yellow)",
        right: -410,
        top: -400,
      }}
    />
    <div
      style={{
        position: "absolute",
        width: 32,
        height: 32,
        borderRadius: "50%",
        background: "var(--pink)",
        right: 100,
        top: 100,
      }}
    />
    <div
      style={{
        position: "absolute",
        width: 12,
        height: 12,
        borderRadius: "50%",
        background: dark ? "var(--yellow)" : "var(--plum)",
        left: 70,
        bottom: 180,
      }}
    />
  </AbsoluteFill>
);

const ChapterVisual = (props: VisualProps) => {
  switch (props.scene.id) {
    case "opening":
      return <Opening {...props} />;
    case "problem":
      return <Problem {...props} />;
    case "concept":
      return <AssignmentBoard {...props} />;
    case "screens":
      return <Screens {...props} />;
    case "growth":
      return <Growth {...props} />;
    case "streak":
      return <Streak {...props} />;
    case "reliability":
      return <Reliability {...props} />;
    case "architecture":
      return <Architecture {...props} />;
    case "outlook":
      return <Outlook {...props} />;
    case "closing":
      return <Closing {...props} credit={timeline.voiceCredit} />;
    default:
      throw new Error(`Missing chapter visual: ${props.scene.id}`);
  }
};

const Shot = ({ scene }: { scene: Scene }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dark = scene.id === "reliability" || scene.id === "architecture";
  return (
    <AbsoluteFill
      className={dark ? "dark" : undefined}
      data-shot={scene.id}
      style={{
        opacity: interpolate(
          frame,
          [
            0,
            fps * 0.2,
            scene.durationInFrames - fps * 0.2,
            scene.durationInFrames,
          ],
          [0, 1, 1, 0],
          clamp,
        ),
      }}
    >
      <Background dark={dark} />
      <ChapterHeader scene={scene} frame={frame} fps={fps} />
      <div data-visual={scene.id}>
        <ChapterVisual scene={scene} frame={frame} fps={fps} />
      </div>
    </AbsoluteFill>
  );
};

/** Chapter visuals stay mounted. Only the independent speech/subtitle items are cut. */
const NarratedScene = ({ scene }: { scene: Scene }) => (
  <AbsoluteFill>
    <Shot scene={scene} />
    {scene.lines.map((line) => (
      <Sequence
        key={line.id}
        name={`音声・字幕 / ${line.id}`}
        from={line.from}
        durationInFrames={line.durationInFrames}
      >
        <Audio
          name={line.id}
          src={staticFile(line.audio)}
          from={line.audioFrom}
        />
        <Captions id={line.id} />
      </Sequence>
    ))}
  </AbsoluteFill>
);

export const Film = () => (
  <AbsoluteFill className="film">
    <TransitionSeries name="音声に合わせた10章">
      <TransitionSeries.Sequence
        name="01 きっかけ"
        durationInFrames={timeline.scenes[0].durationInFrames}
      >
        <NarratedScene scene={timeline.scenes[0]} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence
        name="02 課題"
        durationInFrames={timeline.scenes[1].durationInFrames}
      >
        <NarratedScene scene={timeline.scenes[1]} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence
        name="03 仕組み"
        durationInFrames={timeline.scenes[2].durationInFrames}
      >
        <NarratedScene scene={timeline.scenes[2]} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence
        name="04 実際の画面"
        durationInFrames={timeline.scenes[3].durationInFrames}
      >
        <NarratedScene scene={timeline.scenes[3]} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence
        name="05 続ける楽しさ"
        durationInFrames={timeline.scenes[4].durationInFrames}
      >
        <NarratedScene scene={timeline.scenes[4]} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence
        name="06 毎日の記録"
        durationInFrames={timeline.scenes[5].durationInFrames}
      >
        <NarratedScene scene={timeline.scenes[5]} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence
        name="07 実装の工夫"
        durationInFrames={timeline.scenes[6].durationInFrames}
      >
        <NarratedScene scene={timeline.scenes[6]} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence
        name="08 技術構成"
        durationInFrames={timeline.scenes[7].durationInFrames}
      >
        <NarratedScene scene={timeline.scenes[7]} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence
        name="09 今後の検証"
        durationInFrames={timeline.scenes[8].durationInFrames}
      >
        <NarratedScene scene={timeline.scenes[8]} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence
        name="10 おわりに"
        durationInFrames={timeline.scenes[9].durationInFrames}
      >
        <NarratedScene scene={timeline.scenes[9]} />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);
