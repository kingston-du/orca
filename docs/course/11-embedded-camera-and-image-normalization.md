# Embedded camera and bounded image normalization

> **Active foundation; downstream contract superseded.** The embedded camera lifecycle, permission minimization, selfie/orientation behavior, and bounded JPEG normalizer remain current code. Checkpoint 1A removed Circle-facing copy but did not yet change picker evidence or add publication. Phase 3 must classify missing or unreliable picker capture metadata as Archive under [`PROJECT.md`](../../PROJECT.md).

## What we built

Orca's Camera tab now has a low-friction embedded **photo** camera, with the
system library picker still available as a fallback. Every successful camera or
library choice is rendered into one bounded JPEG before it reaches the preview.
The preview is only local React state: it does not upload, persist a draft, or
create a database row.

This is the next Phase 4 boundary after Lesson 10. The July 30 product decision
made the embedded camera the primary capture surface because fewer context
switches matter to casual group posting. It deliberately does **not** add video,
filters, effects, microphone access, or a custom native camera module. Expo
Camera is the SDK-supported native surface for this scope.

By the end of this checkpoint, the useful mental model is:

```text
CameraView or scoped system library picker
        ↓ temporary device URI and reported dimensions
normalizer renders a new bounded JPEG
        ↓ measured output URI, dimensions, bytes, and capture-time provenance
in-memory preview only
        ↓ later checkpoint (not built yet)
pending post → exact private Storage object → trusted finalize/publish
```

The distinction is important: a URI or picker result is device input, not a
trusted publishable post. The eventual backend must still authorize the caller,
the Circle, the exact pending post, and the Storage path. This lesson adds no
database migration, Storage bucket, RPC, upload, or persistence.

## Native permission contract

[`app.config.js`](../../app.config.js) configures both ImagePicker and
`expo-camera` at build time. The two plugins have the same narrow camera
explanation, and each explicitly disables microphone support:

```js
[
  "expo-camera",
  {
    cameraPermission:
      "Orca uses the camera only when you take a photo to share privately with a Circle.",
    microphonePermission: false,
    recordAudioAndroid: false,
    barcodeScannerEnabled: false,
  },
];
```

`microphonePermission: false` and `recordAudioAndroid: false` are product and
privacy decisions, not decorative configuration. Orca is photo-only and should
not declare an unrelated sensitive capability merely because a camera library
can support video. The Android `blockedPermissions` list remains defense in
depth: it removes audio recording, broad/legacy external-storage reads and
writes, broad media categories, and media-location access contributed by
dependencies. The system library picker gets access to the item a person picks;
`choosePhoto` does not request broad library permission.

These declarations affect the generated native application, so changing them
requires a new EAS development build. Expo Go and the simulator cannot prove
the final app manifest or a real phone's permission behavior. Rebuilding the
media-enabled EAS development client and accepting it on physical devices remain
pending.

## Camera lifecycle: mount only when a preview is useful

[`PhotoCaptureScreen`](../../src/features/posts/photo-capture-screen.tsx) owns
this screen-local state. `cameraIsMounted` has four conditions:

```ts
const cameraIsMounted =
  isFocused &&
  appState === "active" &&
  permission?.granted === true &&
  photo === null &&
  !cameraUnavailable;
```

`useIsFocused()` unmounts the native preview when this tab is covered by another
route. The `AppState` listener unmounts it while the app is backgrounded.
Permission is separate from a request: merely opening Camera does not trigger a
system prompt. Finally, a preview replaces the camera so the native session is
not left running behind an image.

This solves a common native-UI failure mode. A `CameraView` holds hardware and
an asynchronous session; treating it like an ordinary decorative React view can
leave the camera running in the background or call its imperative API while it
is being recreated.

The component uses two readiness guards:

```ts
const cameraRef = useRef<CameraView>(null);
const [readyCameraSession, setReadyCameraSession] = useState<string | null>(null);
const cameraSession = `${isFocused}:${appState}:${photo === null ? "capture" : "preview"}:${cameraUnavailable}:${facing}`;

onCameraReady={() => setReadyCameraSession(cameraSession)}
```

The ref identifies the mounted native view, but a non-null ref alone does not
mean its camera session is ready. The session string ties the ready callback to
the current conditions. Flipping facing direction clears readiness; the shutter
stays disabled until the newly mounted/reconfigured camera reports
`onCameraReady`. Going away and returning likewise requires a fresh ready
signal. `onMountError` converts a native failure into an understandable fallback
instead of a dead camera screen.

