import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const output = execFileSync(
  "./node_modules/.bin/expo",
  ["config", "--type", "introspect", "--json"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, APP_VARIANT: "development" },
  },
);
const config = JSON.parse(output);
const cameraCopy =
  "Orca uses the camera only when you take a Moment to share privately with friends.";

assert.equal(config.userInterfaceStyle, "light");
assert.equal(config.ios.infoPlist.NSCameraUsageDescription, cameraCopy);
assert.equal(config.ios.infoPlist.NSMicrophoneUsageDescription, undefined);

// Orca opens only the scoped single-image system picker, which grants access to
// the chosen item alone. A broad photo-library usage string would advertise a
// permission the app must never request.
assert.equal(config.ios.infoPlist.NSPhotoLibraryUsageDescription, undefined);
assert.equal(config.ios.infoPlist.NSPhotoLibraryAddUsageDescription, undefined);
assert.equal(
  config.android.permissions.includes("android.permission.CAMERA"),
  true,
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
    config.android.permissions.includes(permission),
    false,
    `${permission} must remain absent`,
  );
}

console.log(
  "Native config is light-mode and least-privilege for friend-first camera use, with no broad photo-library permission.",
);
