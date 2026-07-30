# The native photo-selection boundary

## What we built and why it comes before Storage

Phase 4 is Orca's first photo pipeline. A photo begins on a device, becomes a normalized private file, is uploaded to one exact Storage path, and finally becomes a published database row. Those are separate trust boundaries:

```text
system camera or photo picker
        ↓ temporary device URI
Orca's in-memory selection state       ← this checkpoint
        ↓ normalized bounded JPEG
one retryable private draft
        ↓ exact immutable Storage path
pending post + private object
        ↓ trusted byte verification
published post
```

This checkpoint deliberately stops after the first boundary. It proves Orca can receive one image from system UI without silently requesting microphone, location, contacts, or whole-library access. Nothing is uploaded, persisted, or treated as safe image bytes yet.

That order matters. If picker output flowed directly into Storage, client-reported MIME type, dimensions, orientation, and metadata would accidentally become security inputs. The next checkpoint creates a new JPEG and verifies what it actually contains.

## Why these two Expo packages exist

`expo-image-picker` opens operating-system camera and photo-selection UI. Orca does not build a custom camera.

`expo-image-manipulator` will create the normalized JPEG in the next checkpoint. Installing it now lets the native binary include the complete first media boundary before development clients are rebuilt.

Both were installed through `npx expo install`, so Expo selected the SDK 57-compatible `~57.0.7` versions. We did **not** add extra packages speculatively:

- React Native's `Image` is sufficient for this local preview.
- `expo-file-system` becomes a direct dependency when Orca first imports its `File` API for bytes or retryable drafts.
- `expo-image` becomes justified when private remote media needs an explicit memory-only cache policy.
- No base64 helper is needed; the future file API can produce an `ArrayBuffer` directly.

## Build-time permission configuration

The plugin configuration lives in [`app.config.js`](../../app.config.js), not the screen. Native permission declarations are compiled into the iOS and Android apps; JavaScript cannot safely remove an unwanted permission after installation.

The ImagePicker plugin supplies two narrow explanations:

```js
photosPermission:
  "Orca lets you choose one photo to share privately with a Circle.",
cameraPermission:
  "Orca uses the camera only when you take a photo to share privately with a Circle.",
microphonePermission: false,
```

`microphonePermission: false` matters because ImagePicker supports video-oriented native paths too, even though Orca is photo-only. Orca neither records audio nor needs a microphone usage description.

The Android `blockedPermissions` list is defense in depth. Dependencies can contribute permissions through their own manifests. Expo turns each blocked entry into a manifest merge rule that removes it from the final application. Orca blocks recording audio, legacy external-storage reads/writes, modern media-library categories, and media-location access. Camera access remains because Take Photo genuinely needs it.

The generated development configuration was inspected for both layers:

- iOS contains only Orca's camera and chosen-photo descriptions—no microphone, location, or contacts key.
- Android's generated manifest contains removal rules for every blocked media permission.
- ImagePicker's package manifest contributes `CAMERA`; its legacy broad-storage declarations are matched by Orca's removal rules.

The final merged Android binary still needs confirmation in the rebuilt EAS development client because this Mac does not have an Android SDK installed. Expo Go also cannot prove app-specific build-time permissions: Expo Go has its own manifest.

## The runtime picker contract

The feature boundary is [`photo-picker.ts`](../../src/features/posts/photo-picker.ts). The screen never handles raw ImagePicker result shapes directly.

### A discriminated union makes every outcome explicit

```ts
export type PhotoPickerOutcome =
  | { kind: "selected"; photo: SelectedPhotoPreview }
  | { kind: "canceled" }
  | { kind: "camera-permission-denied"; canAskAgain: boolean }
  | { kind: "error"; source: PhotoSource };
```

The `kind` field is the **discriminant**. Once code checks `outcome.kind === "selected"`, TypeScript knows the `photo` field exists. This avoids combinations such as “canceled but also has a photo” or scattered `undefined` checks.

Cancellation is not an error. It means the user changed their mind, so the screen quietly preserves the existing state.

### `satisfies` checks options without widening them

[`PHOTO_PICKER_OPTIONS`](../../src/features/posts/photo-picker.ts) uses:

```ts
const PHOTO_PICKER_OPTIONS = {
  mediaTypes: ["images"],
  allowsMultipleSelection: false,
  allowsEditing: false,
  base64: false,
  exif: false,
  quality: 1,
} satisfies ImagePicker.ImagePickerOptions;
```

`satisfies` asks TypeScript to verify that this object is a valid `ImagePickerOptions` value while preserving the object's precise inferred values. Important choices are visible in one place:

- image-only and one selection;
- no system cropper, because normalization owns transformations;
- no base64 copy, which would increase memory use;
- no EXIF request, so the current screen never receives location metadata;
- original-quality picker output, which is still only an untrusted normalization input.