`actionInFlight` is deliberately a ref rather than state. It prevents two
immediate taps from starting two native captures before React has rendered the
disabled button. `activeAction` is the parallel UI state: it disables controls
and exposes accessible busy state. `isMounted` prevents an interrupted
permission, picker, capture, or normalization promise from setting state after
unmount.

## Permission and fallback flow

On a first visit with no grant, the screen renders “Use Camera” and “Choose
Photo”; it does not request anything automatically. A tap calls
`requestCameraPermission()` inside `runAction`.

```text
Use Camera
  ├─ granted → mount CameraView; wait for onCameraReady
  ├─ denied, can ask again → explain that the user can try again
  ├─ denied permanently → offer Linking.openSettings()
  └─ request/native mount failure → explain and retain library fallback

Choose Photo → scoped OS picker → canceled / error / normalized preview
```

The library fallback is intentionally available for every camera outcome,
including a granted permission followed by a mount failure. A user should still
be able to contribute a photo if this device's camera is unavailable. Android
may destroy Orca's activity while the external picker is open;
`restorePendingPhoto()` calls `getPendingResultAsync()` only on Android and
normalizes a returned item with source `restored`.

The picker boundary in
[`photo-picker.ts`](../../src/features/posts/photo-picker.ts) asks for one image,
no editing, no base64, no EXIF, and one selection:

```ts
const PHOTO_PICKER_OPTIONS = {
  mediaTypes: ["images"],
  allowsMultipleSelection: false,
  allowsEditing: false,
  base64: false,
  exif: false,
  quality: 1,
};
```

Those options limit what Orca asks ImagePicker to return. They are not a
security proof that any source file lacks metadata, which is why normalization
creates a fresh file and later device acceptance must inspect the real result.

## Capture and normalization contract

The embedded camera passes deliberately explicit options to
`takePictureAsync`:

```ts
const CAMERA_PICTURE_OPTIONS = {
  quality: 1,
  base64: false,
  exif: false,
  skipProcessing: false,
} as const;
```

No base64 avoids duplicating a potentially large image in JavaScript memory; the
temporary file URI is enough. `exif: false` avoids asking Expo Camera to return
EXIF to JavaScript. `skipProcessing: false` keeps Expo's normal platform image
processing enabled, rather than optimizing for a raw/unprocessed shortcut.
Normalization is the consistent output contract for both camera and library
inputs, so a PNG or very large library JPEG does not become a special upload
case later.

[`photo-normalizer.ts`](../../src/features/posts/photo-normalizer.ts) defines
the current limits:

| Property             | Contract            | Reason                                  |
| -------------------- | ------------------- | --------------------------------------- |
| Long edge            | at most 2048 pixels | bounded pixels, memory, and upload work |
| Format               | JPEG                | one V1 media representation             |
| Compression          | 0.82                | sensible quality/size baseline          |
| Bytes                | at most 6 MiB       | a hard pre-upload client bound          |
| Base64/returned EXIF | disabled            | avoid retaining unnecessary data in JS  |

The resize math preserves aspect ratio. For input width `w`, height `h`, and
`L = max(w, h)`, leave dimensions unchanged when `L ≤ 2048`. Otherwise use
`scale = 2048 / L` and output `round(w × scale) × round(h × scale)`, with each
edge at least one pixel. Thus `4000 × 3000` becomes `2048 × 1536`, and
`3000 × 4000` becomes `1536 × 2048`. Invalid, fractional, zero, or negative
dimensions throw `PhotoNormalizationError` before native rendering starts.

The important implementation sequence is:

```ts
const context = ImageManipulator.manipulate(input.uri);
if (dimensions changed) context.resize(dimensions);
const renderedImage = await context.renderAsync();
const result = await renderedImage.saveAsync({
  base64: false, compress: 0.82, format: SaveFormat.JPEG,
});
const byteSize = new File(result.uri).size;
assertNormalizedPhotoBounds(result.width, result.height, byteSize);
```

The `ImageManipulator` render/save step creates the output JPEG; the result's
reported dimensions and `File(...).size` are checked after that work, rather
than trusting input dimensions or a source `fileSize`. `assertNormalizedPhotoBounds`
rejects a zero/non-integer byte count, output whose long edge exceeds 2048, and
anything over 6 MiB. A high-detail but small-pixel image can still exceed the
byte cap; the current behavior is an explicit recoverable preparation error,
not a silent oversized upload. There is no iterative quality-downsampling loop
yet—adding one would be a separate product-quality decision.

