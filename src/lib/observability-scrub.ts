/**
 * Content scrubbing for crash reports.
 *
 * Orca sends diagnostics to a third party, so the question is not "what is
 * useful to send?" but "what is it never acceptable to send?". Section 25
 * answers that: no email, username, caption, EXIF, photo or object URL, invite
 * or deletion token, signed URL, device token, recipient or tag list, report
 * detail, session, or key.
 *
 * These functions are pure and know nothing about Sentry, so the rules can be
 * tested directly rather than inferred from a network payload.
 */

/** Long enough to keep a stack frame or an error code, short enough that a
 * caption or a details field cannot ride along inside a message. */
const MAX_TEXT = 300;

const REDACTIONS: { pattern: RegExp; replacement: string }[] = [
  // Anything that looks like an address, before narrower rules can split it.
  { pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replacement: "[email]" },
  // A JWT: three base64url segments. Access, refresh, and invite tokens all
  // reach this shape, and none of them may ever leave the device.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replacement: "[token]",
  },
  // A local file, which for Orca means the photo being published.
  { pattern: /\bfile:\/\/\S+|\/var\/mobile\/\S+/g, replacement: "[file]" },
  // Any URL. A signed media URL carries a capability; even an unsigned one
  // carries an object path, which names a person and a Moment.
  { pattern: /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, replacement: "[url]" },
  // A Storage object path: `{uuid}/{uuid}/media.jpg` or `{uuid}/{uuid}.jpg`.
  {
    pattern: /\b[0-9a-f-]{36}\/[0-9a-f-]{36}(?:\/media)?\.jpg\b/gi,
    replacement: "[object]",
  },
  // A long opaque blob, which is how base64 image bytes would arrive.
  { pattern: /\b[A-Za-z0-9+/]{120,}={0,2}\b/g, replacement: "[data]" },
];

export function redactText(value: string): string {
  let redacted = value;
  for (const { pattern, replacement } of REDACTIONS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted.length > MAX_TEXT
    ? `${redacted.slice(0, MAX_TEXT)}…[truncated]`
    : redacted;
}

type ScrubbableEvent = {
  message?: unknown;
  breadcrumbs?: unknown;
  exception?: { values?: { value?: unknown; type?: unknown }[] };
  extra?: Record<string, unknown>;
  request?: {
    url?: unknown;
    data?: unknown;
    headers?: unknown;
    cookies?: unknown;
  };
  user?: unknown;
};

/**
 * Rewrites an event in place-ish and returns it.
 *
 * Fields that cannot be made safe are dropped rather than redacted: request
 * bodies, headers, cookies, and any notion of who the user is. Orca's own
 * correlation identifiers travel as tags, which are set deliberately and never
 * from user input.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const scrubbed: ScrubbableEvent = { ...event };

  if (typeof scrubbed.message === "string") {
    scrubbed.message = redactText(scrubbed.message);
  }

  if (scrubbed.exception?.values) {
    scrubbed.exception = {
      ...scrubbed.exception,
      values: scrubbed.exception.values.map((value) => ({
        ...value,
        value:
          typeof value.value === "string"
            ? redactText(value.value)
            : value.value,
      })),
    };
  }

  if (Array.isArray(scrubbed.breadcrumbs)) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs
      .map((crumb) => scrubBreadcrumb(crumb as ScrubbableBreadcrumb))
      .filter((crumb) => crumb !== null);
  }

  if (scrubbed.extra) {
    scrubbed.extra = Object.fromEntries(
      Object.entries(scrubbed.extra).map(([key, value]) => [
        key,
        typeof value === "string" ? redactText(value) : value,
      ]),
    );
  }

  // A request body may be a whole photo, a caption, or a recipient list. There
  // is no version of it worth sending.
  if (scrubbed.request) {
    scrubbed.request = {
      url: typeof scrubbed.request.url === "string" ? "[url]" : undefined,
    };
  }

  // Identity is never attached: a crash is diagnosed from stage, code, and
  // route, not from who was holding the phone.
  delete scrubbed.user;

  return scrubbed as T;
}

export type ScrubbableBreadcrumb = {
  category?: unknown;
  message?: unknown;
  data?: Record<string, unknown>;
  type?: unknown;
};

export function scrubBreadcrumb(
  crumb: ScrubbableBreadcrumb,
): ScrubbableBreadcrumb | null {
  // Console breadcrumbs replay whatever the app happened to log, including
  // anything a dependency logged. They are dropped wholesale.
  if (crumb.category === "console") return null;

  const scrubbed: ScrubbableBreadcrumb = { ...crumb };
  if (typeof scrubbed.message === "string") {
    scrubbed.message = redactText(scrubbed.message);
  }
  if (scrubbed.data) {
    scrubbed.data = Object.fromEntries(
      Object.entries(scrubbed.data).map(([key, value]) => [
        key,
        typeof value === "string" ? redactText(value) : value,
      ]),
    );
  }
  return scrubbed;
}
