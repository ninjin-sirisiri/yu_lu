import { AccessibilityInfo, AppState } from 'react-native';
import { useEffect, useState } from 'react';

/**
 * Task 9: OS 動き軽減 (reduce motion).
 *
 * The app must not rely on the value that happened to be returned at start:
 * it follows OS changes while running and re-reads on foreground. Everything
 * goes through {@link ReduceMotionPort} so the controller is testable without
 * a native runtime.
 *
 * A stale asynchronous read must never overwrite a newer value. Every read and
 * every OS change advances an epoch; a result is only applied while it is
 * still the newest one.
 */

export interface ReduceMotionPort {
  read(): Promise<boolean>;
  /** Subscribes to OS changes; returns an unsubscribe function. */
  subscribe(listener: (value: boolean) => void): () => void;
}

/** Minimal AppState contract so foreground re-reads can be injected. */
export interface ReduceMotionAppState {
  addEventListener(type: 'change', handler: (state: string) => void): { remove(): void };
}

export interface ReduceMotionControllerOptions {
  /** Defaults to none (no foreground listener); the provider passes AppState. */
  appState?: ReduceMotionAppState;
}

export interface ReduceMotionController {
  /** Reads once and starts following OS/app-state changes. Idempotent. */
  start(): void;
  /** Releases every subscription and invalidates pending reads. */
  stop(): void;
  get(): boolean;
  subscribe(listener: (value: boolean) => void): () => void;
  /** Re-reads now (foreground return / manual refresh). */
  refresh(): void;
}

/**
 * Native port. A missing/unavailable native module degrades to "no reduced
 * motion" instead of crashing the whole app tree; the provider still keeps
 * playback disabled until its own device settings are known.
 */
export const nativeReduceMotionPort: ReduceMotionPort = {
  read: async () => {
    try {
      return await AccessibilityInfo.isReduceMotionEnabled();
    } catch {
      return false;
    }
  },
  subscribe: (listener) => {
    try {
      const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', listener);
      return () => subscription.remove();
    } catch {
      return () => {};
    }
  },
};

export function createReduceMotionController(
  port: ReduceMotionPort,
  options: ReduceMotionControllerOptions = {},
): ReduceMotionController {
  let value = false;
  let running = false;
  let epoch = 0;
  let unsubscribePort: (() => void) | null = null;
  let unsubscribeAppState: (() => void) | null = null;
  const listeners = new Set<(next: boolean) => void>();

  const publish = (next: boolean): void => {
    if (next === value) return;
    value = next;
    for (const listener of [...listeners]) listener(value);
  };

  const readNow = (): void => {
    if (!running) return;
    const token = ++epoch;
    let pending: Promise<boolean>;
    try {
      pending = port.read();
    } catch {
      return;
    }
    void pending.then(
      (next) => {
        // Ignore a late response that is no longer the newest one.
        if (!running || token !== epoch) return;
        publish(next);
      },
      () => {
        // A failed read is not a setting change; keep the last known value.
      },
    );
  };

  const start = (): void => {
    if (running) return;
    running = true;
    // A new session always starts with a fresh read. The last known value is
    // kept until that read (or an OS event) replaces it.
    epoch += 1;

    try {
      unsubscribePort = port.subscribe((next) => {
        if (!running) return;
        // The OS event is newer than any read still in flight.
        epoch += 1;
        publish(next);
      });
    } catch {
      unsubscribePort = null;
    }

    try {
      const subscription = options.appState?.addEventListener('change', (state) => {
        if (state === 'active') readNow();
      });
      unsubscribeAppState = subscription ? () => subscription.remove() : null;
    } catch {
      unsubscribeAppState = null;
    }

    readNow();
  };

  const stop = (): void => {
    if (!running) return;
    running = false;
    // Invalidate every pending read so it cannot publish after stop/restart.
    epoch += 1;
    unsubscribePort?.();
    unsubscribePort = null;
    unsubscribeAppState?.();
    unsubscribeAppState = null;
  };

  return {
    start,
    stop,
    get: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: readNow,
  };
}

/**
 * Small hook for screens that only need the live OS value. It starts the
 * controller on mount (and when the injected port/app-state source changes),
 * so it is not a one-shot read: OS changes and foreground returns apply.
 */
export function useReduceMotion(
  port: ReduceMotionPort = nativeReduceMotionPort,
  appState: ReduceMotionAppState = AppState,
): boolean {
  const [value, setValue] = useState(false);

  useEffect(() => {
    const controller = createReduceMotionController(port, { appState });
    const unsubscribe = controller.subscribe(setValue);
    controller.start();
    setValue(controller.get());
    return () => {
      unsubscribe();
      controller.stop();
    };
  }, [port, appState]);

  return value;
}
