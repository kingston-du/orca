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
        photosPermission:
          "Orca lets you choose one photo to share privately with a Circle.",
        cameraPermission:
          "Orca uses the camera only when you take a photo to share privately with a Circle.",
        microphonePermission: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission:
          "Orca uses the camera only when you take a photo to share privately with a Circle.",
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