### Choosing does not request the whole library

[`choosePhoto()`](../../src/features/posts/photo-picker.ts) calls the system picker directly. On current iOS/Android this grants Orca access to the selected item rather than asking for broad library access. The focused test asserts that `requestMediaLibraryPermissionsAsync` is never called.

### Camera permission is lazy

[`takePhoto()`](../../src/features/posts/photo-picker.ts) first reads camera permission **after** the user presses Take Photo. If the OS can still ask, Orca requests it once. If permission is denied:

- `canAskAgain: true` explains that the user can retry;
- `canAskAgain: false` offers an Open Settings action;
- the camera never launches without permission.

A rejected native camera call becomes a safe “camera unavailable” result. This is the expected simulator behavior because an iOS Simulator has no physical camera.

### Android activity restoration

Android may destroy Orca's activity while the external picker is open. [`restorePendingPhoto()`](../../src/features/posts/photo-picker.ts) calls `getPendingResultAsync()` only on Android. The screen checks it on mount and ignores a late result after unmount. This prevents a selected photo from disappearing merely because Android reclaimed the activity.

## The React screen

The route [`camera.tsx`](<../../src/app/(app)/(tabs)/camera.tsx>) is intentionally thin. UI and behavior live in [`photo-source-picker-screen.tsx`](../../src/features/posts/photo-source-picker-screen.tsx), where the feature can be tested without a router.

The selected value contains only:

```ts
{
  (uri, width, height, source);
}
```

Picker-provided filename, asset ID, MIME string, base64, and EXIF are discarded. Even the retained dimensions are preview hints, not trusted server facts.

`useState` owns visible state: which action is loading, the current preview, and a user-facing error. `useRef` owns the duplicate-action lock:

```ts
if (actionInFlight.current) return;
actionInFlight.current = true;
```

A ref changes immediately without waiting for React to paint. That closes the tiny window in which two rapid taps could open two native pickers. The buttons also expose disabled and busy accessibility state, errors use the alert role, and successful selection is announced to screen readers.

The preview text explicitly says “Nothing is uploaded yet.” That is both accurate UX and a useful debugging boundary: a problem before normalization cannot be a Supabase Storage problem.

## Failure ownership

| Failure                            | Owning layer             | Behavior                                              |
| ---------------------------------- | ------------------------ | ----------------------------------------------------- |
| User cancels system UI             | Picker boundary          | No error and no state loss.                           |
| Camera permission denied           | Picker boundary + screen | Retry explanation or Open Settings.                   |
| Simulator/device has no camera     | Native picker            | Safe fallback to Choose Photo.                        |
| Android destroys activity          | Picker boundary          | Recover pending result on mount.                      |
| Rapid duplicate tap                | Screen                   | Immediate ref lock plus disabled buttons.             |
| Picker reports video/live photo    | Picker boundary          | Reject despite image-only options.                    |
| GPS/EXIF appears in raw asset      | Data minimization        | Never copied into screen state.                       |
| Malicious or malformed image bytes | Not solved here          | Next normalization plus trusted finalizer checkpoint. |

## How the tests connect to behavior

[`photo-picker.test.ts`](../../src/features/posts/__tests__/photo-picker.test.ts) gives the picker a fake asset containing an asset ID, GPS EXIF, and base64. The expected Orca result contains only URI, dimensions, and source. It also proves:

- no broad library permission request;
- camera permission is lazy;
- permanent denial never launches the camera;
- native camera failure becomes a safe result;
- Android pending selection is restored.

[`photo-source-picker-screen.test.tsx`](../../src/features/posts/__tests__/photo-source-picker-screen.test.tsx) proves the user-facing connection:

- a chosen image appears as a local preview;
- cancellation stays quiet;
- a second action is blocked while one is pending;
- permanent denial offers Settings;
- unavailable camera suggests the library path.

These tests do not pretend to replace physical-device checks. System picker presentation, real permission dialogs, rotation, large files, screenshots, and activity destruction still need development-build acceptance.

## Verification evidence

- SDK-compatible packages resolved to `~57.0.7`
- Development and production identities preserve the same least-privilege plugin configuration
- Temporary native prebuild completed for iOS and Android
- Generated iOS permission keys inspected
- Generated Android permission removal rules and ImagePicker library manifest inspected
- 10 focused picker/component tests, plus the full existing app suite
- TypeScript, formatting, zero-warning lint, Expo compatibility, Expo Doctor, and iOS export gates
- No database migration, Storage bucket, remote build, upload, or hosted data change

## What comes next

The next checkpoint normalizes every selected input into a bounded JPEG, verifies orientation/dimensions/byte size, and experimentally confirms whether unwanted metadata is absent. Only after that contract is green should Orca add pending posts and the private `post-media` bucket.

## Understanding question

Why is “the picker says this file is a JPEG” insufficient evidence for the trusted publish step?
