// Settings for Mozilla's web-ext tool (npm run lint / start:firefox /
// start:chrome). It works on the built extension in dist/, so run
// `node build.mjs` first (the npm scripts do). web-ext reloads the extension
// when dist/ changes: run `npm run build` again after editing src/.
export default {
  sourceDir: 'dist/firefox',
  artifactsDir: 'dist/web-ext-artifacts',
  lint: {
    // RELEASE.md expects 0 errors and 0 warnings.
    warningsAsErrors: true,
  },
  run: {
    startUrl: ['https://www.twitch.tv/'],
    browserConsole: false,
  },
};
