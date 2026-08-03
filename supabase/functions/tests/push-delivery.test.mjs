import assert from "node:assert/strict";
import test from "node:test";

import {
  bodyForType,
  processPushClaims,
  processPushReceipts,
} from "../_shared/push-delivery.ts";

function claim(overrides = {}) {
  return {
    job_id: "job-1",
    device_id: "device-1",
    push_token: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]",
    notification_type: "moment_new",
    route: "moment",
    route_id: "11111111-1111-4111-8111-111111111111",
    environment: "development",
    lease_token: "lease-1",
    attempt_count: 1,
    ...overrides,
  };
}

function fakeAdmin(rpcResults = {}) {
  const calls = [];
  return {
    calls,
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

function fakeFetch(responder) {
  const requests = [];
  const impl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return responder(url, JSON.parse(init.body));
  };
  impl.requests = requests;
  return impl;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("an empty batch talks to nobody", async () => {
  const admin = fakeAdmin();
  const fetchImpl = fakeFetch(() => jsonResponse({ data: [] }));
  assert.deepEqual(await processPushClaims(admin, [], fetchImpl), {
    claimed: 0,
    jobs: 0,
    sent: 0,
    invalid: 0,
    retry: 0,
    dead: 0,
    lost: 0,
  });
  assert.equal(fetchImpl.requests.length, 0);
  assert.equal(admin.calls.length, 0);
});

test("the payload carries generic copy, an event id, and an opaque route", async () => {
  const admin = fakeAdmin({
    complete_notification_job: { data: "sent", error: null },
  });
  const fetchImpl = fakeFetch(() =>
    jsonResponse({ data: [{ status: "ok", id: "ticket-1" }] }),
  );

  await processPushClaims(admin, [claim()], fetchImpl);

  const [message] = fetchImpl.requests[0].body;
  assert.deepEqual(message, {
    to: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]",
    body: "You have a new Moment",
    sound: "default",
    data: {
      e: "job-1",
      r: "moment",
      id: "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.equal(Object.keys(message).length, 4, "nothing else is sent");
});

test("no notification copy names a person, a caption, or a photo", () => {
  const types = [
    "friend_request",
    "friend_request_accepted",
    "moment_new",
    "moment_tag",
    "reaction_superheart",
    "reaction_heart_group",
  ];
  for (const type of types) {
    const body = bodyForType(type);
    assert.ok(body.length > 0, `${type} has copy`);
    assert.ok(!body.includes("@"), `${type} carries no username`);
    // "You", "Your", and "Someone" are the only ways a person is referred to.
    assert.match(
      body,
      /^(You|Your|Someone)\b/,
      `${type} refers to people only in the second person or as "Someone"`,
    );
  }
  assert.equal(
    bodyForType("something_added_later"),
    "You have a new Moment",
    "an unknown type falls back to generic copy rather than echoing its name",
  );
});

test("a ticketed send completes the job with the provider ticket", async () => {
  const admin = fakeAdmin({
    complete_notification_job: { data: "sent", error: null },
  });
  const fetchImpl = fakeFetch(() =>
    jsonResponse({ data: [{ status: "ok", id: "ticket-1" }] }),
  );

  const outcome = await processPushClaims(admin, [claim()], fetchImpl);

  assert.equal(outcome.sent, 1);
  assert.equal(outcome.jobs, 1);
  assert.deepEqual(admin.calls[0], {
    name: "complete_notification_job",
    args: {
      p_job_id: "job-1",
      p_lease_token: "lease-1",
      p_results: [
        {
          device_id: "device-1",
          status: "ok",
          ticket_id: "ticket-1",
          provider_status: "ok",
        },
      ],
    },
  });
});

test("DeviceNotRegistered is reported as a fact about the device", async () => {
  const admin = fakeAdmin({
    complete_notification_job: { data: "invalid_device", error: null },
  });
  const fetchImpl = fakeFetch(() =>
    jsonResponse({
      data: [
        {
          status: "error",
          message: "not registered",
          details: { error: "DeviceNotRegistered" },
        },
      ],
    }),
  );

  const outcome = await processPushClaims(admin, [claim()], fetchImpl);

  assert.equal(outcome.invalid, 1);
  assert.equal(
    admin.calls[0].args.p_results[0].status,
    "device_not_registered",
  );
});

test("any other provider error is transient and stays on the ladder", async () => {
  const admin = fakeAdmin({
    complete_notification_job: { data: "retry", error: null },
  });
  const fetchImpl = fakeFetch(() =>
    jsonResponse({
      data: [
        {
          status: "error",
          message: "nope",
          details: { error: "MessageRateExceeded" },
        },
      ],
    }),
  );

  const outcome = await processPushClaims(admin, [claim()], fetchImpl);

  assert.equal(outcome.retry, 1);
  assert.equal(admin.calls[0].args.p_results[0].status, "error");
});

test("one job with two devices is one completion carrying both results", async () => {
  const admin = fakeAdmin({
    complete_notification_job: { data: "sent", error: null },
  });
  const fetchImpl = fakeFetch(() =>
    jsonResponse({
      data: [
        { status: "ok", id: "ticket-1" },
        { status: "ok", id: "ticket-2" },
      ],
    }),
  );

  await processPushClaims(
    admin,
    [
      claim(),
      claim({ device_id: "device-2", push_token: "ExponentPushToken[b]" }),
    ],
    fetchImpl,
  );

  assert.equal(admin.calls.length, 1);
  assert.equal(admin.calls[0].args.p_results.length, 2);
});

test("two jobs are completed separately, each against its own lease", async () => {
  const admin = fakeAdmin({
    complete_notification_job: { data: "sent", error: null },
  });
  const fetchImpl = fakeFetch(() =>
    jsonResponse({
      data: [
        { status: "ok", id: "ticket-1" },
        { status: "ok", id: "ticket-2" },
      ],
    }),
  );

  await processPushClaims(
    admin,
    [claim(), claim({ job_id: "job-2", lease_token: "lease-2" })],
    fetchImpl,
  );

  assert.deepEqual(
    admin.calls.map((call) => call.args.p_lease_token),
    ["lease-1", "lease-2"],
  );
});

test("an unreachable provider fails the job rather than recording an outcome", async () => {
  const admin = fakeAdmin({
    fail_notification_job: { data: "retry", error: null },
  });
  const fetchImpl = fakeFetch(() => {
    throw new Error("network");
  });

  const outcome = await processPushClaims(admin, [claim()], fetchImpl);

  assert.equal(outcome.retry, 1);
  assert.deepEqual(admin.calls[0], {
    name: "fail_notification_job",
    args: {
      p_error_code: "PROVIDER_UNREACHABLE",
      p_job_id: "job-1",
      p_lease_token: "lease-1",
    },
  });
});

test("a non-2xx from Expo is also treated as unreachable", async () => {
  const admin = fakeAdmin({
    fail_notification_job: { data: "dead", error: null },
  });
  const fetchImpl = fakeFetch(() => jsonResponse({ errors: [] }, 503));

  const outcome = await processPushClaims(admin, [claim()], fetchImpl);

  assert.equal(outcome.dead, 1);
  assert.equal(admin.calls[0].name, "fail_notification_job");
});

test("a refused completion goes back on the ladder instead of being lost", async () => {
  const admin = fakeAdmin({
    complete_notification_job: { data: null, error: { code: "55000" } },
    fail_notification_job: { data: "retry", error: null },
  });
  const fetchImpl = fakeFetch(() =>
    jsonResponse({ data: [{ status: "ok", id: "ticket-1" }] }),
  );

  const outcome = await processPushClaims(admin, [claim()], fetchImpl);

  assert.equal(outcome.retry, 1);
  assert.deepEqual(
    admin.calls.map((call) => call.name),
    ["complete_notification_job", "fail_notification_job"],
  );
});

test("the access token is sent when one is configured, and never otherwise", async () => {
  const admin = fakeAdmin({
    complete_notification_job: { data: "sent", error: null },
  });

  const withToken = fakeFetch(() =>
    jsonResponse({ data: [{ status: "ok", id: "t" }] }),
  );
  await processPushClaims(admin, [claim()], withToken, "secret-token");
  assert.equal(
    withToken.requests[0].init.headers.authorization,
    "Bearer secret-token",
  );

  const withoutToken = fakeFetch(() =>
    jsonResponse({ data: [{ status: "ok", id: "t" }] }),
  );
  await processPushClaims(admin, [claim()], withoutToken);
  assert.equal(withoutToken.requests[0].init.headers.authorization, undefined);
});

test("sends are chunked at the documented hundred-message limit", async () => {
  const admin = fakeAdmin({
    complete_notification_job: { data: "sent", error: null },
  });
  const fetchImpl = fakeFetch((_url, body) =>
    jsonResponse({
      data: body.map((_m, i) => ({ status: "ok", id: `t${i}` })),
    }),
  );

  const claims = Array.from({ length: 150 }, (_value, index) =>
    claim({ job_id: `job-${index}`, device_id: `device-${index}` }),
  );
  const outcome = await processPushClaims(admin, claims, fetchImpl);

  assert.equal(fetchImpl.requests.length, 2);
  assert.equal(fetchImpl.requests[0].body.length, 100);
  assert.equal(fetchImpl.requests[1].body.length, 50);
  assert.equal(outcome.sent, 150);
});

test("receipts record the delivered outcome for each ticket", async () => {
  const admin = fakeAdmin({
    record_notification_receipts: { data: 2, error: null },
  });
  const fetchImpl = fakeFetch(() =>
    jsonResponse({
      data: {
        "ticket-1": { status: "ok" },
        "ticket-2": { status: "ok" },
      },
    }),
  );

  const outcome = await processPushReceipts(
    admin,
    [
      {
        job_id: "job-1",
        device_id: "device-1",
        provider_ticket_id: "ticket-1",
      },
      {
        job_id: "job-2",
        device_id: "device-2",
        provider_ticket_id: "ticket-2",
      },
    ],
    fetchImpl,
  );

  assert.equal(outcome.delivered, 2);
  assert.equal(outcome.recorded, 2);
  assert.deepEqual(admin.calls[0].args.p_results, [
    {
      job_id: "job-1",
      device_id: "device-1",
      status: "delivered",
      provider_status: "ok",
    },
    {
      job_id: "job-2",
      device_id: "device-2",
      status: "delivered",
      provider_status: "ok",
    },
  ]);
});

test("a receipt naming DeviceNotRegistered disables the installation", async () => {
  const admin = fakeAdmin({
    record_notification_receipts: { data: 1, error: null },
  });
  const fetchImpl = fakeFetch(() =>
    jsonResponse({
      data: {
        "ticket-1": {
          status: "error",
          message: "gone",
          details: { error: "DeviceNotRegistered" },
        },
      },
    }),
  );

  const outcome = await processPushReceipts(
    admin,
    [
      {
        job_id: "job-1",
        device_id: "device-1",
        provider_ticket_id: "ticket-1",
      },
    ],
    fetchImpl,
  );

  assert.equal(outcome.invalid, 1);
  assert.equal(
    admin.calls[0].args.p_results[0].status,
    "device_not_registered",
  );
});

test("a receipt Expo has not published yet is left alone", async () => {
  const admin = fakeAdmin();
  const fetchImpl = fakeFetch(() => jsonResponse({ data: {} }));

  const outcome = await processPushReceipts(
    admin,
    [
      {
        job_id: "job-1",
        device_id: "device-1",
        provider_ticket_id: "ticket-1",
      },
    ],
    fetchImpl,
  );

  assert.deepEqual(outcome, {
    claimed: 1,
    delivered: 0,
    invalid: 0,
    failed: 0,
    recorded: 0,
  });
  assert.equal(admin.calls.length, 0, "and nothing is recorded about it");
});

test("an unreachable receipt endpoint records nothing at all", async () => {
  const admin = fakeAdmin();
  const fetchImpl = fakeFetch(() => {
    throw new Error("network");
  });

  const outcome = await processPushReceipts(
    admin,
    [
      {
        job_id: "job-1",
        device_id: "device-1",
        provider_ticket_id: "ticket-1",
      },
    ],
    fetchImpl,
  );

  assert.equal(outcome.recorded, 0);
  assert.equal(admin.calls.length, 0);
});
