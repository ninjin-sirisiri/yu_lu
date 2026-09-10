module.exports = function (api) {
  api.cache(true);
  return {
    presets: [require.resolve('./node_modules/expo/node_modules/babel-preset-expo/build/index.js')],
  };
};
