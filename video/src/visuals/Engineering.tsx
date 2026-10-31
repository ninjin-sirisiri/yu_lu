import { interpolate, spring } from "remotion";
import { cueAt } from "../story";
import { latestCue } from "../timing";
import { Envelope, Pop, clamp, smooth, type VisualProps } from "./elements";

export const Reliability = ({ scene, frame, fps }: VisualProps) => {
  const draft = cueAt(scene, "draft"),
    saved = cueAt(scene, "saved"),
    offline = cueAt(scene, "offline"),
    queued = cueAt(scene, "queued"),
    reconnect = cueAt(scene, "reconnect"),
    confirmed = cueAt(scene, "confirmed");
  return (
    <>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: interpolate(
            frame,
            [offline, offline + fps * 0.4],
            [1, 0],
            clamp,
          ),
        }}
      >
        <Pop
          frame={frame}
          fps={fps}
          style={{
            position: "absolute",
            left: 200,
            top: 365,
            width: 440,
            height: 320,
            border: "3px solid #80678e",
            borderRadius: 32,
            padding: 32,
            boxSizing: "border-box",
          }}
        >
          <p style={{ fontSize: 32, color: "var(--yellow)", fontWeight: 700 }}>
            友達 A の会話
          </p>
          <div
            style={{
              marginTop: 30,
              height: 110,
              borderRadius: 20,
              background: "#4b3359",
              padding: 22,
              fontSize: 31,
            }}
          >
            入力途中の下書き
            <span style={{ opacity: frame < saved ? 0.8 : 0 }}>│</span>
          </div>
        </Pop>
        <Pop
          frame={frame}
          fps={fps}
          at={fps * 0.25}
          style={{
            position: "absolute",
            left: 1250,
            top: 390,
            width: 430,
            height: 270,
            border: "3px solid #80678e",
            borderRadius: 32,
            padding: 38,
            boxSizing: "border-box",
          }}
        >
          <div style={{ fontSize: 38, fontWeight: 700 }}>端末内に保存</div>
          <p className="note" style={{ marginTop: 40 }}>
            相手ごとに保持
          </p>
        </Pop>
        <div
          style={{
            position: "absolute",
            left: interpolate(
              frame,
              [saved, saved + fps * 1.1],
              [680, 1340],
              smooth,
            ),
            top: 510,
            opacity: interpolate(
              frame,
              [draft, draft + fps * 0.2],
              [0, 1],
              clamp,
            ),
            scale: interpolate(
              frame,
              [saved + fps * 0.8, saved + fps * 1.2],
              [1, 0.7],
              smooth,
            ),
            rotate: `${interpolate(frame, [saved, saved + fps * 0.5, saved + fps * 1.1], [-7, 7, 0], clamp)}deg`,
          }}
        >
          <Envelope color="var(--yellow)" size={150} />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: interpolate(
            frame,
            [offline, offline + fps * 0.35, confirmed, confirmed + fps * 0.35],
            [0, 1, 1, 0],
            clamp,
          ),
        }}
      >
        <div
          className="pill"
          style={{
            position: "absolute",
            left: 130,
            top: 340,
            color: frame >= reconnect ? "var(--yellow)" : "#ef91b5",
          }}
        >
          {frame >= reconnect ? "接続が戻る" : "オフライン"}
        </div>
        <div
          style={{
            position: "absolute",
            left: 1480,
            top: 415,
            fontSize: 39,
            fontWeight: 750,
            color: "var(--yellow)",
          }}
        >
          送信先
        </div>
        <svg
          width="1920"
          height="450"
          style={{ position: "absolute", left: 0, top: 330 }}
          aria-hidden="true"
        >
          <path
            d="M1050 250H1440"
            stroke={frame >= reconnect ? "#ffe784" : "#80678e"}
            strokeWidth="6"
            strokeDasharray={frame >= reconnect ? "none" : "15 18"}
          />
          <path
            d="M1410 230L1440 250L1410 270"
            fill="none"
            stroke="#ffe784"
            strokeWidth="6"
            opacity={frame >= reconnect ? 1 : 0}
          />
        </svg>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            data-queue-item={i}
            style={{
              position: "absolute",
              left: interpolate(
                frame,
                [
                  queued,
                  queued + fps * 0.7,
                  reconnect + i * fps * 0.5,
                  reconnect + i * fps * 0.5 + fps * 0.8,
                ],
                [220, 600, 600, 1450],
                smooth,
              ),
              top: interpolate(
                frame,
                [
                  queued,
                  queued + fps * 0.7,
                  reconnect + i * fps * 0.5,
                  reconnect + i * fps * 0.5 + fps * 0.8,
                ],
                [470 + i * 12, 410 + i * 115, 410 + i * 115, 480 + i * 75],
                smooth,
              ),
              width: 400,
              height: 90,
              borderRadius: 22,
              background: "#fff9e9",
              color: "var(--plum)",
              display: "flex",
              alignItems: "center",
              gap: 24,
              padding: "0 25px",
              boxSizing: "border-box",
              fontSize: 30,
              fontWeight: 700,
              scale: interpolate(
                frame,
                [
                  reconnect + i * fps * 0.5 + fps * 0.6,
                  reconnect + i * fps * 0.5 + fps * 0.9,
                ],
                [1, 0.65],
                clamp,
              ),
              opacity: interpolate(
                frame,
                [offline, offline + fps * 0.3],
                [0, 1],
                clamp,
              ),
              rotate: `${interpolate(frame, [queued, queued + fps * 0.7], [(i - 1) * 5, 0], smooth)}deg`,
            }}
          >
            <Envelope color="#c2255c" size={53} />
            {frame >= reconnect + i * fps * 0.5 + fps * 0.8
              ? "送信先へ"
              : "送信待ち"}{" "}
            {i + 1}
          </div>
        ))}
        <div
          style={{
            position: "absolute",
            left: 600,
            top: 770,
            fontSize: 28,
            color: "var(--yellow)",
            opacity: interpolate(
              frame,
              [queued, queued + fps * 0.4],
              [0, 1],
              clamp,
            ),
          }}
        >
          相手ごとの予約順に送信
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 280,
          top: 450,
          display: "flex",
          gap: 100,
          opacity: interpolate(
            frame,
            [confirmed, confirmed + fps * 0.5],
            [0, 1],
            clamp,
          ),
          translate: `0px ${interpolate(frame, [confirmed, confirmed + fps * 0.7], [150, 0], smooth)}px`,
          scale: 1,
          rotate: "0deg",
        }}
      >
        {["✓ 送信確定", "… 結果確認中"].map((text, i) => (
          <div
            key={text}
            style={{
              width: 550,
              padding: "52px 0",
              borderRadius: 30,
              background: i ? "#4b3359" : "var(--yellow)",
              color: i ? "var(--paper)" : "var(--plum)",
              fontSize: 43,
              textAlign: "center",
              fontWeight: 750,
              boxShadow: "0 20px 40px #1e0b2888",
            }}
          >
            {text}
          </div>
        ))}
      </div>
      <p
        className="note"
        style={{ position: "absolute", left: 130, top: 830, fontSize: 23 }}
      >
        処理の説明図 / 送信待ち・送信確定・結果確認中を区別
      </p>
    </>
  );
};

