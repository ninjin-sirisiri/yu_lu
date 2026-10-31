import { interpolate, spring } from "remotion";
import { cueAt } from "../story";
import { activeLine } from "../timing";
import {
  ChatMark,
  Envelope,
  Pop,
  Person,
  clamp,
  smooth,
  type VisualProps,
} from "./elements";
import { Phone } from "./Phone";

export const Opening = ({ scene, frame, fps }: VisualProps) => {
  const brand = cueAt(scene, "brand"),
    hesitate = cueAt(scene, "hesitate");
  return (
    <>
      <div
        style={{
          opacity: interpolate(
            frame,
            [brand, brand + fps * 0.5],
            [1, 0],
            clamp,
          ),
        }}
      >
        {["A", "B", "C"].map((name, i) => (
          <Person
            key={name}
            id={`opening-${name}`}
            name={name}
            role="最近、話していない友達"
            color={i === 1 ? "#eee2f1" : "#f1ece3"}
            style={{
              left: 280 + i * 490,
              top: 365 + (i === 1 ? 90 : 0),
              width: 300,
              height: 190,
              rotate: `${(i - 1) * 7}deg`,
              scale: spring({
                frame: frame - i * 7,
                fps,
                from: 0.5,
                to: 1,
                config: { damping: 15 },
              }),
              translate: `0px ${interpolate(frame, [0, fps * 0.8], [100, 0], smooth)}px`,
            }}
          />
        ))}
        <div
          className="bubble"
          style={{
            position: "absolute",
            left: 620,
            top: 680,
            width: 590,
            textAlign: "center",
            background: "var(--yellow)",
            fontWeight: 700,
            translate: `${interpolate(frame, [hesitate, hesitate + fps * 0.18, hesitate + fps * 0.36, hesitate + fps * 0.6], [0, -25, 18, 0], clamp)}px 0px`,
            scale: spring({
              frame: frame - fps * 1.1,
              fps,
              from: 0,
              to: 1,
              config: { damping: 15 },
            }),
          }}
        >
          最近どうしてる？
          <span style={{ fontSize: 27, marginLeft: 22, color: "var(--muted)" }}>
            …送ろうかな
          </span>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 250,
          top: 400,
          display: "flex",
          alignItems: "center",
          gap: 44,
          opacity: interpolate(
            frame,
            [brand, brand + fps * 0.3],
            [0, 1],
            clamp,
          ),
          translate: `${interpolate(frame, [brand, brand + fps * 0.8], [-200, 0], smooth)}px 0px`,
          scale: 1,
          rotate: "0deg",
        }}
      >
        <div
          style={{
            rotate: `${interpolate(frame, [brand, brand + fps * 0.8], [-22, 0], smooth)}deg`,
          }}
        >
          <ChatMark size={200} />
        </div>
        <div>
          <div style={{ fontSize: 92, fontWeight: 800, letterSpacing: -3 }}>
            Yu_Lu
          </div>
          <p className="support">友達に話しかけるきっかけ。</p>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: 175,
          top: 260,
          opacity: interpolate(
            frame,
            [brand, brand + fps * 0.4],
            [0, 1],
            clamp,
          ),
          translate: `${interpolate(frame, [brand, brand + fps * 0.8], [450, 0], smooth)}px 0px`,
          rotate: `${interpolate(frame, [brand, brand + fps * 0.8], [12, 0], smooth)}deg`,
          scale: 1,
        }}
      >
        <Phone />
      </div>
    </>
  );
};

