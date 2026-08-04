const { getSentryExpoConfig } = require("@sentry/react-native/metro");

/**
 * Sentry needs Metro debug IDs to match a shipped bundle to its source map.
 * Replay stays excluded at the bundler as well as at runtime: private Moment
 * pixels should never enter a diagnostic payload or even its support code.
 */
module.exports = getSentryExpoConfig(__dirname, {
  annotateReactComponents: false,
  includeWebReplay: false,
});
