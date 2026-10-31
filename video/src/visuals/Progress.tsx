import { CanvasImage, interpolate, spring, staticFile } from "remotion";
import { cueAt } from "../story";
import { latestCue } from "../timing";
import {
  Envelope,
  Pop,
  PreviewNote,
  clamp,
  smooth,
  type VisualProps,
} from "./elements";
import { Phone } from "./Phone";

export const Growth = ({ scene, frame, fps }: VisualProps) => {
  const both = cueAt(scene, "growth-both"),
    palette = cueAt(scene, "growth-palette"),
    kept = cueAt(scene, "growth-kept");
  const cue = latestCue(
    scene,
    ["day-1", "day-7", "day-30", "day-60", "day-100"],
    frame,
  );
  const days = cue ? Number(cue.id.slice(4)) : 1;
  const change = cue?.frame ?? palette;
  const elapsed = frame - change;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 130,
          top: 330,
          width: 1100,
          height: 430,
          opacity: interpolate(
            frame,
            [palette, palette + fps * 0.5],
            [1, 0],
            clamp,
          ),
          translate: `${interpolate(frame, [palette, palette + fps * 0.7], [0, -280], smooth)}px 0px`,
          scale: 1,
          rotate: "0deg",
        }}
      >
        <Pop
          frame={frame}
          fps={fps}
          style={{
            position: "absolute",
            left: 370,
            top: 20,
            width: 340,
            height: 290,
            background: "white",
            borderRadius: 32,
            boxShadow: "0 10px 0 #2c163810",
            textAlign: "center",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: 16,
              background: "var(--pink)",
              color: "white",
              fontSize: 27,
              fontWeight: 700,
            }}
          >
            同じ日に、ふたりが送る
          </div>
          <div style={{ fontSize: 105, fontWeight: 800, lineHeight: 1.65 }}>
            {frame >= both ? "1" : "0"}
            <span style={{ fontSize: 38 }}>日</span>
          </div>
        </Pop>
        {["自分", "友達"].map((name, i) => (
          <div
            key={name}
            style={{
              position: "absolute",
              left: i ? 930 : 80,
              top: 120,
              textAlign: "center",
              fontSize: 34,
              fontWeight: 750,
            }}
          >
            <div
              style={{
                width: 110,
                height: 110,
                borderRadius: 60,
                background: i ? "#e8d9ef" : "var(--yellow)",
                display: "grid",
                placeItems: "center",
              }}
            >
              {name}
            </div>
          </div>
        ))}
        {[0, 1].map((i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: interpolate(
                frame,
                [both + i * fps * 0.15, both + fps * 0.85],
                [i ? 880 : 200, 500],
                smooth,
              ),
              top: 155,
              opacity: frame >= both && frame < both + fps * 0.9 ? 1 : 0,
              scale: 1,
              rotate: `${i ? -10 : 10}deg`,
            }}
          >
            <Envelope size={75} color={i ? "#7b5098" : "var(--pink)"} />
          </div>
        ))}
        <div
          style={{
            position: "absolute",
            left: 465,
            top: 325,
            fontSize: 34,
            fontWeight: 750,
            color: "var(--pink)",
            scale: spring({
              frame: frame - both - fps * 0.7,
              fps,
              from: 0,
              to: 1,
              config: { damping: 13 },
            }),
          }}
        >
          ✓ 1日を記録
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 160,
          top: 320,
          width: 1070,
          height: 470,
          opacity: interpolate(
            frame,
            [palette, palette + fps * 0.4],
            [0, 1],
            clamp,
          ),
          translate: `${interpolate(frame, [palette, palette + fps * 0.7], [300, 0], smooth)}px 0px`,
          scale: 1,
          rotate: "0deg",
        }}
      >
        <div style={{ fontSize: 28, color: "var(--muted)", fontWeight: 750 }}>
          ふたりの累計
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 45,
            width: 370,
            whiteSpace: "nowrap",
            fontSize: 125,
            fontWeight: 800,
            letterSpacing: -5,
            scale: interpolate(
              elapsed,
              [0, fps * 0.18, fps * 0.5],
              [0.88, 1.12, 1],
              clamp,
            ),
          }}
        >
          {days}
          <span style={{ fontSize: 43, letterSpacing: 0, marginLeft: 12 }}>
            日
          </span>
        </div>
        <div
          style={{
            position: "absolute",
            left: 420,
            top: 15,
            width: 560,
            height: 188,
            borderRadius: 28,
            overflow: "hidden",
            border: "3px solid #ded3c7",
            background: "white",
          }}
        >
          <CanvasImage
            src={staticFile(`screens/growth-${days}.png`)}
            style={{
              position: "absolute",
              left: 0,
              top: -240,
              width: 560,
              height: (560 * 2000) / 920,
            }}
          />
        </div>
        <p
          className="note"
          style={{ position: "absolute", left: 430, top: 214, fontSize: 22 }}
        >
          実画面の拡大 / 色・模様・日数表示
        </p>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 300,
            display: "flex",
            gap: 26,
          }}
        >
          {[1, 7, 30, 60, 100].map((day) => (
            <div
              key={day}
              data-day={day}
              data-active={cue && day === days ? "true" : "false"}
              style={{
                width: 160,
                height: 100,
                display: "grid",
                placeItems: "center",
                borderRadius: 24,
                fontSize: 43,
                fontWeight: 800,
                background: cue && day === days ? "var(--yellow)" : "#eee7df",
                translate: `0px ${cue && day === days ? interpolate(elapsed, [0, fps * 0.18, fps * 0.6], [0, -30, -12], clamp) : 0}px`,
                scale:
                  cue && day === days
                    ? interpolate(
                        elapsed,
                        [0, fps * 0.18, fps * 0.6],
                        [1, 1.1, 1.04],
                        clamp,
                      )
                    : 1,
                rotate:
                  cue && day === days
                    ? `${interpolate(elapsed, [0, fps * 0.18, fps * 0.6], [-6, 3, 0], clamp)}deg`
                    : "0deg",
                boxShadow:
                  cue && day === days ? "0 12px 25px #e2b34844" : "none",
              }}
            >
              {day}日
            </div>
          ))}
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 445,
            display: "flex",
            gap: 18,
            alignItems: "center",
            fontSize: 29,
            fontWeight: 700,
            opacity: interpolate(
              frame,
              [kept, kept + fps * 0.3],
              [0, 1],
              clamp,
            ),
            translate: `0px ${interpolate(frame, [kept, kept + fps * 0.5], [30, 0], smooth)}px`,
          }}
        >
          <span
            style={{
              padding: "8px 18px",
              background: "var(--yellow)",
              borderRadius: 10,
            }}
          >
            ✓
          </span>
          <span
            style={{
              padding: "8px 18px",
              border: "2px dashed #b4a5b9",
              borderRadius: 10,
            }}
          >
            —
          </span>
          <span
            style={{
              padding: "8px 18px",
              background: "var(--yellow)",
              borderRadius: 10,
            }}
          >
            ✓
          </span>
          <span>間が空いても、累計は残る</span>
        </div>
      </div>
      <Pop
        frame={frame}
        fps={fps}
        style={{ position: "absolute", right: 170, top: 230 }}
      >
        <div
          style={{
            scale: cue
              ? interpolate(
                  elapsed,
                  [0, fps * 0.16, fps * 0.5],
                  [1, 1.035, 1],
                  clamp,
                )
              : 1,
            rotate: "0deg",
            translate: "0px 0px",
          }}
        >
          <Phone
            screen={cue ? `growth-${days}` : "conversation"}
            label={cue ? `${days}日段階 / 表示のみ` : "会話画面の例 / 表示のみ"}
          />
        </div>
      </Pop>
      <PreviewNote />
    </>
  );
};

