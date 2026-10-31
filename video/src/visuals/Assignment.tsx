import { interpolate, spring } from "remotion";
import { cueAt, storyState } from "../story";
import { clamp, smooth, Person, type VisualProps } from "./elements";

/** Three persistent identities. A never becomes B, and arrows never imply A sent the incoming message. */
export const AssignmentBoard = ({ scene, frame, fps }: VisualProps) => {
  const story = storyState(scene, frame);
  const approved = cueAt(scene, "approved");
  const choose = cueAt(scene, "outgoing");
  const receive = cueAt(scene, "reply");
  const free = cueAt(scene, "free");
  const expanded = story.phase === "free";
  return (
    <div
      data-story-phase={story.phase}
      style={{
        position: "absolute",
        left: 120,
        top: 320,
        width: 1680,
        height: 530,
      }}
    >
      <svg
        width="1680"
        height="530"
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
        aria-label="自分からAへ送信し、別のBから受信する場合の説明図"
      >
        <defs>
          <marker
            id="daily-send"
            markerWidth="10"
            markerHeight="10"
            refX="8"
            refY="5"
            orient="auto"
          >
            <path
              d="M0 0L9 5L0 10"
              fill="none"
              stroke="#c2255c"
              strokeWidth="2"
            />
          </marker>
          <marker
            id="daily-receive"
            markerWidth="10"
            markerHeight="10"
            refX="8"
            refY="5"
            orient="auto"
          >
            <path
              d="M0 0L9 5L0 10"
              fill="none"
              stroke="#007d82"
              strokeWidth="2"
            />
          </marker>
        </defs>
        {expanded &&
          [
            [360, 210],
            [1320, 210],
            [600, 440],
            [1080, 440],
          ].map(([x, y]) => (
            <path
              key={x}
              d={`M840 270L${x} ${y}`}
              stroke="#bdb0bd"
              strokeWidth="4"
              strokeDasharray="9 14"
              opacity={interpolate(
                frame,
                [free, free + fps * 0.6],
                [0, 0.6],
                clamp,
              )}
            />
          ))}
        {story.flows.map((flow) => {
          const outgoing = flow.kind === "send";
          const x1 = outgoing ? 985 : 445,
            y1 = outgoing ? 235 : 348,
            x2 = outgoing ? 1220 : 690,
            y2 = outgoing ? 150 : 295;
          const progress = interpolate(
            frame,
            [flow.at, flow.at + fps * 1.35],
            [0, 1],
            smooth,
          );
          const color = outgoing ? "#c2255c" : "#007d82";
          return (
            <g key={flow.kind} data-flow={`${flow.from}:${flow.to}`}>
              <path
                d={`M${x1} ${y1}L${x2} ${y2}`}
                fill="none"
                stroke={color}
                strokeWidth="7"
                markerEnd={`url(#daily-${flow.kind})`}
                pathLength="1"
                strokeDasharray="1"
                strokeDashoffset={interpolate(
                  frame,
                  [flow.at, flow.at + fps * 0.6],
                  [1, 0],
                  clamp,
                )}
              />
              <g
                transform={`translate(${x1 + (x2 - x1) * progress - 24} ${y1 + (y2 - y1) * progress - 18})`}
                opacity={
                  frame >= flow.at && frame < flow.at + fps * 1.4 ? 1 : 0
                }
              >
                <rect width="48" height="36" rx="8" fill={color} />
                <path
                  d="M5 7L24 22L43 7"
                  stroke="white"
                  strokeWidth="3"
                  fill="none"
                />
              </g>
              <text
                x={outgoing ? 1090 : 550}
                y={outgoing ? 110 : 420}
                textAnchor="middle"
                fill={color}
                fontSize="29"
                fontWeight="700"
                opacity={interpolate(
                  frame,
                  [flow.at, flow.at + fps * 0.3],
                  [0, 1],
                  clamp,
                )}
              >
                {outgoing ? "自分から送る" : "Bから届く"}
              </text>
            </g>
          );
        })}
      </svg>
      <Person
        id="self"
        name="自分"
        role="あなた"
        color="var(--yellow)"
        style={{
          left: 710,
          top: 175,
          scale: spring({
            frame,
            fps,
            from: 0.7,
            to: 1,
            config: { damping: 16 },
          }),
          rotate: "0deg",
          translate: `0px ${interpolate(frame, [0, fps * 0.7], [70, 0], smooth)}px`,
        }}
      />
      <div
        className="pill"
        style={{
          position: "absolute",
          left: 670,
          top: 20,
          background: "var(--yellow)",
          opacity: interpolate(
            frame,
            [approved, approved + fps * 0.25, choose, choose + fps * 0.3],
            [0, 1, 1, 0],
            clamp,
          ),
          scale: spring({
            frame: frame - approved,
            fps,
            from: 0.6,
            to: 1,
            config: { damping: 15 },
          }),
        }}
      >
        ✓ お互いに承認した友達
      </div>
      <Person
        id="friend-a"
        name="A"
        role={frame >= choose ? "今日、送る相手" : "承認した友達"}
        color="#f7d5e2"
        style={{
          left: interpolate(
            frame,
            [choose, choose + fps * 0.8, free, free + fps * 0.8],
            [200, 1240, 1240, 1190],
            smooth,
          ),
          top: interpolate(
            frame,
            [choose, choose + fps * 0.8, free, free + fps * 0.8],
            [95, 35, 35, 115],
            smooth,
          ),
          rotate: `${interpolate(frame, [choose, choose + fps * 0.35, choose + fps * 0.8], [-8, 5, 0], clamp)}deg`,
          scale: spring({
            frame: frame - fps * 0.15,
            fps,
            from: 0.7,
            to: 1,
            config: { damping: 16 },
          }),
        }}
      />
      <Person
        id="friend-b"
        name="B"
        role={frame >= receive ? "受信・返信する相手" : "承認した友達"}
        color="#cce9e8"
        style={{
          left: interpolate(
            frame,
            [choose, choose + fps * 0.8, free, free + fps * 0.8],
            [1210, 180, 180, 230],
            smooth,
          ),
          top: interpolate(
            frame,
            [choose, choose + fps * 0.8, free, free + fps * 0.8],
            [95, 255, 255, 115],
            smooth,
          ),
          opacity: interpolate(
            frame,
            [choose, choose + fps * 0.5, receive, receive + fps * 0.45],
            [1, 0.2, 0.2, 1],
            clamp,
          ),
          scale: interpolate(
            frame,
            [receive, receive + fps * 0.25, receive + fps * 0.65],
            [0.92, 1.09, 1],
            clamp,
          ),
          rotate: "0deg",
        }}
      />
      {["C", "D"].map((name, i) => (
        <div
          key={name}
          style={{
            position: "absolute",
            left: i ? 990 : 480,
            top: 405,
            opacity: interpolate(
              frame,
              [
                0,
                fps * 0.7,
                choose,
                choose + fps * 0.5,
                free,
                free + fps * 0.6,
              ],
              [0, 0.65, 0.65, 0, 0, 1],
              clamp,
            ),
            translate: `0px ${interpolate(frame, [free, free + fps * 0.6], [40, 0], smooth)}px`,
            scale: 1,
            rotate: `${i ? 6 : -6}deg`,
          }}
        >
          <div
            style={{
              padding: "16px 30px",
              borderRadius: 24,
              background: "#f0e9e0",
              fontSize: 30,
              fontWeight: 700,
            }}
          >
            友達 {name}
          </div>
        </div>
      ))}
      <div
        style={{
          position: "absolute",
          left: 510,
          top: 440,
          width: 660,
          textAlign: "center",
          fontSize: 30,
          fontWeight: 750,
          opacity: interpolate(
            frame,
            [receive, receive + fps * 0.4, free, free + fps * 0.4],
            [0, 1, 1, 0],
            clamp,
          ),
        }}
      >
        <span style={{ color: "#c2255c" }}>送る相手 A</span> と{" "}
        <span style={{ color: "#007d82" }}>受信する相手 B</span>
        <br />
        <span style={{ fontSize: 24, fontWeight: 500 }}>
          相手が異なる場合の例 / Bには受信後に返信
        </span>
      </div>
      <div
        className="pill"
        style={{
          position: "absolute",
          left: 590,
          top: 15,
          background: "var(--paper)",
          opacity: interpolate(frame, [free, free + fps * 0.35], [0, 1], clamp),
          translate: `0px ${interpolate(frame, [free, free + fps * 0.6], [-40, 0], smooth)}px`,
        }}
      >
        ほかの友達とも、自由に話せる
      </div>
      <span
        className="note"
        style={{ position: "absolute", right: 0, bottom: 0, fontSize: 22 }}
      >
        仕組みの説明図
      </span>
    </div>
  );
};
