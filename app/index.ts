// Startup side effects (service initialization, polyfills, LogBox config, ...)
// must run before the router boots. Keep them above the expo-router entry
// import and always import 'expo-router/entry' last so the root layout
// (src/app/_layout.tsx) is registered only after startup is complete.
//
// Task 20: the TaskManager background-task definition must exist BEFORE the
// Router entry evaluates — the OS can launch the JS bundle headless for a
// background execution where no screen ever mounts. ES module imports
// evaluate in declaration order, so importing src/sync/background here (its
// module body calls TaskManager.defineTask) runs it before
// 'expo-router/entry' below. The statement bodies afterwards only attach
// listeners / schedule with the OS, which do not need global scope.
import {
  isBackgroundSyncTaskDefined,
  registerBackgroundSyncTask,
} from './src/sync/background';
import { startSharedSyncLifecycle } from './src/sync/lifecycle';
import 'expo-router/entry';

// Scheduling with the OS is idempotent and degrades to a no-op where the
// platform reports Restricted (simulator / Expo Go): the foreground,
// resume and network drains keep covering the queue either way. The dev
// log is the device-side evidence of what the OS actually answered.
void registerBackgroundSyncTask().then((outcome) => {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.log(`[sync] background task registration: ${outcome}`);
  }
});

// App-state (復帰) + network (接続復帰) listeners over the ONE shared
// lifecycle, plus the initial foreground drain (task-kill recovery). All
// failures are swallowed inside the lifecycle — startup never blocks.
startSharedSyncLifecycle();

// Diagnostics: proves at startup (and in tests) that the task definition
// survived module evaluation, i.e. it was registered before the Router ran.
if (!isBackgroundSyncTaskDefined()) {
  // Observable in dev builds; never fatal (the 復帰 drains still run).
  // eslint-disable-next-line no-console
  console.warn('[sync] background task definition missing; OS trigger disabled');
}
