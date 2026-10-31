import { Composition } from "remotion";
import { Film, timeline } from "./Film";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="YuLu"
        component={Film}
        fps={30}
        width={1920}
        height={1080}
        durationInFrames={timeline.durationInFrames}
      />
    </>
  );
};
