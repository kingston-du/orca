/**
 * Best-effort delivery through the Expo Push Service.
 *
 * Two things are load-bearing here and neither is about pushing:
 *
 *   1. The copy is generic and assembled here, from the job type alone. The
 *      database stores no user-facing text, so there is no code path in which a
 *      caption, a username, or a photo could reach a lock screen. The payload
 *      carries an event UUID and at most one opaque route UUID.
 *   2. Every outcome is reported back to the database, which owns the retry
 *      ladder. This module never decides that something is permanently
 *      undeliverable; it reports what the provider said and lets
 *      `complete_notification_job` and `fail_notification_job` apply the rules.
 *
 * Expo publishes no SLA for this service, so a failure here is an ordinary
 * outcome. Orca is correct without notifications.
 */

const SEND_URL = "https://exp.host/--/api/v2/push/send";
const RECEIPT_URL = "https://exp.host/--/api/v2/push/getReceipts";

/** Expo documents 100 messages per send request and 1,000 ticket IDs per
 * receipt request. The receipt chunk is kept well under its limit because the
 * response is a map held whole in memory. */
const SEND_CHUNK = 100;
const RECEIPT_CHUNK = 300;

export type PushClaim = {
  job_id: string;
  device_id: string;
  push_token: string;
  notification_type: string;
  route: string;
  route_id: string | null;
  environment: string;
  lease_token: string;
  attempt_count: number;
};

export type PushReceiptClaim = {
  job_id: string;
  device_id: string;
  provider_ticket_id: string;
};

export type PushOutcome = {
  claimed: number;
  jobs: number;
  sent: number;
  invalid: number;
  retry: number;
  dead: number;
  lost: number;
};

export type ReceiptOutcome = {
  claimed: number;
  delivered: number;
  invalid: number;
  failed: number;
  recorded: number;
};

type RpcError = { code?: string } | null;

type AdminClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: RpcError }>;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

type TicketResult = { status: "ok" | "device_not_registered" | "error" };

/**
 * The whole user-facing vocabulary of Orca notifications, in one place.
 *
 * Every string is true of every instance of its type without naming anybody.
 * "Someone" is deliberate: a Superheart from a person the recipient has since
 * blocked is suppressed before it reaches here, but the copy must not depend on
 * that being true, because a lock screen is readable by whoever is holding the
 * phone.
 */
const COPY: Record<string, string> = {
  friend_request: "You have a new friend request",
  friend_request_accepted: "You have a new friend",
  moment_new: "You have a new Moment",
  moment_tag: "You were added to a Moment",
  reaction_superheart: "Someone Superhearted your Moment",
  reaction_heart_group: "Your Moment has new Hearts",
};

export function bodyForType(type: string): string {
  // An unknown type still has to say something rather than leak its own name.
  return COPY[type] ?? "You have a new Moment";
}

/**
 * Sends every claimed device message, then reports each job's outcome.
 *
 * Claims arrive one row per (job, device). They are sent in provider-sized
 * batches, but completion is per job, because that is the granularity the
 * lease is held at.
 */
export async function processPushClaims(
  admin: AdminClient,
  claims: PushClaim[],
  fetchImpl: FetchLike,
  accessToken?: string,
): Promise<PushOutcome> {
  const outcome: PushOutcome = {
    claimed: claims.length,
    jobs: 0,
    sent: 0,
    invalid: 0,
    retry: 0,
    dead: 0,
    lost: 0,
  };
  if (claims.length === 0) return outcome;

  const byJob = groupBy(claims, (claim) => claim.job_id);
  outcome.jobs = byJob.size;

  const results = new Map<string, TicketResult & { ticketId?: string }>();
  let transportFailed = false;

  for (const batch of chunk(claims, SEND_CHUNK)) {
    const tickets = await sendBatch(batch, fetchImpl, accessToken);
    if (!tickets) {
      transportFailed = true;
      continue;
    }
    batch.forEach((claim, index) => {
      results.set(key(claim), tickets[index] ?? { status: "error" });
    });
  }

  for (const [jobId, jobClaims] of byJob) {
    const lease = jobClaims[0].lease_token;
    const jobResults = jobClaims
      .map((claim) => ({ claim, result: results.get(key(claim)) }))
      .filter((entry) => entry.result !== undefined);

    if (jobResults.length === 0) {
      // The request never reached Expo. Nothing about this job is known, so it
      // goes back on the ladder rather than being recorded as anything.
      outcome[await failJob(admin, jobId, lease, "PROVIDER_UNREACHABLE")] += 1;
      continue;
    }

    const { data, error } = await admin.rpc("complete_notification_job", {
      p_job_id: jobId,
      p_lease_token: lease,
      p_results: jobResults.map(({ claim, result }) => ({
        device_id: claim.device_id,
        status: result!.status,
        ticket_id: result!.ticketId ?? null,
        provider_status: result!.status,
      })),
    });

    if (error) {
      console.error("Push completion was refused", { code: error.code });
      outcome[await failJob(admin, jobId, lease, "DATABASE_COMPLETE_FAILED")] +=
        1;
      continue;
    }

    if (data === "sent") outcome.sent += 1;
    else if (data === "invalid_device") outcome.invalid += 1;
    else if (data === "retry") outcome.retry += 1;
    else if (data === "dead") outcome.dead += 1;
    else outcome.lost += 1;
  }

  if (transportFailed) {
    console.error("Expo push send failed for at least one batch");
  }

  return outcome;
}