export const Architecture = ({ scene, frame, fps }: VisualProps) => {
  const local = cueAt(scene, "local"),
    server = cueAt(scene, "server"),
    clock = cueAt(scene, "server-clock"),
    accepted = cueAt(scene, "accepted");
  const cue = latestCue(
    scene,
    ["client", "local", "server", "server-clock", "accepted"],
    frame,
  );
  const at = cue?.frame ?? 0;
  const returning = cue?.id === "accepted";
  return (
    <>
      <svg
        width="1920"
        height="500"
        style={{ position: "absolute", left: 0, top: 300 }}
        aria-hidden="true"
      >
        <path
          d="M700 240H1220"
          stroke="#80678e"
          strokeWidth="5"
          strokeDasharray="12 14"
        />
      </svg>
      {[false, true].map((remote) => (
        <Pop
          key={String(remote)}
          frame={frame}
          fps={fps}
          at={remote ? 12 : 0}
          style={{
            position: "absolute",
            left: remote ? 1230 : 210,
            top: 365,
            width: 460,
            height: 330,
          }}
        >
          <div
            style={{
              height: "100%",
              padding: 38,
              boxSizing: "border-box",
              borderRadius: 36,
              background: "#3e254d",
              border: `3px solid ${(remote && frame >= server) || (!remote && frame < server) ? "#ffe784" : "#80678e"}`,
              scale:
                remote && frame >= server
                  ? interpolate(
                      frame,
                      [at, at + fps * 0.2, at + fps * 0.6],
                      [1, 1.06, 1],
                      clamp,
                    )
                  : 1,
            }}
          >
            <div className="technical" style={{ color: "var(--yellow)" }}>
              {remote ? "SERVER" : "iOS / Android"}
            </div>
            <div
              style={{
                fontSize: remote ? 50 : 40,
                fontWeight: 750,
                marginTop: 35,
              }}
            >
              {remote ? (
                "Supabase"
              ) : (
                <>
                  React Native
                  <br />＋ Expo
                </>
              )}
            </div>
            <p className="note" style={{ marginTop: 30, fontSize: 26 }}>
              {remote ? "認証・データ・今日の判定" : "画面・入力・端末内の保存"}
            </p>
          </div>
        </Pop>
      ))}
      <div
        style={{
          position: "absolute",
          left: 260,
          top: 710,
          width: 350,
          padding: 20,
          borderRadius: 20,
          background: "#594164",
          fontSize: 28,
          opacity: interpolate(
            frame,
            [local, local + fps * 0.3],
            [0, 1],
            clamp,
          ),
          translate: `0px ${interpolate(frame, [local, local + fps * 0.6], [-100, 0], smooth)}px`,
        }}
      >
        端末内の保存
      </div>
      <div
        style={{
          position: "absolute",
          left: 760,
          top: 340,
          textAlign: "center",
          width: 380,
          opacity: interpolate(
            frame,
            [clock, clock + fps * 0.3],
            [0, 1],
            clamp,
          ),
          scale: spring({
            frame: frame - clock,
            fps,
            from: 0.6,
            to: 1,
            config: { damping: 15 },
          }),
        }}
      >
        <div style={{ fontSize: 80, fontWeight: 800, color: "var(--yellow)" }}>
          04:00
        </div>
        <span style={{ fontSize: 25 }}>日本時間 / サーバーで判定</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: interpolate(
            frame,
            [at, at + fps * 1.1],
            returning ? [1170, 730] : [730, 1170],
            smooth,
          ),
          top: 535,
          opacity: cue && frame < at + fps * 1.15 ? 1 : 0,
          rotate: `${returning ? -8 : 8}deg`,
        }}
      >
        <Envelope color="var(--yellow)" size={90} />
      </div>
      <div
        className="pill"
        style={{
          position: "absolute",
          left: 740,
          top: 730,
          color: "var(--yellow)",
          opacity: interpolate(
            frame,
            [accepted, accepted + fps * 0.3],
            [0, 1],
            clamp,
          ),
          translate: `0px ${interpolate(frame, [accepted, accepted + fps * 0.6], [60, 0], smooth)}px`,
        }}
      >
        サーバーの受付結果で判定
      </div>
    </>
  );
};