Rendering a fresh JPEG is the intended metadata minimization step. It does not
by itself let us claim a verified EXIF/GPS guarantee across iOS versions and
image sources. Physical-iPhone acceptance must inspect real normalized files
for orientation, dimensions, byte count, and metadata before a server trusts
this as the privacy contract. Until then, `exif: false` is a request not to
return metadata to JavaScript, and the new JPEG is a bounded client-side
preparation boundary—not a complete server-side security boundary.

## Capture time, offset, and provenance

`getDeviceCaptureTime()` returns an ISO 8601 UTC instant plus the device's
conventional signed offset:

```ts
capturedAt: date.toISOString(),
capturedUtcOffsetMinutes: -date.getTimezoneOffset(),
```

JavaScript's `getTimezoneOffset()` is counterintuitive: it reports minutes west
of UTC. Negating it means Los Angeles during daylight time is `-420`, matching
the conventional “UTC−07:00” representation. Validation accepts only an integer
offset from `-840` to `840` and a parseable timestamp.

The output also carries `source` (`camera`, `library`, or Android `restored`)
and `capturedAtSource`. A camera capture records `capturedAtSource: "camera"`.
For library/restored items this checkpoint intentionally records the device time
with `"fallback"`; it does **not** retain picker EXIF or GPS metadata. A future
post workflow can introduce a trusted capture-time policy (metadata or a user
choice) without falsely presenting the fallback as original photo history.

These fields are local provenance for the future post workflow, not yet a
database fact. The server will ultimately decide which submitted values it
accepts and associate a published post's `created_at` with sharing time.

## Tests, evidence, and debugging

The three focused suites isolate the native APIs and test the decisions Orca
owns:

- [`photo-capture-screen.test.tsx`](../../src/features/posts/__tests__/photo-capture-screen.test.tsx)
  proves the preview mounts only when focused, active, permitted, and without a
  selected photo; a permanent denial offers Settings; readiness gates capture;
  a flip requires a new ready callback; duplicate shutter taps produce one
  capture; the exact options and normalizer provenance are passed; retake
  remounts capture; and a mount failure retains the library path.
- [`photo-picker.test.ts`](../../src/features/posts/__tests__/photo-picker.test.ts)
  proves there is no broad media-library permission request, the restrictive
  picker options are used, source-only preview fields survive while asset ID,
  EXIF, and base64 are not retained, and Android restoration is normalized as
  `restored`.
- [`photo-normalizer.test.ts`](../../src/features/posts/__tests__/photo-normalizer.test.ts)
  proves dimension math, invalid-dimension rejection, the ISO/offset convention,
  JPEG encoding at `0.82`, measured output size, and both dimension and byte
  rejection paths.

Static mocks cannot prove native image pixels or metadata. The recorded
checkpoint evidence is 70 app tests, TypeScript, formatting, zero-warning lint,
Expo compatibility, Expo Doctor 20/20, generated iOS/Android permission
inspection, the unchanged 263-assertion database baseline, and an iOS export. Those are meaningful regression checks,
but they do not replace a physical iPhone camera/metadata acceptance pass or
the EAS rebuild still required by the changed native plugins.

When debugging a device issue, first identify the layer rather than changing
several things at once:

1. If no permission prompt appears, inspect the installed development build's
   native configuration—not Expo Go—and confirm the app was rebuilt after the
   plugin change.
2. If the shutter stays disabled, check focus, `AppState`, permission,
   `cameraUnavailable`, and whether `onCameraReady` fired for the latest
   session (especially after a flip or return from background).
3. If preparation fails, log the source URI/dimensions and inspect the
   normalizer error path; do not substitute the original URI and bypass the
   JPEG/byte contract.
4. On physical iPhone, capture portrait/landscape and imported photos, then
   inspect the normalized output's orientation, dimensions, byte size, and
   metadata before declaring the privacy contract accepted.

## What remains next

The next media milestone is not “upload this URI.” It is the private
pending-upload-publish backend: reserve a pending post, authorize an exact
immutable Storage path, upload the normalized JPEG, have trusted code verify
the stored bytes, then publish idempotently with cleanup/retry behavior. That
will add the required database and Storage authorization work. This checkpoint
has intentionally made none of those remote changes.

## Understanding question

Why do we wait for `onCameraReady` _and_ re-check the current camera session
before allowing `takePictureAsync`, instead of enabling the shutter whenever a
`CameraView` ref exists?
