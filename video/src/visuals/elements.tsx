import React from "react";
import { Easing, interpolate, spring } from "remotion";
import type { Scene } from "../types";

export const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;
export const smooth = { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) };
export type VisualProps = { scene: Scene; frame: number; fps: number };

export const ChapterHeader = ({ scene, frame, fps }: VisualProps) => (
  <header
    data-chapter-title={scene.id}
    style={{
      position: "absolute",
      top: 80,
      left: 120,
      width: 1660,
      opacity: interpolate(frame, [0, fps * 0.4], [0, 1], clamp),
      translate: `0px ${interpolate(frame, [0, fps * 0.6], [22, 0], smooth)}px`,
    }}
  >
    <div className="eyebrow" style={{ marginBottom: 30 }}>
      {scene.chapter}
    </div>
    <h2 style={{ fontSize: 68, lineHeight: 1.25, letterSpacing: -2 }}>
      {scene.title}
    </h2>
  </header>
);

export const Pop = ({
  frame,
  fps,
  at = 0,
  children,
  style,
}: {
  frame: number;
  fps: number;
  at?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) => (
  <div
    style={{
      ...style,
      opacity: interpolate(frame, [at, at + fps * 0.24], [0, 1], clamp),
      translate: `0px ${interpolate(frame, [at, at + fps * 0.6], [55, 0], smooth)}px`,
      scale: spring({
        frame: frame - at,
        fps,
        from: 0.86,
        to: 1,
        config: { damping: 15, stiffness: 135 },
      }),
      rotate: "0deg",
    }}
  >
    {children}
  </div>
);

export const ChatMark = ({ size = 110 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
    <path
      d="M12 28Q12 12 29 12H72Q88 12 88 29V62Q88 78 72 78H42L20 92V75Q12 71 12 61Z"
      fill="currentColor"
    />
    <circle cx="35" cy="45" r="6" fill="var(--yellow)" />
    <circle cx="65" cy="45" r="6" fill="var(--yellow)" />
  </svg>
);

export const Envelope = ({
  color = "currentColor",
  size = 70,
}: {
  color?: string;
  size?: number;
}) => (
  <svg width={size} height={size * 0.7} viewBox="0 0 100 70" aria-hidden="true">
    <rect x="4" y="4" width="92" height="62" rx="12" fill={color} />
    <path
      d="M10 12L50 40L90 12"
      fill="none"
      stroke="var(--paper)"
      strokeWidth="5"
    />
  </svg>
);

export const Person = ({
  id,
  name,
  role,
  color,
  style,
}: {
  id: string;
  name: string;
  role: string;
  color: string;
  style?: React.CSSProperties;
}) => (
  <div
    data-actor={id}
    style={{
      position: "absolute",
      width: 260,
      height: 190,
      boxSizing: "border-box",
      padding: "24px 14px",
      borderRadius: 30,
      background: color,
      textAlign: "center",
      boxShadow: "0 12px 0 #2c16380b",
      ...style,
    }}
  >
    <div
      style={{
        margin: "0 auto 12px",
        width: 82,
        height: 82,
        borderRadius: 50,
        background: "#ffffffb8",
        display: "grid",
        placeItems: "center",
        fontWeight: 800,
        fontSize: name === "自分" ? 32 : 42,
      }}
    >
      {name}
    </div>
    <div style={{ fontSize: 24, fontWeight: 700, whiteSpace: "nowrap" }}>
      {role}
    </div>
  </div>
);

export const PreviewNote = () => (
  <p
    className="note"
    style={{ position: "absolute", top: 796, left: 130, fontSize: 23 }}
  >
    開発用の表示プレビュー / 実績・サーバー上の日数は変更していません
  </p>
);
