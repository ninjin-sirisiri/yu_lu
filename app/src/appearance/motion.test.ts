import {
  createReduceMotionController,
  type ReduceMotionAppState,
  type ReduceMotionPort,
} from './motion';

/**
 * Task 9: OS 動き軽減 (reduce motion) is read at start, followed while the app
 * is running and re-read when the app returns to the foreground. The port is
 * injected so the controller can be tested without a native runtime.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FakeReduceMotionPort implements ReduceMotionPort {
  readonly reads: Array<Deferred<boolean>> = [];
  readonly listeners = new Set<(value: boolean) => void>();

  read(): Promise<boolean> {
    const next = deferred<boolean>();
    this.reads.push(next);
    return next.promise;
  }

  subscribe(listener: (value: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: boolean): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  resolveRead(index: number, value: boolean): void {
    this.reads[index].resolve(value);
  }
}

function fakeAppState(): {
  appState: ReduceMotionAppState;
  emitActive(): void;
  listenerCount(): number;
} {
  const listeners = new Set<(state: string) => void>();
  return {
    appState: {
      addEventListener: (_type, handler) => {
        listeners.add(handler);
        return {
          remove: () => {
            listeners.delete(handler);
          },
        };
      },
    },
    emitActive: () => {
      for (const handler of [...listeners]) handler('active');
    },
    listenerCount: () => listeners.size,
  };
}

describe('reduce-motion controller', () => {
  it('reads the OS value once at start and publishes it', async () => {
    const port = new FakeReduceMotionPort();
    const controller = createReduceMotionController(port);
    const seen: boolean[] = [];
    controller.subscribe((value) => seen.push(value));

    expect(controller.get()).toBe(false);
    controller.start();
    expect(port.reads).toHaveLength(1);

    port.resolveRead(0, true);
    await flush();

    expect(controller.get()).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('follows OS changes while running', async () => {
    const port = new FakeReduceMotionPort();
    const controller = createReduceMotionController(port);
    controller.start();
    port.resolveRead(0, false);
    await flush();

    port.emit(true);
    expect(controller.get()).toBe(true);
    port.emit(false);
    expect(controller.get()).toBe(false);
  });

  it('re-reads the OS value when the app returns to the foreground', async () => {
    const port = new FakeReduceMotionPort();
    const { appState, emitActive, listenerCount } = fakeAppState();
    const controller = createReduceMotionController(port, { appState });
    controller.start();
    port.resolveRead(0, false);
    await flush();
    expect(controller.get()).toBe(false);

    emitActive();
    expect(port.reads).toHaveLength(2);
    port.resolveRead(1, true);
    await flush();
    expect(controller.get()).toBe(true);
    expect(listenerCount()).toBe(1);
  });

  it('does not let a stale initial response overwrite a newer read', async () => {
    const port = new FakeReduceMotionPort();
    const controller = createReduceMotionController(port);
    controller.start();
    // A refresh (or foreground re-read) starts before the initial read lands.
    controller.refresh();
    expect(port.reads).toHaveLength(2);

    port.resolveRead(1, true);
    await flush();
    expect(controller.get()).toBe(true);

    // The older request resolves last and must be ignored.
    port.resolveRead(0, false);
    await flush();
    expect(controller.get()).toBe(true);
  });

  it('does not let an OS change be overwritten by an older pending read', async () => {
    const port = new FakeReduceMotionPort();
    const controller = createReduceMotionController(port);
    controller.start();

    port.emit(true);
    expect(controller.get()).toBe(true);
    port.resolveRead(0, false);
    await flush();
    expect(controller.get()).toBe(true);
  });

  it('releases the OS and app-state subscriptions on stop', async () => {
    const port = new FakeReduceMotionPort();
    const { appState, emitActive, listenerCount } = fakeAppState();
    const controller = createReduceMotionController(port, { appState });
    controller.start();
    port.resolveRead(0, false);
    await flush();

    expect(port.listeners.size).toBe(1);
    expect(listenerCount()).toBe(1);

    controller.stop();
    expect(port.listeners.size).toBe(0);
    expect(listenerCount()).toBe(0);

    port.emit(true);
    emitActive();
    expect(port.reads).toHaveLength(1);
    expect(controller.get()).toBe(false);
  });
});
