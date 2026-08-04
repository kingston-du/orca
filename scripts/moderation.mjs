#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { stdin, stdout } from "node:process";

import { createClient } from "@supabase/supabase-js";

/**
 * Splotty's beta moderation console.
 *
 * This is the only operator surface. It is deliberately not the Supabase
 * dashboard and it never holds a service-role key: it signs one explicitly
 * provisioned operator account in interactively, requires a TOTP second factor,
 * keeps the resulting session in memory only, and calls exactly one Edge
 * Function. Everything it can do is what `moderate-report` exposes — list up to
 * twenty-five cases, read one case, view one evidence image, apply one audited
 * action — and the database re-checks operator membership on every one.
 *
 * Nothing here writes to disk except a single 0600 temporary file, created only
 * for an explicit evidence view and removed as soon as the operator is done
 * with it. No password, no TOTP code, no access token, and no case content is
 * ever printed except the case the operator asked to see.
 *
 * Usage:
 *   npm run moderate            interactive console
 *   npm run moderate -- enroll  one-time TOTP enrolment for this operator
 */

const target = readTarget();
const supabase = createClient(target.apiUrl, target.publishableKey, {
  auth: {
    autoRefreshToken: false,
    // The session must not survive this process. There is no operator session
    // on disk, so an unattended laptop is not a standing moderation capability.
    persistSession: false,
  },
});

const ACTIONS = {
  dismiss: "Dismiss the case",
  remove_moment: "Remove the Moment",
  suspend_account: "Suspend the account",
  reinstate_account: "Reinstate the account",
  place_legal_hold: "Place a legal hold",
  release_legal_hold: "Release the legal hold",
};