/**
 * Checks receipts for tickets Expo published about fifteen minutes ago.
 *
 * A receipt is where `DeviceNotRegistered` usually appears: the send itself
 * almost always succeeds, and the provider only discovers the installation is
 * gone when it tries to hand the message to APNs.
 */
export async function processPushReceipts(
  admin: AdminClient,
  claims: PushReceiptClaim[],
  fetchImpl: FetchLike,
  accessToken?: string,
): Promise<ReceiptOutcome> {
  const outcome: ReceiptOutcome = {
    claimed: claims.length,
    delivered: 0,
    invalid: 0,
    failed: 0,
    recorded: 0,
  };
  if (claims.length === 0) return outcome;

  const results: {
    job_id: string;
    device_id: string;
    status: string;
    provider_status: string;
  }[] = [];

  for (const batch of chunk(claims, RECEIPT_CHUNK)) {
    const receipts = await fetchReceipts(batch, fetchImpl, accessToken);
    if (!receipts) continue;

    for (const claim of batch) {
      const receipt = receipts.get(claim.provider_ticket_id);
      // A receipt Expo has not published yet is left alone; the daily settle
      // closes it a day later if it never arrives.
      if (!receipt) continue;

      if (receipt.status === "ok") outcome.delivered += 1;
      else if (receipt.status === "device_not_registered") outcome.invalid += 1;
      else outcome.failed += 1;

      results.push({
        job_id: claim.job_id,
        device_id: claim.device_id,
        status:
          receipt.status === "ok"
            ? "delivered"
            : receipt.status === "device_not_registered"
              ? "device_not_registered"
              : "error",
        provider_status: receipt.status,
      });
    }
  }

  if (results.length === 0) return outcome;

  const { data, error } = await admin.rpc("record_notification_receipts", {
    p_results: results,
  });
  if (error) {
    console.error("Recording push receipts was refused", { code: error.code });
    return outcome;
  }

  outcome.recorded = typeof data === "number" ? data : 0;
  return outcome;
}

async function sendBatch(
  claims: PushClaim[],
  fetchImpl: FetchLike,
  accessToken?: string,
): Promise<(TicketResult & { ticketId?: string })[] | null> {
  const messages = claims.map((claim) => ({
    to: claim.push_token,
    body: bodyForType(claim.notification_type),
    sound: "default",
    // The entire payload. `e` is the event, `r` is a route name, and `id` is
    // an opaque route UUID when the route needs one. A client that receives
    // this learns nothing it is not already entitled to fetch under RLS.
    data: { e: claim.job_id, r: claim.route, id: claim.route_id ?? undefined },
  }));

  const response = await post(SEND_URL, messages, fetchImpl, accessToken);
  if (!response) return null;

  const tickets = Array.isArray(response.data) ? response.data : null;
  if (!tickets) return null;

  return claims.map((_claim, index) => interpretTicket(tickets[index]));
}

async function fetchReceipts(
  claims: PushReceiptClaim[],
  fetchImpl: FetchLike,
  accessToken?: string,
): Promise<Map<string, TicketResult> | null> {
  const ids = claims.map((claim) => claim.provider_ticket_id);
  const response = await post(RECEIPT_URL, { ids }, fetchImpl, accessToken);
  if (!response) return null;

  const map = new Map<string, TicketResult>();
  const data = response.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return map;
  }
  for (const [ticketId, value] of Object.entries(
    data as Record<string, unknown>,
  )) {
    map.set(ticketId, interpretTicket(value));
  }
  return map;
}

async function post(
  url: string,
  body: unknown,
  fetchImpl: FetchLike,
  accessToken?: string,
): Promise<{ data?: unknown } | null> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // Expo's push security setting. When enhanced security is enabled the
        // service refuses an unauthenticated send, which is what stops anyone
        // holding a leaked token from pushing to Orca's users.
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // Status only. A provider error body can echo the token back.
      console.error("Expo push request failed", { status: response.status });
      return null;
    }
    return (await response.json()) as { data?: unknown };
  } catch {
    console.error("Expo push request threw");
    return null;
  }
}

function interpretTicket(value: unknown): TicketResult & { ticketId?: string } {
  if (typeof value !== "object" || value === null) return { status: "error" };
  const record = value as {
    status?: unknown;
    id?: unknown;
    details?: { error?: unknown };
  };

  if (record.status === "ok") {
    return {
      status: "ok",
      ticketId: typeof record.id === "string" ? record.id : undefined,
    };
  }

  // The one provider error that is a fact about the device rather than about
  // this attempt. Everything else is transient until the ladder says otherwise.
  return record.details?.error === "DeviceNotRegistered"
    ? { status: "device_not_registered" }
    : { status: "error" };
}

async function failJob(
  admin: AdminClient,
  jobId: string,
  leaseToken: string,
  errorCode: string,
): Promise<"retry" | "dead" | "lost"> {
  const { data, error } = await admin.rpc("fail_notification_job", {
    p_error_code: errorCode,
    p_job_id: jobId,
    p_lease_token: leaseToken,
  });
  if (error) return "lost";
  if (data === "dead") return "dead";
  if (data === "retry") return "retry";
  return "lost";
}

function key(claim: PushClaim) {
  return `${claim.job_id}:${claim.device_id}`;
}

function groupBy<T>(items: T[], select: (item: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = select(item);
    const existing = grouped.get(groupKey);
    if (existing) existing.push(item);
    else grouped.set(groupKey, [item]);
  }
  return grouped;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
