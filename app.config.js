const IS_DEV = process.env.APP_VARIANT === "development";

// APNs sandbox and APNs production issue different device tokens, and a token
// minted against one is silently undeliverable through the other. The value is
// both the `aps-environment` entitlement and the environment the app reports
// when it registers a device, so the two can never drift apart; the server
// stores devices per environment and never mixes them.
const PUSH_ENVIRONMENT = IS_DEV ? "development" : "production";

module.exports = ({ config }) => ({
  ...config,
  name: IS_DEV ? "Orca (Dev)" : "Orca",
  scheme: IS_DEV ? "orca-dev" : "orca",
  plugins: [
    ...(config.plugins ?? []),
    ["expo-secure-store", { configureAndroidBackup: true }],
    [
      "expo-image-picker",
      {
        // `false` removes NSPhotoLibraryUsageDescription entirely. Orca only
        // ever opens the scoped single-image system picker, which grants access
        // to the chosen item alone and needs no library permission, so shipping
        // a broad-access usage string would describe a prompt that never
        // appears. Asserted by `scripts/check-native-config.mjs`.
        photosPermission: false,
        cameraPermission:
          "Orca uses the camera only when you take a Moment to share privately with friends.",
        microphonePermission: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission:
          "Orca uses the camera only when you take a Moment to share privately with friends.",
        microphonePermission: false,
        recordAudioAndroid: false,
        barcodeScannerEnabled: false,
      },
    ],
    [
      "expo-notifications",
      {
        // Only the `aps-environment` entitlement. Orca sends user-facing
        // alerts and nothing else, so `enableBackgroundRemoteNotifications`
        // stays off: adding `remote-notification` to `UIBackgroundModes` would
        // claim the ability to wake the app silently, which is a capability
        // this product neither uses nor wants to justify at review.
        mode: PUSH_ENVIRONMENT,
        enableBackgroundRemoteNotifications: false,
      },
    ],
  ],
  extra: {
    ...config.extra,
    pushEnvironment: PUSH_ENVIRONMENT,
  },
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
    blockedPermissions: [
      ...(config.android?.blockedPermissions ?? []),
      "android.permission.RECORD_AUDIO",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.READ_MEDIA_AUDIO",
      "android.permission.ACCESS_MEDIA_LOCATION",
    ],
  },
});
