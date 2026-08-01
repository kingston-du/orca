import {
  buildStorageObjectUrl,
  buildUploadHeaders,
  classifyUploadResponse,
  readEffectiveStatus,
  startReservedObjectUpload,
} from "@/lib/reserved-object-upload";

// `jest.mock` is hoisted above the import, so the mock is in place before the
// module under test is evaluated.
jest.mock("@/lib/supabase", () => ({
  supabaseUrl: "https://example.supabase.test",
}));

const mockCreateUploadTask = jest.fn();

jest.mock("expo-file-system", () => ({
  File: jest.fn().mockImplementation(() => ({
    createUploadTask: mockCreateUploadTask,
  })),
}));

function fakeTask(behaviour: {
  status?: number;
  body?: string;
  reject?: unknown;
  onStart?: (options: { onProgress?: (data: unknown) => void }) => void;
}) {
  const cancel = jest.fn();
  const release = jest.fn();
  mockCreateUploadTask.mockImplementation((_url: string, options: never) => ({
    cancel,
    release,
    uploadAsync: async () => {
      behaviour.onStart?.(options);
      if (behaviour.reject) throw behaviour.reject;
      return {
        body: behaviour.body ?? "",
        headers: {},
        status: behaviour.status ?? 200,
      };
    },
  }));
  return { cancel, release };
}

const request = {
  accessToken: "token-abc",
  bucketId: "avatars",
  fileUri: "file:///tmp/avatar.jpg",
  objectPath: "user-1/version-1.jpg",
  publishableKey: "sb_publishable_key",
};

beforeEach(() => {
  mockCreateUploadTask.mockReset();
});

describe("reserved object URL and headers", () => {
  test("builds the standard Storage object URL with each segment encoded", () => {
    expect(buildStorageObjectUrl("avatars", "user 1/version+1.jpg")).toBe(
      "https://example.supabase.test/storage/v1/object/avatars/user%201/version%2B1.jpg",
    );
  });

  // Storage rejects an upsert only if we actually send x-upsert: false, so this
  // header set is what makes a reserved path immutable.
  test("pins the exact Supabase upload headers", () => {
    expect(buildUploadHeaders(request)).toEqual({
      Authorization: "Bearer token-abc",
      apikey: "sb_publishable_key",
      "cache-control": "max-age=300",
      "content-type": "image/jpeg",
      "x-upsert": "false",
    });
  });
});

describe("upload status classification", () => {
  test.each([
    [200, "uploaded"],
    [204, "uploaded"],
    [409, "conflict"],
    [400, "denied"],
    [401, "denied"],
    [403, "denied"],
  ])("maps %i to %s", (status, kind) => {
    expect(classifyUploadResponse(status).kind).toBe(kind);
  });

  // A server error says nothing about whether the bytes landed, so it must not
  // be treated as a failure the client can act on alone.
  test.each([500, 502, 429])("maps %i to an unknown outcome", (status) => {
    expect(classifyUploadResponse(status)).toEqual({ kind: "unknown", status });
  });

  // Supabase Storage answers both a duplicate and an RLS denial with HTTP 400
  // and puts the real code in the body, so the two must be told apart there.
  test("reads the real code out of a Storage 400 body", () => {
    expect(
      classifyUploadResponse(
        400,
        JSON.stringify({
          statusCode: "409",
          error: "Duplicate",
          message: "The resource already exists",
        }),
      ),
    ).toEqual({ kind: "conflict" });

    expect(
      classifyUploadResponse(
        400,
        JSON.stringify({
          statusCode: "403",
          error: "Unauthorized",
          message: "new row violates row-level security policy",
        }),
      ),
    ).toEqual({ kind: "denied" });
  });

  test.each([
    ["", 400],
    ["not json", 400],
    ['{"statusCode":"nope"}', 400],
    ["[]", 400],
  ])("falls back to the HTTP status for body %p", (body, expected) => {
    expect(readEffectiveStatus(400, body)).toBe(expected);
  });

  test("a non-400 status is never reinterpreted from its body", () => {
    expect(readEffectiveStatus(200, '{"statusCode":"409"}')).toBe(200);
  });
});

describe("startReservedObjectUpload", () => {
  test("performs a binary POST to the reserved path and releases the task", async () => {
    const task = fakeTask({ status: 200 });
    const upload = startReservedObjectUpload(request);

    await expect(upload.result).resolves.toEqual({ kind: "uploaded" });
    expect(mockCreateUploadTask).toHaveBeenCalledWith(
      "https://example.supabase.test/storage/v1/object/avatars/user-1/version-1.jpg",
      expect.objectContaining({
        headers: buildUploadHeaders(request),
        httpMethod: "POST",
        mimeType: "image/jpeg",
      }),
    );
    expect(task.release).toHaveBeenCalledTimes(1);
  });

  test("reports native progress as a bounded fraction", async () => {
    const seen: number[] = [];
    fakeTask({
      status: 200,
      onStart: (options) =>
        (options.onProgress as (data: unknown) => void)?.({
          bytesSent: 512,
          totalBytes: 1024,
        }),
    });

    const upload = startReservedObjectUpload({
      ...request,
      onProgress: (fraction) => seen.push(fraction),
    });
    await upload.result;
    expect(seen).toEqual([0.5]);
  });

  test("ignores progress events with an unknown total", async () => {
    const seen: number[] = [];
    fakeTask({
      status: 200,
      onStart: (options) =>
        (options.onProgress as (data: unknown) => void)?.({
          bytesSent: 100,
          totalBytes: -1,
        }),
    });

    const upload = startReservedObjectUpload({
      ...request,
      onProgress: (fraction) => seen.push(fraction),
    });
    await upload.result;
    expect(seen).toEqual([]);
  });

  test("cancellation resolves as canceled rather than as a failure", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const task = fakeTask({ reject: abort });

    const upload = startReservedObjectUpload(request);
    upload.cancel();

    await expect(upload.result).resolves.toEqual({ kind: "canceled" });
    expect(task.cancel).toHaveBeenCalledTimes(1);
  });

  test("a duplicate object surfaces as a conflict, not a denial", async () => {
    fakeTask({
      status: 400,
      body: JSON.stringify({ statusCode: "409", error: "Duplicate" }),
    });
    const upload = startReservedObjectUpload(request);
    await expect(upload.result).resolves.toEqual({ kind: "conflict" });
  });

  // Transport loss is exactly the case where the bytes may already be in the
  // bucket, so the caller has to reconcile with server status.
  test("a transport failure resolves as unknown, not as denied", async () => {
    fakeTask({ reject: new Error("network down") });
    const upload = startReservedObjectUpload(request);
    await expect(upload.result).resolves.toEqual({ kind: "unknown" });
  });
});
