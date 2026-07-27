const IS_DEV = process.env.APP_VARIANT === "development";

module.exports = ({ config }) => ({
  ...config,
  name: IS_DEV ? "Orca (Dev)" : "Orca",
  scheme: IS_DEV ? "orca-dev" : "orca",
  plugins: [
    ...(config.plugins ?? []),
    ["expo-secure-store", { configureAndroidBackup: true }],
  ],
  ios: {
    ...config.ios,
    bundleIdentifier: IS_DEV
      ? "com.kingstondu.orca.dev"
      : "com.kingstondu.orca",
    config: {
      ...config.ios?.config,
      usesNonExemptEncryption: false,
    },
  },
  android: {
    ...config.android,
    package: IS_DEV ? "com.kingstondu.orca.dev" : "com.kingstondu.orca",
  },
});
