import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function readConfig(appVariant, releaseEnvironment, type = "introspect") {
  const output = execFileSync(
    "./node_modules/.bin/expo",
    ["config", "--type", type, "--json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        APP_VARIANT: appVariant,
        EXPO_PUBLIC_ORCA_ENVIRONMENT: releaseEnvironment,
      },
    },
  );
  return JSON.parse(output);
}

const developmentConfig = readConfig("development", "development");
const defaultConfig = readConfig(undefined, "development");
// Once a development native directory exists, introspection correctly reads
// that directory's current development entitlement. A clean EAS store build
// has no checked-in ios directory, so its source-of-truth is the public config
// and production notification-plugin mode until a real archive can be checked.
const testflightConfig = readConfig("production", "preview", "public");
const cameraCopy =
  "Splotty uses the camera only when you take a Moment to share privately with friends.";
const iconPath = "./assets/images/splotty-icon.png";

assert.equal(developmentConfig.name, "Splotty (Dev)");
assert.equal(defaultConfig.name, "Splotty (Dev)");
assert.equal(defaultConfig.ios.bundleIdentifier, "com.kingstondu.orca.dev");
assert.equal(testflightConfig.name, "Splotty");
assert.equal(developmentConfig.icon, iconPath);
assert.equal(testflightConfig.icon, iconPath);
assert.equal(developmentConfig.ios.icon, iconPath);
assert.equal(testflightConfig.ios.icon, iconPath);
assert.equal(developmentConfig.android.adaptiveIcon.foregroundImage, iconPath);
assert.equal(testflightConfig.android.adaptiveIcon.foregroundImage, iconPath);
assert.equal(developmentConfig.android.adaptiveIcon.backgroundColor, "#FAF8F4");
assert.equal(testflightConfig.android.adaptiveIcon.backgroundColor, "#FAF8F4");

assert.equal(developmentConfig.userInterfaceStyle, "light");
assert.equal(
  developmentConfig.ios.infoPlist.NSCameraUsageDescription,
  cameraCopy,
);
assert.equal(
  developmentConfig.ios.infoPlist.NSMicrophoneUsageDescription,
  undefined,
);

// Splotty opens only the scoped single-image system picker, which grants access to
// the chosen item alone. A broad photo-library usage string would advertise a
// permission the app must never request.
assert.equal(
  developmentConfig.ios.infoPlist.NSPhotoLibraryUsageDescription,
  undefined,
);
assert.equal(
  developmentConfig.ios.infoPlist.NSPhotoLibraryAddUsageDescription,
  undefined,
);
assert.equal(
  developmentConfig.android.permissions.includes("android.permission.CAMERA"),
  true,
);

// Push is one entitlement and nothing more. `remote-notification` would let the
// app be woken silently; Splotty only ever shows a generic alert the user tapped,
// so the background mode must stay absent.
assert.equal(
  developmentConfig.ios.entitlements["aps-environment"],
  "development",
);
assert.equal(
  (developmentConfig.ios.infoPlist.UIBackgroundModes ?? []).includes(
    "remote-notification",
  ),
  false,
  "remote-notification background mode must remain absent",
);
// The environment the app reports when registering a device has to be the same
// string as the entitlement, or every token would be minted against one APNs
// environment and sent through the other.
assert.equal(developmentConfig.extra.pushEnvironment, "development");
assert.equal(developmentConfig.extra.releaseEnvironment, "development");
assert.equal(developmentConfig.ios.bundleIdentifier, "com.kingstondu.orca.dev");

// A TestFlight binary is store-signed and therefore always uses APNs
// production, even while its first founder-only build talks to the hosted
// development backend. The separate release label prevents that deliberate
// temporary backend choice from being mistaken for production.
assert.equal(testflightConfig.extra.pushEnvironment, "production");
assert.equal(testflightConfig.extra.releaseEnvironment, "preview");
assert.equal(testflightConfig.ios.bundleIdentifier, "com.kingstondu.orca");

const testflightNotificationsPlugin = testflightConfig.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === "expo-notifications",
);
assert.equal(testflightNotificationsPlugin[1].mode, "production");
assert.equal(
  testflightNotificationsPlugin[1].enableBackgroundRemoteNotifications,
  false,
);

const testflightBuildPropertiesPlugin = testflightConfig.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === "expo-build-properties",
);
assert.equal(
  testflightBuildPropertiesPlugin[1].ios.deploymentTarget,
  "17.0",
  "expo-build-properties must persist the iOS 17 deployment target",
);

for (const permission of [
  "android.permission.RECORD_AUDIO",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.ACCESS_MEDIA_LOCATION",
]) {
  assert.equal(
    developmentConfig.android.permissions.includes(permission),
    false,
    `${permission} must remain absent`,
  );
}

console.log(
  "Generated development and clean-build TestFlight configs are environment-bound, iOS 17, and least-privilege.",
);
