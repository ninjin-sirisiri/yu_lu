// Task 22 (spec line 32): 選択中タブの再選択 — focused-tab re-selection.
//
// The tab bar's `tabPress` listener in (tabs)/_layout.tsx intercepts a press
// on the ALREADY-focused tab and emits here. Two responses follow:
// - the focused tab's stack pops back to its root (その先頭へ戻り) — done in
//   the layout, where the event and the navigation object live;
// - the tab's list scrolls to the top (すでに一覧なら先頭へスクロール) — the
//   lists below subscribe for their own tab and scroll their own ref.
//
// A tab with nothing scrollable simply has no mounted scrollable; the helper
// then no-ops (spec allows popping without a scroll). Mirrors
// notify/listener.ts: per-listener try/catch so one broken subscriber can
// never starve the rest.

import type { RefObject } from 'react';
import type { ScrollViewInstance } from 'react-native';

type TabReselectListener = () => void;

const listeners = new Map<string, Set<TabReselectListener>>();

/** Subscribes to a tab's re-select signal; returns the unsubscribe. */
export function subscribeTabReselect(tab: string, listener: TabReselectListener): () => void {
  let set = listeners.get(tab);
  if (set === undefined) {
    set = new Set();
    listeners.set(tab, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(tab);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(tab);
  };
}

/** Fires the re-select signal for one tab (called by the tab bar listener). */
export function emitTabReselect(tab: string): void {
  const set = listeners.get(tab);
  if (set === undefined) return;
  for (const listener of [...set]) {
    try {
      listener();
    } catch {
      // One bad subscriber must never break delivery to the others.
    }
  }
}

/** Drops every subscription (tests). */
export function resetTabReselectListeners(): void {
  listeners.clear();
}

/** Scrolls a registered scrollable back to the top; no-op without one. */
export function scrollRefToTop(ref: RefObject<ScrollViewInstance | null>): void {
  try {
    ref.current?.scrollTo({ y: 0, animated: true });
  } catch {
    // Environment without a scroll responder — nothing to scroll.
  }
}