export const Streak = ({ scene, frame, fps }: VisualProps) => {
  const send = cueAt(scene, "streak-send"),
    reply = cueAt(scene, "streak-reply"),
    done = cueAt(scene, "streak-done"),
    earned = cueAt(scene, "streak-earned"),
    reset = cueAt(scene, "streak-reset");
  const afterEarned = frame >= earned;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 150,
          top: 335,
          width: 1080,
          opacity: interpolate(
            frame,
            [earned, earned + fps * 0.4],
            [1, 0],
            clamp,
          ),
          translate: `${interpolate(frame, [done, done + fps * 0.6], [0, -100], smooth)}px 0px`,
          scale: interpolate(frame, [done, done + fps * 0.6], [1, 0.8], smooth),
          transformOrigin: "left top",
          rotate: "0deg",
        }}
      >
        {["今日の送信相手に送る", "返信対象の全員に、受信後に返信する"].map(
          (text, i) => {
            const at = i ? reply : send;
            return (
              <Pop
                key={text}
                frame={frame}
                fps={fps}
                at={i * 10}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 24,
                  padding: "28px 32px",
                  marginBottom: 30,
                  borderRadius: 28,
                  background: frame >= at ? "var(--yellow)" : "white",
                }}
              >
                <div
                  style={{
                    width: 66,
                    height: 66,
                    borderRadius: 35,
                    display: "grid",
                    placeItems: "center",
                    background: "var(--paper)",
                    fontSize: 38,
                    fontWeight: 800,
                    scale: interpolate(
                      frame,
                      [at, at + fps * 0.2, at + fps * 0.5],
                      [1, 1.2, 1],
                      clamp,
                    ),
                  }}
                >
                  {frame >= at ? "✓" : i + 1}
                </div>
                <span style={{ fontSize: 35, fontWeight: 700 }}>{text}</span>
              </Pop>
            );
          },
        )}
        <p className="note" style={{ marginTop: 20 }}>
          受信するだけでは達成になりません。
        </p>
      </div>
      <div
        style={{
          position: "absolute",
          left: interpolate(
            frame,
            [earned, earned + fps * 0.7],
            [1010, 470],
            smooth,
          ),
          top: interpolate(
            frame,
            [earned, earned + fps * 0.7],
            [530, 360],
            smooth,
          ),
          opacity: interpolate(frame, [done, done + fps * 0.3], [0, 1], clamp),
          scale: spring({
            frame: frame - done,
            fps,
            from: 0.4,
            to: 1,
            config: { damping: 14 },
          }),
          rotate: "0deg",
          translate: "0px 0px",
        }}
      >
        <div
          style={{
            width: 280,
            height: 230,
            borderRadius: 42,
            background: "var(--yellow)",
            display: "grid",
            placeItems: "center",
            fontSize: 105,
            fontWeight: 800,
            rotate: `${interpolate(frame, [reset, reset + fps * 0.15, reset + fps * 0.5], [0, -10, 0], clamp)}deg`,
          }}
        >
          {frame >= reset ? "0" : afterEarned ? "100" : "1"}
          <span style={{ fontSize: 27, marginTop: -45 }}>現在の連続日数</span>
        </div>
        {afterEarned && (
          <div
            className="pill"
            style={{ marginTop: 30, background: "#f0e4f4", fontSize: 29 }}
          >
            獲得済み：100日段階
          </div>
        )}
      </div>
      <Pop
        frame={frame}
        fps={fps}
        style={{ position: "absolute", right: 170, top: 230 }}
      >
        <Phone
          screen={
            frame >= reset
              ? "streak-reset"
              : afterEarned
                ? "streak-100"
                : "streak-1"
          }
          label="個人の表示プレビュー"
        />
      </Pop>
      <PreviewNote />
    </>
  );
};
