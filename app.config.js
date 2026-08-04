const APP_VARIANT = process.env.APP_VARIANT ?? "development";

if (!["development", "production"].includes(APP_VARIANT)) {
  throw new Error("APP_VARIANT must be development or production.");
}

// Missing configuration must fail toward the non-store app. Every EAS store
// profile sets `production` explicitly; local Expo/EAS inspection commands do
// not all load profile env before evaluating app config.
const IS_DEV = APP_VARIANT === "development";
const RELEASE_ENVIRONMENT =
  process.env.EXPO_PUBLIC_ORCA_ENVIRONMENT ??
  (IS_DEV ? "development" : "production");

if (!["development", "preview", "production"].includes(RELEASE_ENVIRONMENT)) {
  throw new Error(
    "EXPO_PUBLIC_ORCA_ENVIRONMENT must be development, preview, or production.",
  );
}

if (IS_DEV && RELEASE_ENVIRONMENT !== "development") {
  throw new Error(
    "The development native app must use the development release environment.",
  );
}

if (!IS_DEV && RELEASE_ENVIRONMENT === "development") {
  throw new Error(
    "A store-signed native app may use preview or production, never development.",
  );
}

// APNs sandbox and APNs production issue different device tokens, and a token
// minted against one is silently undeliverable through the other. The value is
// both the `aps-environment` entitlement and the environment the app reports
// when it registers a device, so the two can never drift apart; the server
// stores devices per environment and never mixes them.
const PUSH_ENVIRONMENT = IS_DEV ? "development" : "production";

module.exports = ({ config }) => ({
  ...config,
  name: IS_DEV ? "Splotty (Dev)" : "Splotty",
  scheme: IS_DEV ? "orca-dev" : "orca",
  plugins: [
    ...(config.plugins ?? []),
    ["expo-build-properties", { ios: { deploymentTarget: "17.0" } }],
    "@sentry/react-native/expo",
    ["expo-secure-store", { configureAndroidBackup: true }],
    [
      "expo-image-picker",
      {
        // `false` removes NSPhotoLibraryUsageDescription entirely. Splotty only
        // ever opens the scoped single-image system picker, which grants access
        // to the chosen item alone and needs no library permission, so shipping
        // a broad-access usage string would describe a prompt that never
        // appears. Asserted by `scripts/check-native-config.mjs`.
        photosPermission: false,
        cameraPermission:
          "Splotty uses the camera only when you take a Moment to share privately with friends.",
        microphonePermission: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission:
          "Splotty uses the camera only when you take a Moment to share privately with friends.",
        microphonePermission: false,
        recordAudioAndroid: false,
        barcodeScannerEnabled: false,
      },
    ],
    [
      "expo-notifications",
      {
        // Only the `aps-environment` entitlement. Splotty sends user-facing
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
    releaseEnvironment: RELEASE_ENVIRONMENT,
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
