export type BackupScope = "ordinary" | "evidence";

type RpcError = { code?: string } | null;
type AdminClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: RpcError }>;
  storage: {
    from: (bucket: string) => {
      download: (path: string) => PromiseLike<{
        data: Blob | null;
        error: { message?: string } | null;
      }>;
    };
  };
};

type Dependencies = {
  admin: AdminClient;
  secrets: Record<BackupScope, string | undefined>;
};

type BackupClaim = {
  job_id: string;
  action: "copy" | "purge";
  bucket_id: string;
  object_path: string;
  object_version: string;
  content_sha256: string;
  byte_size: number;
  source_observed_at: string;
  tombstoned_at: string | null;
  lease_token: string;
  attempt_count: number;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const LOCATOR_PATTERN = /^[0-9a-f]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Purpose-built export boundary for encrypted backups. A caller gets exactly
 * one leased object or one tombstone, never a bucket credential. Ordinary and
 * evidence scopes are authenticated by different secrets before a database
 * call occurs, so the ordinary scheduler cannot enumerate safety evidence.
 */
export async function handleBackupRequest(
  request: Request,
  dependencies: Dependencies,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
  }
  const command = await readCommand(request);
  if (!command) return json({ error: "Invalid backup command" }, 400);

  const configured = dependencies.secrets[command.scope];
  const supplied = request.headers.get("x-orca-backup-secret");
  if (!configured || new TextEncoder().encode(configured).byteLength < 32) {
    return json({ code: "BACKUP_NOT_CONFIGURED", error: "Unavailable" }, 503);
  }
  if (!supplied || !(await equalSecret(configured, supplied))) {
    return json({ error: "Authentication required" }, 401);
  }

  switch (command.op) {
    case "claim":
      return claim(dependencies.admin, command.scope);
    case "complete":
      return complete(dependencies.admin, command);
    case "fail":
      return fail(dependencies.admin, command);
    case "manifest":
      return manifest(dependencies.admin, command);
    case "record-snapshot":
      return recordSnapshot(dependencies.admin, command);
  }
}

