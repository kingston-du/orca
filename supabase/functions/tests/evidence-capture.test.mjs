import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { processEvidenceClaims } from "../_shared/evidence-capture.ts";

const SOURCE_BYTES = Buffer.from("pretend jpeg bytes");
const SOURCE_SHA256 = createHash("sha256").update(SOURCE_BYTES).digest("hex");

function claim(overrides = {}) {
  return {
    report_id: "11111111-1111-4111-8111-111111111111",
    source_bucket_id: "moment-media",
    source_object_path: "author/moment/media.jpg",
    bucket_id: "moderation-evidence",
    object_path: "11111111-1111-4111-8111-111111111111/evidence.jpg",
    expected_content_sha256: SOURCE_SHA256,
    expected_byte_size: SOURCE_BYTES.byteLength,
    lease_token: "lease-1",
    attempt_count: 1,
    ...overrides,
  };
}

function fakeAdmin({
  downloaded = SOURCE_BYTES,
  downloadError = null,
  uploadError = null,
  rpcResults = {},
} = {}) {
  const calls = [];
  const uploads = [];
  return {
    calls,
    uploads,
    storage: {
      from(bucket) {
        return {
          download(path) {
            calls.push({ name: "download", bucket, path });
            return Promise.resolve({
              data: downloaded
                ? {
                    arrayBuffer: () =>
                      Promise.resolve(
                        downloaded.buffer.slice(
                          downloaded.byteOffset,
                          downloaded.byteOffset + downloaded.byteLength,
                        ),
                      ),
                  }
                : null,
              error: downloadError,
            });
          },
          upload(path, body, options) {
            uploads.push({ bucket, path, options, size: body.byteLength });
            return Promise.resolve({ error: uploadError });
          },
        };
      },
    },
    rpc(name, args) {
      calls.push({ name, args });
      const result = rpcResults[name];
      return Promise.resolve(
        typeof result === "function"
          ? result(args)
          : (result ?? { data: null, error: null }),
      );
    },
  };
}

test("an empty batch does no Storage work at all", async () => {
  const admin = fakeAdmin();
  const outcome = await processEvidenceClaims(admin, []);
  assert.deepEqual(outcome, {
    claimed: 0,
    captured: 0,
    retry: 0,
    unavailable: 0,
    lost: 0,
  });
  assert.equal(admin.calls.length, 0);
});

test("a matching copy is uploaded and completed with the measured facts", async () => {
  const admin = fakeAdmin({
    rpcResults: { complete_evidence_capture: { data: true, error: null } },
  });
  const outcome = await processEvidenceClaims(admin, [claim()]);

  assert.equal(outcome.captured, 1);
  assert.equal(admin.uploads.length, 1);
  assert.equal(admin.uploads[0].bucket, "moderation-evidence");
  assert.equal(admin.uploads[0].options.contentType, "image/jpeg");
  // A retry after a lost response must overwrite its own partial copy rather
  // than fail on a duplicate key.
  assert.equal(admin.uploads[0].options.upsert, true);

  const completion = admin.calls.find(
    (call) => call.name === "complete_evidence_capture",
  );
  assert.equal(completion.args.p_content_sha256, SOURCE_SHA256);
  assert.equal(completion.args.p_byte_size, SOURCE_BYTES.byteLength);
});

test("a missing source is terminal, so the photo is not held for ever", async () => {
  const admin = fakeAdmin({
    downloaded: null,
    downloadError: { message: "not found" },
    rpcResults: { fail_evidence_capture: { data: "unavailable", error: null } },
  });
  const outcome = await processEvidenceClaims(admin, [claim()]);

  assert.equal(outcome.unavailable, 1);
  assert.equal(admin.uploads.length, 0);
  const failure = admin.calls.find(
    (call) => call.name === "fail_evidence_capture",
  );
  assert.equal(failure.args.p_error_code, "SOURCE_MISSING");
});

test("bytes that do not hash to the published photo are never stored", async () => {
  const admin = fakeAdmin({
    downloaded: Buffer.from("different bytes entirely"),
    rpcResults: { fail_evidence_capture: { data: "retry", error: null } },
  });
  const outcome = await processEvidenceClaims(admin, [claim()]);

  assert.equal(outcome.retry, 1);
  assert.equal(admin.uploads.length, 0, "nothing is uploaded on a mismatch");
  const failure = admin.calls.find(
    (call) => call.name === "fail_evidence_capture",
  );
  assert.equal(failure.args.p_error_code, "SOURCE_CHANGED");
});

test("a failed upload goes back on the retry ladder", async () => {
  const admin = fakeAdmin({
    uploadError: { message: "storage unavailable" },
    rpcResults: { fail_evidence_capture: { data: "retry", error: null } },
  });
  const outcome = await processEvidenceClaims(admin, [claim()]);

  assert.equal(outcome.retry, 1);
  const failure = admin.calls.find(
    (call) => call.name === "fail_evidence_capture",
  );
  assert.equal(failure.args.p_error_code, "EVIDENCE_UPLOAD_FAILED");
});

test("a refused completion is retried rather than silently counted", async () => {
  const admin = fakeAdmin({
    rpcResults: {
      complete_evidence_capture: { data: false, error: null },
      fail_evidence_capture: { data: "retry", error: null },
    },
  });
  const outcome = await processEvidenceClaims(admin, [claim()]);

  assert.equal(outcome.captured, 0);
  assert.equal(outcome.retry, 1);
  const failure = admin.calls.find(
    (call) => call.name === "fail_evidence_capture",
  );
  assert.equal(failure.args.p_error_code, "DATABASE_COMPLETE_FAILED");
});

test("a failure the database itself refuses is counted as lost, not captured", async () => {
  const admin = fakeAdmin({
    rpcResults: {
      complete_evidence_capture: { data: false, error: null },
      fail_evidence_capture: { data: null, error: { code: "42501" } },
    },
  });
  const outcome = await processEvidenceClaims(admin, [claim()]);
  assert.equal(outcome.lost, 1);
});

test("each claim in a batch is accounted for exactly once", async () => {
  const admin = fakeAdmin({
    rpcResults: { complete_evidence_capture: { data: true, error: null } },
  });
  const outcome = await processEvidenceClaims(admin, [
    claim(),
    claim({ report_id: "22222222-2222-4222-8222-222222222222" }),
  ]);
  assert.equal(outcome.claimed, 2);
  assert.equal(outcome.captured, 2);
});
