function resolveBabelPreset() {
  // Prefer the documented package name when it is hoisted to the project root.
  try {
    return require.resolve('babel-preset-expo');
  } catch {
    // npm keeps babel-preset-expo nested under expo/ in this project, so fall
    // back to the copy Expo itself resolves (SDK 57 ships it as a dependency).
    return require.resolve('./node_modules/expo/node_modules/babel-preset-expo/build/index.js');
  }
}

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [resolveBabelPreset()],
  };
};