async function claim(admin: AdminClient, scope: BackupScope) {
  const { data, error } = await admin.rpc("claim_media_backup_batch", {
    p_lease_seconds: 120,
    p_limit: 1,
    p_scope: scope,
  });
  if (error) return rpcFailure(error, "Unable to claim backup work");
  const row = rows<BackupClaim>(data)[0];
  if (!row) return new Response(null, { status: 204 });

  const base = {
    action: row.action,
    attemptCount: row.attempt_count,
    bucketId: row.bucket_id,
    byteSize: row.byte_size,
    contentSha256: row.content_sha256,
    jobId: row.job_id,
    leaseToken: row.lease_token,
    objectPath: row.object_path,
    objectVersion: row.object_version,
    sourceObservedAt: row.source_observed_at,
    tombstonedAt: row.tombstoned_at,
  };
  if (row.action === "purge") return json({ claim: base }, 200);

  const { data: object, error: downloadError } = await admin.storage
    .from(row.bucket_id)
    .download(row.object_path);
  if (downloadError || !object) {
    await reportFailure(admin, row, "SOURCE_MISSING");
    return json(
      { code: "SOURCE_MISSING", error: "Backup source unavailable" },
      503,
    );
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (
    bytes.byteLength !== row.byte_size ||
    (await sha256Hex(bytes)) !== row.content_sha256
  ) {
    await reportFailure(admin, row, "SOURCE_HASH_MISMATCH");
    return json(
      { code: "SOURCE_HASH_MISMATCH", error: "Backup source invalid" },
      503,
    );
  }
  return json({ claim: { ...base, bytesBase64: bytesToBase64(bytes) } }, 200);
}

async function complete(
  admin: AdminClient,
  command: Extract<Command, { op: "complete" }>,
) {
  const method =
    command.action === "copy"
      ? "complete_media_backup_copy"
      : "complete_media_backup_purge";
  const args =
    command.action === "copy"
      ? {
          p_archive_key_id: command.archiveKeyId,
          p_archive_locator: command.archiveLocator,
          p_job_id: command.jobId,
          p_lease_token: command.leaseToken,
        }
      : {
          p_archive_locator: command.archiveLocator,
          p_job_id: command.jobId,
          p_lease_token: command.leaseToken,
        };
  const { data, error } = await admin.rpc(method, args);
  if (error) return rpcFailure(error, "Unable to complete backup work");
  return json({ completed: data === true }, data === true ? 200 : 409);
}

async function fail(
  admin: AdminClient,
  command: Extract<Command, { op: "fail" }>,
) {
  const { data, error } = await admin.rpc("fail_media_backup_job", {
    p_error_code: command.errorCode,
    p_job_id: command.jobId,
    p_lease_token: command.leaseToken,
  });
  if (error) return rpcFailure(error, "Unable to record backup failure");
  return json({ result: data }, data === "lost" ? 409 : 200);
}

async function manifest(
  admin: AdminClient,
  command: Extract<Command, { op: "manifest" }>,
) {
  const { data, error } = await admin.rpc("list_media_backup_manifest", {
    p_after_id: command.afterId,
    p_database_point_at: command.databasePointAt,
    p_limit: command.limit,
    p_scope: command.scope,
  });
  if (error) return rpcFailure(error, "Unable to read backup manifest");
  const manifestRows = rows<Record<string, unknown>>(data);
  const objects = manifestRows.map((row) => ({
    archiveKeyId: row.archive_key_id,
    archiveLocator: row.archive_locator,
    bucketId: row.bucket_id,
    byteSize: row.byte_size,
    contentSha256: row.content_sha256,
    copiedAt: row.copied_at,
    jobId: row.job_id,
    objectPath: row.object_path,
    objectVersion: row.object_version,
    sourceObservedAt: row.source_observed_at,
  }));
  return json(
    {
      nextAfterId:
        manifestRows.length === command.limit
          ? (manifestRows.at(-1)?.job_id ?? null)
          : null,
      objects,
    },
    200,
  );
}

async function recordSnapshot(
  admin: AdminClient,
  command: Extract<Command, { op: "record-snapshot" }>,
) {
  const { data, error } = await admin.rpc("record_backup_snapshot", {
    p_archive_key_id: command.archiveKeyId,
    p_database_point_at: command.databasePointAt,
    p_environment: command.environment,
    p_manifest_sha256: command.manifestSha256,
    p_newest_source_at: command.newestSourceAt,
    p_object_count: command.objectCount,
    p_scope: command.scope,
    p_snapshot_id: command.snapshotId,
  });
  if (error) return rpcFailure(error, "Unable to record backup snapshot");
  return json({ recorded: data === true }, data === true ? 200 : 409);
}

type Command =
  | { op: "claim"; scope: BackupScope }
  | {
      op: "complete";
      scope: BackupScope;
      action: "copy" | "purge";
      archiveKeyId: string;
      archiveLocator: string;
      jobId: string;
      leaseToken: string;
    }
  | {
      op: "fail";
      scope: BackupScope;
      errorCode: string;
      jobId: string;
      leaseToken: string;
    }
  | {
      op: "manifest";
      scope: BackupScope;
      afterId: string | null;
      databasePointAt: string;
      limit: number;
    }
  | {
      op: "record-snapshot";
      scope: BackupScope;
      archiveKeyId: string;
      databasePointAt: string;
      environment: string;
      manifestSha256: string;
      newestSourceAt: string | null;
      objectCount: number;
      snapshotId: string;
    };

async function readCommand(request: Request): Promise<Command | null> {
  try {
    const value: unknown = await request.json();
    if (
      !isRecord(value) ||
      !isScope(value.scope) ||
      typeof value.op !== "string"
    ) {
      return null;
    }
    if (value.op === "claim" && exactKeys(value, ["op", "scope"])) {
      return { op: "claim", scope: value.scope };
    }
    if (
      value.op === "complete" &&
      exactKeys(value, [
        "action",
        "archiveKeyId",
        "archiveLocator",
        "jobId",
        "leaseToken",
        "op",
        "scope",
      ]) &&
      (value.action === "copy" || value.action === "purge") &&
      KEY_ID_PATTERN.test(String(value.archiveKeyId)) &&
      LOCATOR_PATTERN.test(String(value.archiveLocator)) &&
      UUID_PATTERN.test(String(value.jobId)) &&
      UUID_PATTERN.test(String(value.leaseToken))
    ) {
      return value as Command;
    }
    if (
      value.op === "fail" &&
      exactKeys(value, ["errorCode", "jobId", "leaseToken", "op", "scope"]) &&
      /^[A-Z0-9_]{1,64}$/.test(String(value.errorCode)) &&
      UUID_PATTERN.test(String(value.jobId)) &&
      UUID_PATTERN.test(String(value.leaseToken))
    ) {
      return value as Command;
    }
    if (
      value.op === "manifest" &&
      exactKeys(value, [
        "afterId",
        "databasePointAt",
        "limit",
        "op",
        "scope",
      ]) &&
      (value.afterId === null || UUID_PATTERN.test(String(value.afterId))) &&
      typeof value.databasePointAt === "string" &&
      Number.isFinite(Date.parse(value.databasePointAt)) &&
      Number.isInteger(value.limit) &&
      Number(value.limit) >= 1 &&
      Number(value.limit) <= 500
    ) {
      return value as Command;
    }
    if (
      value.op === "record-snapshot" &&
      exactKeys(value, [
        "archiveKeyId",
        "databasePointAt",
        "environment",
        "manifestSha256",
        "newestSourceAt",
        "objectCount",
        "op",
        "scope",
        "snapshotId",
      ]) &&
      KEY_ID_PATTERN.test(String(value.archiveKeyId)) &&
      typeof value.databasePointAt === "string" &&
      Number.isFinite(Date.parse(value.databasePointAt)) &&
      /^[a-z0-9-]{1,32}$/.test(String(value.environment)) &&
      SHA_PATTERN.test(String(value.manifestSha256)) &&
      (value.newestSourceAt === null ||
        (typeof value.newestSourceAt === "string" &&
          Number.isFinite(Date.parse(value.newestSourceAt)))) &&
      Number.isInteger(value.objectCount) &&
      Number(value.objectCount) >= 0 &&
      Number(value.objectCount) <= 10_000_000 &&
      UUID_PATTERN.test(String(value.snapshotId))
    ) {
      return value as Command;
    }
    return null;
  } catch {
    return null;
  }
}

async function reportFailure(
  admin: AdminClient,
  claim: BackupClaim,
  errorCode: string,
) {
  await admin.rpc("fail_media_backup_job", {
    p_error_code: errorCode,
    p_job_id: claim.job_id,
    p_lease_token: claim.lease_token,
  });
}

async function equalSecret(expected: string, supplied: string) {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function rpcFailure(error: RpcError, message: string) {
  console.error(message, { code: error?.code });
  return json({ code: "BACKUP_DATABASE_FAILED", error: message }, 500);
}

function rows<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  return data ? [data as T] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScope(value: unknown): value is BackupScope {
  return value === "ordinary" || value === "evidence";
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const expected = [...keys].sort();
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function json(
  body: Record<string, unknown>,
  status: number,
  headers?: HeadersInit,
) {
  return Response.json(body, {
    headers: { "Cache-Control": "private, no-store", ...headers },
    status,
  });
}