main().catch((error) => {
  console.error(
    `\n${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});

async function main() {
  console.log(`Splotty moderation console — ${target.label}`);
  console.log(
    "Actions are audited against your operator identity. Do not copy case " +
      "content out of this session.\n",
  );

  const enrolling = process.argv[2] === "enroll";
  await signIn({ enrolling });

  if (enrolling) {
    await enrolTotp();
    await supabase.auth.signOut({ scope: "local" });
    return;
  }

  await runConsole();
  await supabase.auth.signOut({ scope: "local" });
  console.log("\nSigned out.");
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------
async function signIn({ enrolling }) {
  const email = await prompt("Operator email: ");
  const password = await promptSecret("Password: ");

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error("Sign-in failed.");

  // Enrolment is the one flow that cannot already hold a second factor.
  if (enrolling) return;

  const { data: factors, error: factorError } =
    await supabase.auth.mfa.listFactors();
  if (factorError) throw new Error("Could not read enrolled factors.");

  const totp = (factors.totp ?? []).find(
    (factor) => factor.status === "verified",
  );
  if (!totp) {
    throw new Error(
      "This account has no verified TOTP factor. Run `npm run moderate -- enroll` first.",
    );
  }

  const { data: challenge, error: challengeError } =
    await supabase.auth.mfa.challenge({ factorId: totp.id });
  if (challengeError)
    throw new Error("Could not start the second-factor check.");

  const code = await prompt("Authenticator code: ");
  const { error: verifyError } = await supabase.auth.mfa.verify({
    challengeId: challenge.id,
    code: code.trim(),
    factorId: totp.id,
  });
  if (verifyError) throw new Error("Second-factor verification failed.");

  const { data: level } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  assert.equal(
    level?.currentLevel,
    "aal2",
    "the session did not reach aal2 after verification",
  );
  console.log("\nSigned in with a second factor.\n");
}

/**
 * One-time enrolment. The shared secret is written to a 0600 file rather than
 * printed, so it does not end up in scrollback, a screen share, or a terminal
 * recording. The file is removed as soon as the first code verifies.
 */
async function enrolTotp() {
  const { data, error } = await supabase.auth.mfa.enroll({
    friendlyName: `orca-operator-${Date.now()}`,
    factorType: "totp",
  });
  if (error) throw new Error("Enrolment could not be started.");

  const directory = await mkdtemp(join(tmpdir(), "orca-operator-"));
  const path = join(directory, "totp-secret.txt");
  await writeFile(
    path,
    `Add this to your authenticator app, then delete this file.\n\n${data.totp.uri}\n`,
    { mode: 0o600 },
  );

  console.log(`\nEnrolment details written to ${path}`);
  console.log("Add the secret to your authenticator app, then enter a code.\n");

  const code = await prompt("Authenticator code: ");
  const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
    code: code.trim(),
    factorId: data.id,
  });
  await rm(directory, { force: true, recursive: true });

  if (verifyError) throw new Error("Enrolment could not be verified.");
  console.log(
    "Factor enrolled and verified. The secret file has been removed.",
  );
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------
async function runConsole() {
  printHelp();
  for (;;) {
    const line = (await prompt("moderation> ")).trim();
    if (!line) continue;

    const [command, argument] = [
      line.split(/\s+/)[0],
      line.split(/\s+/).slice(1).join(" "),
    ];

    try {
      if (command === "quit" || command === "exit") return;
      else if (command === "help") printHelp();
      else if (command === "list") await listCases(argument || "open");
      else if (command === "case") await showCase(requireUuid(argument));
      else if (command === "evidence")
        await showEvidence(requireUuid(argument));
      else if (command in ACTIONS)
        await runAction(command, requireUuid(argument));
      else console.log("Unknown command. Type `help`.");
    } catch (error) {
      console.log(error instanceof Error ? error.message : "Command failed.");
    }
  }
}

function printHelp() {
  console.log("Commands:");
  console.log(
    "  list [open|actioned|dismissed]   the twenty-five newest cases",
  );
  console.log("  case <report-id>                 read one case");
  console.log(
    "  evidence <report-id>             view the evidence image once",
  );
  for (const [name, label] of Object.entries(ACTIONS)) {
    console.log(`  ${name.padEnd(32)} ${label.toLowerCase()}`);
  }
  console.log("  quit\n");
}

async function listCases(status) {
  const { cases } = await call({ limit: 25, op: "list", status });
  if (cases.length === 0) {
    console.log(`No ${status} cases.\n`);
    return;
  }
  for (const row of cases) {
    console.log(
      [
        row.priority === "urgent" ? "URGENT" : "normal",
        row.report_id,
        row.category.padEnd(22),
        row.subject_kind.padEnd(7),
        `evidence:${row.evidence_status}`,
        row.legal_hold ? "hold" : "",
        `${Math.round(row.age_seconds / 3600)}h old`,
      ]
        .filter(Boolean)
        .join("  "),
    );
  }
  console.log("");
}

async function showCase(reportId) {
  const { case: found } = await call({ op: "case", reportId });
  console.log("");
  for (const [key, value] of Object.entries(found)) {
    if (value === null || value === undefined) continue;
    console.log(`  ${key}: ${format(value)}`);
  }
  console.log("");
}

/**
 * An evidence view is an audited action, and the image never becomes a reusable
 * link: it is streamed through the function, hashed against the case, written
 * to one 0600 file, and deleted as soon as the operator presses Enter.
 */
async function showEvidence(reportId) {
  const reason = await requireReason("Reason for viewing this evidence: ");

  const response = await request({
    commandId: randomUUID(),
    op: "evidence",
    reason,
    reportId,
  });
  if (!response.ok) throw new Error(await describeFailure(response));

  const bytes = Buffer.from(await response.arrayBuffer());
  const expected = response.headers.get("x-orca-evidence-sha256");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (expected && expected !== actual) {
    throw new Error("The evidence image did not match its recorded hash.");
  }

  const directory = await mkdtemp(join(tmpdir(), "orca-evidence-"));
  const path = join(directory, `${reportId}.jpg`);
  await writeFile(path, bytes, { mode: 0o600 });

  console.log(`\nEvidence written to ${path}`);
  console.log(
    `Recorded as audit action ${response.headers.get("x-orca-action-id")}`,
  );
  await prompt("Press Enter when you are done to delete it. ");
  await rm(directory, { force: true, recursive: true });
  console.log("Evidence file removed.\n");
}

async function runAction(action, reportId) {
  const { case: found } = await call({ op: "case", reportId });
  console.log(
    `\n${ACTIONS[action]} for case ${reportId}` +
      ` (currently ${found.status}, subject ${found.subject_kind}).`,
  );

  const reason = await requireReason("Reason (recorded in the audit): ");
  const confirmation = await prompt("Type the action name to confirm: ");
  if (confirmation.trim() !== action) {
    console.log("Not confirmed; nothing was done.\n");
    return;
  }

  const result = await call({
    action,
    commandId: randomUUID(),
    expectedStatus: found.status,
    op: "action",
    reason,
    reportId,
  });

  console.log(`\n  result: ${result.result}`);
  console.log(`  case status: ${result.reportStatus}`);
  if (result.alreadyApplied) console.log("  (replayed an earlier receipt)");
  if (result.sessionsRevoked === false) {
    console.log(
      "  WARNING: account state changed but Auth sessions were not revoked. " +
        "Re-run this action.",
    );
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
async function call(body) {
  const response = await request(body);
  if (!response.ok) throw new Error(await describeFailure(response));
  return await response.json();
}

async function request(body) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session)
    throw new Error("The operator session has ended. Sign in again.");

  return await fetch(`${target.functionsUrl}/moderate-report`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      apikey: target.publishableKey,
    },
    method: "POST",
  });
}

async function describeFailure(response) {
  let message = `Request failed (${response.status}).`;
  try {
    const body = await response.json();
    if (typeof body?.error === "string") message = `${body.error}.`;
  } catch {
    // A non-JSON failure body is never echoed: it may carry provider detail.
  }
  return message;
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------
function prompt(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Reads a line without echoing it, so a password never reaches scrollback. */
function promptSecret(question) {
  return new Promise((resolve, reject) => {
    stdout.write(question);
    const wasRaw = stdin.isRaw;
    if (!stdin.isTTY) {
      reject(new Error("A terminal is required to enter a password."));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();

    let value = "";
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          stdin.off("data", onData);
          stdin.setRawMode(Boolean(wasRaw));
          stdin.pause();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "") {
          stdin.off("data", onData);
          stdin.setRawMode(Boolean(wasRaw));
          stdin.pause();
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "") value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on("data", onData);
  });
}

async function requireReason(question) {
  const reason = (await prompt(question)).trim();
  if (reason.length < 3 || reason.length > 200) {
    throw new Error("A reason between 3 and 200 characters is required.");
  }
  return reason;
}

function requireUuid(value) {
  const candidate = (value ?? "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate,
    )
  ) {
    throw new Error("A case UUID is required.");
  }
  return candidate;
}

function format(value) {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function readTarget() {
  if (process.env.ORCA_MODERATION_API_URL) {
    const apiUrl = process.env.ORCA_MODERATION_API_URL;
    const publishableKey = process.env.ORCA_MODERATION_PUBLISHABLE_KEY;
    assert.ok(
      publishableKey,
      "ORCA_MODERATION_PUBLISHABLE_KEY must accompany ORCA_MODERATION_API_URL",
    );
    return {
      apiUrl,
      functionsUrl:
        process.env.ORCA_MODERATION_FUNCTIONS_URL ?? `${apiUrl}/functions/v1`,
      label: "hosted",
      publishableKey,
    };
  }

  const status = JSON.parse(
    execFileSync(
      "./node_modules/.bin/supabase",
      ["status", "--output", "json"],
      {
        encoding: "utf8",
      },
    ),
  );
  return {
    apiUrl: status.API_URL,
    functionsUrl: status.FUNCTIONS_URL,
    label: "local",
    publishableKey: status.PUBLISHABLE_KEY,
  };
}