export const Problem = ({ scene, frame, fps }: VisualProps) => {
  const select = cueAt(scene, "select"),
    message = cueAt(scene, "message");
  return (
    <>
      {["A", "B", "C", "D", "E"].map((name, i) => (
        <Person
          key={name}
          id={`problem-${name}`}
          name={name}
          role={i === 1 && frame >= select ? "今日の相手" : "いつもの友達"}
          color={i === 1 ? "#f7d5e2" : "#eee7df"}
          style={{
            width: 240,
            left: interpolate(
              frame,
              [select, select + fps * 0.8],
              [230 + i * 300, i === 1 ? 1330 : 80 + i * 330],
              smooth,
            ),
            top: interpolate(
              frame,
              [select, select + fps * 0.8],
              [440 + Math.abs(i - 2) * 24, i === 1 ? 430 : 690],
              smooth,
            ),
            opacity: interpolate(
              frame,
              [0, fps * 0.6, select, select + fps * 0.5],
              [0, 1, 1, i === 1 ? 1 : 0.13],
              clamp,
            ),
            rotate: `${interpolate(frame, [select, select + fps * 0.8], [(i - 2) * 7, 0], smooth)}deg`,
            scale:
              i === 1
                ? spring({
                    frame: frame - select,
                    fps,
                    from: 1,
                    to: 1.12,
                    config: { damping: 14 },
                  })
                : 1,
          }}
        />
      ))}
      <div
        className="pill"
        style={{
          position: "absolute",
          left: 680,
          top: 335,
          opacity: interpolate(
            frame,
            [select, select + fps * 0.3],
            [1, 0],
            clamp,
          ),
        }}
      >
        「誰に話そう」で迷う
      </div>
      <div
        style={{
          position: "absolute",
          left: 250,
          top: 430,
          opacity: interpolate(
            frame,
            [select, select + fps * 0.3],
            [0, 1],
            clamp,
          ),
          translate: `${interpolate(frame, [select, select + fps * 0.6], [-200, 0], smooth)}px 0px`,
        }}
      >
        <Person
          id="problem-self"
          name="自分"
          role="あなた"
          color="var(--yellow)"
        />
      </div>
      <div
        className="bubble"
        style={{
          position: "absolute",
          left: 650,
          top: 450,
          width: 410,
          textAlign: "center",
          scale: spring({
            frame: frame - message,
            fps,
            from: 0,
            to: 1,
            config: { damping: 14 },
          }),
        }}
      >
        最近どうしてる？
      </div>
      <div
        style={{
          position: "absolute",
          left: interpolate(
            frame,
            [message, message + fps * 1.0],
            [530, 1230],
            smooth,
          ),
          top: 640,
          opacity: frame >= message && frame < message + fps * 1.2 ? 1 : 0,
          rotate: `${interpolate(frame, [message, message + fps], [0, -12], clamp)}deg`,
        }}
      >
        <Envelope color="var(--pink)" size={90} />
      </div>
      <p className="note" style={{ position: "absolute", top: 810, left: 130 }}>
        利用場面のイメージ / 新しい出会いではなく、今いる友達との会話
      </p>
    </>
  );
};

