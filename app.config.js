const IS_DEV = process.env.APP_VARIANT === "development";

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
