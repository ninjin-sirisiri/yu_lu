import { Video } from "@remotion/media";
import { CanvasImage, staticFile } from "remotion";
import demo from "../generated/demo.json";

export const Phone = ({
  screen = "chat",
  width = 280,
  label = "iOS Simulator / 開発版",
  video = false,
}: {
  screen?: string;
  width?: number;
  label?: string;
  video?: boolean;
}) => (
  <figure style={{ width }}>
    <div
      className="phone"
      style={{ width, height: (width * 2000) / 920, boxSizing: "border-box" }}
    >
      {video && demo.available ? (
        <Video
          name="Simulator 実行デモ"
          src={staticFile("demo/navigation.mp4")}
          muted
          objectFit="cover"
          style={{ width: "100%", height: "100%" }}
        />
      ) : (
        <CanvasImage
          src={staticFile(`screens/${screen}.png`)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
    </div>
    <figcaption
      className="note"
      style={{ fontSize: 21, marginTop: 12, textAlign: "center" }}
    >
      {label}
    </figcaption>
  </figure>
);