export const Screens = ({ scene, frame, fps }: VisualProps) => {
  const line = activeLine(scene, frame);
  const index = scene.lines.indexOf(line);
  const stages = ["一覧", "User ID", "招待・QR", "文字・写真", "好きな時間"];
  return (
    <>
      <div style={{ position: "absolute", left: 150, top: 390, width: 1120 }}>
        <div
          style={{
            height: 5,
            background: "#ded3c7",
            position: "absolute",
            top: 49,
            left: 30,
            width: 1000,
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            translate: `${interpolate(frame, [line.from, line.from + fps * 0.65], [Math.max(0, index - 1) * 220, index * 220], smooth)}px 0px`,
            width: 100,
            height: 100,
            borderRadius: 50,
            background: "var(--yellow)",
            boxShadow: "0 0 0 10px #ffe78433",
          }}
        />
        {stages.map((stage, i) => (
          <div
            key={stage}
            style={{
              position: "absolute",
              left: i * 220,
              width: 160,
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: 100,
                height: 100,
                display: "grid",
                placeItems: "center",
                fontWeight: 800,
                fontSize: 40,
                position: "relative",
                marginBottom: 24,
              }}
            >
              {i + 1}
            </div>
            <p
              style={{
                width: 160,
                marginLeft: -30,
                fontSize: 28,
                fontWeight: index === i ? 800 : 500,
                color: index === i ? "var(--plum)" : "var(--muted)",
              }}
            >
              {stage}
            </p>
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 250,
          top: 650,
          display: "flex",
          gap: 30,
          alignItems: "center",
        }}
      >
        <div
          style={{
            rotate: `${interpolate(frame, [line.from, line.from + fps * 0.6], [-8, 0], smooth)}deg`,
            scale: spring({
              frame: frame - line.from,
              fps,
              from: 0.85,
              to: 1,
              config: { damping: 16 },
            }),
          }}
        >
          {index === 1 ? (
            <div className="pill">User ID → 申請 → 承認</div>
          ) : index === 2 ? (
            <div className="pill">招待 ≠ 自動で友達になる</div>
          ) : index >= 3 ? (
            <div className="bubble" style={{ background: "var(--yellow)" }}>
              文字 ＋ 写真
              <span style={{ fontSize: 27, marginLeft: 20 }}>
                自分のタイミングで
              </span>
            </div>
          ) : (
            <div className="pill">友達との会話を開く</div>
          )}
        </div>
      </div>
      <Pop
        frame={frame}
        fps={fps}
        style={{ position: "absolute", right: 170, top: 230 }}
      >
        <Phone screen={line.screen} video />
      </Pop>
      <p
        className="note"
        style={{ position: "absolute", left: 130, top: 820, fontSize: 23 }}
      >
        Simulatorの実行映像 / 等速・画面遷移のみ（新規の送信は未収録）
      </p>
    </>
  );
};

export const Outlook = ({ scene, frame, fps }: VisualProps) => {
  const enjoy = cueAt(scene, "enjoy"),
    burden = cueAt(scene, "burden"),
    separate = cueAt(scene, "separate-tests");
  return (
    <>
      {["楽しさ", "負担"].map((text, i) => (
        <div
          key={text}
          style={{
            position: "absolute",
            left: i ? 1080 : 380,
            top: 380,
            width: 420,
            padding: "40px 0",
            textAlign: "center",
            borderRadius: 36,
            background: i ? "#f1e1eb" : "var(--yellow)",
            translate: `${interpolate(frame, [separate, separate + fps * 0.8], [0, i ? 100 : -100], smooth)}px ${interpolate(frame, [i ? burden : enjoy, (i ? burden : enjoy) + fps * 0.3, (i ? burden : enjoy) + fps * 0.8], [0, -65, 0], clamp)}px`,
            rotate: `${interpolate(frame, [enjoy, enjoy + fps * 0.5, burden, burden + fps * 0.5], [0, i ? -7 : 7, i ? -7 : 7, 0], smooth)}deg`,
            scale: spring({
              frame: frame - i * 8,
              fps,
              from: 0.6,
              to: 1,
              config: { damping: 16 },
            }),
          }}
        >
          <div style={{ fontSize: 64, fontWeight: 800 }}>{text}</div>
          <p className="note" style={{ marginTop: 22 }}>
            友達同士で使って確かめる
          </p>
        </div>
      ))}
      <div
        style={{
          position: "absolute",
          left: 300,
          top: 700,
          width: 1320,
          display: "flex",
          justifyContent: "space-between",
          fontSize: 40,
          fontWeight: 750,
          opacity: interpolate(
            frame,
            [separate, separate + fps * 0.4],
            [0, 1],
            clamp,
          ),
        }}
      >
        <span>プログラムの動作確認</span>
        <span>使う人への効果の検証</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 950,
          top: 370,
          width: 4,
          height: 390,
          background: "var(--plum)",
          scale: `1 ${interpolate(frame, [separate, separate + fps * 0.6], [0, 1], smooth)}`,
          transformOrigin: "top",
        }}
      />
      <p className="note" style={{ position: "absolute", left: 130, top: 830 }}>
        今後の検証課題 / 利用効果は未検証
      </p>
    </>
  );
};

export const Closing = ({
  scene,
  frame,
  fps,
  credit,
}: VisualProps & { credit: string }) => {
  const message = cueAt(scene, "last-message");
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 350,
          top: 360,
          display: "flex",
          alignItems: "center",
          gap: 50,
          translate: `${interpolate(frame, [message, message + fps * 0.8], [0, -130], smooth)}px 0px`,
          scale: spring({
            frame,
            fps,
            from: 0.55,
            to: 1,
            config: { damping: 15 },
          }),
          rotate: "0deg",
        }}
      >
        <ChatMark size={220} />
        <div style={{ fontSize: 70, fontWeight: 800 }}>
          友達に話しかける
          <br />
          きっかけを。
        </div>
      </div>
      <div
        className="bubble"
        style={{
          position: "absolute",
          left: 620,
          top: 670,
          width: 730,
          background: "var(--yellow)",
          fontWeight: 800,
          fontSize: 46,
          opacity: interpolate(
            frame,
            [message, message + fps * 0.3],
            [0, 1],
            clamp,
          ),
          translate: `${interpolate(frame, [message, message + fps * 0.8], [400, 0], smooth)}px 0px`,
          scale: 1,
          rotate: "0deg",
        }}
      >
        今日、友達にひとこと。
      </div>
      <p
        className="note"
        style={{ position: "absolute", left: 130, top: 830, fontSize: 22 }}
      >
        音声：{credit} / 画面：iOS Simulator・開発版
      </p>
    </>
  );
};
