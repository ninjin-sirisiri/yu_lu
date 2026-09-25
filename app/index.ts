// Startup side effects (service initialization, polyfills, LogBox config, ...)
// must run before the router boots. Keep them above the expo-router entry
// import and always import 'expo-router/entry' last so the root layout
// (src/app/_layout.tsx) is registered only after startup is complete.
import 'expo-router/entry';
