import {
  scrubBreadcrumb,
  scrubEvent,
  type ScrubbableBreadcrumb,
} from "@/lib/observability-scrub";

/**
 * The one place Splotty talks to a crash reporter.
 *
 * Expo and React Native do not symbolicate or aggregate production crashes on
 * their own, which is the whole justification for a native dependency here.
 * Everything else about this integration is subtraction:
 *
 * - Session Replay is off, in both configuration and integration list. A replay
 *   of this app is a replay of private photos.
 * - Tracing is off. Splotty has no performance question a sampled trace answers
 *   yet, and spans carry URLs.
 * - `sendDefaultPii` is false and the user object is deleted on the way out, so
 *   a crash is never attributed to a person.
 * - Every string that leaves is scrubbed by rules that live in a pure module
 *   with their own tests.
 *
 * With no DSN configured the whole module is inert: `initializeObservability`
 * returns false and nothing is ever sent. That is the state of every build
 * until the founder provisions a Sentry project, which is theirs to decide.
 */

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

type SentryModule = typeof import("@sentry/react-native");
let sentryModule: SentryModule | undefined;

/**
 * Metro's literal `require` stays in the bundle but does not execute the
 * Sentry module until a configured build actually needs it. Importing Sentry
 * eagerly starts an internal cleanup interval even with no DSN, which made the
 * integration observably non-inert and kept Jest alive after every suite that
 * imported the query client.
 */
function getSentryModule(): SentryModule {
  // This is intentionally the synchronous, lazy Metro primitive: a static
  // import executes Sentry in DSN-less builds, while `import()` would let app
  // rendering race ahead of crash-handler installation in configured builds.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sentryModule ??= require("@sentry/react-native") as SentryModule;
  return sentryModule;
}

type ObservabilityEnvironment = "development" | "preview" | "production";

/**
 * Distinguishes local, internal-TestFlight, and eventual production events.
 * It never carries a project reference or key. A release build without an
 * explicit label fails toward `preview`, so an ad-hoc archive cannot silently
 * present itself as production telemetry.
 */
function getObservabilityEnvironment(): ObservabilityEnvironment {
  const configured = process.env.EXPO_PUBLIC_ORCA_ENVIRONMENT;
  if (
    configured === "development" ||
    configured === "preview" ||
    configured === "production"
  ) {
    return configured;
  }
  return __DEV__ ? "development" : "preview";
}

export function initializeObservability(): boolean {
  if (!dsn) return false;

  const Sentry = getSentryModule();
  Sentry.init({
    beforeBreadcrumb: (crumb) =>
      scrubBreadcrumb(crumb as ScrubbableBreadcrumb) as typeof crumb | null,
    beforeSend: (event) => scrubEvent(event),
    dsn,
    // Off explicitly as well as by omission: a future default flip must not
    // silently start recording screens.
    enableAutoPerformanceTracing: false,
    environment: getObservabilityEnvironment(),
    // The integration list is filtered rather than trusted, so a version that
    // adds Replay to the defaults cannot enable it here.
    integrations: (defaults) =>
      defaults.filter(
        (integration) =>
          !/replay|screenshot|viewhierarchy|userinteraction/i.test(
            integration.name,
          ),
      ),
    replaysOnErrorSampleRate: 0,
    replaysSessionSampleRate: 0,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });

  return true;
}

/**
 * Reports a failure Splotty could not handle, with no content attached.
 *
 * `domain` is a fixed, developer-written string such as `query:recent-moments`.
 * It is never built from user input, which is what keeps this call site safe
 * even before scrubbing runs.
 */
export function reportUnexpectedError(domain: string, error: unknown): void {
  if (!dsn) return;

  const Sentry = getSentryModule();
  const code = readErrorCode(error);
  Sentry.captureException(asException(error, code), (scope) => {
    scope.setTag("domain", domain);
    if (code) scope.setTag("error_code", code);
    // Grouped by what failed and why rather than by Sentry's synthesized
    // title, which was identical for every rejected Supabase call in the app
    // and therefore collapsed unrelated failures into one unreadable issue.
    scope.setFingerprint(["{{ default }}", domain, code ?? "unknown"]);
    return scope;
  });
}

/**
 * The PostgREST/Supabase error code, when there is one.
 *
 * A `PostgrestError` is a plain object of `{ message, details, hint, code }`.
 * Only `code` travels: it is a SQLSTATE or a `PGRST…` identifier, which names a
 * failure without quoting anything. The other three are PostgREST's own prose
 * and can echo a column value back — a caption, a username, a path.
 */
function readErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code: unknown }).code;
  // Shape-checked rather than trusted, so a field that happens to be called
  // `code` on some future error object cannot smuggle content into a tag.
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code)
    ? code
    : null;
}

/**
 * Supabase rejects with a plain object, and Sentry captures a plain object as
 * "Object captured as exception with keys: code, details, hint, message" — an
 * unactionable title, no stack of its own, and the same one for every failing
 * call in the app. Wrapping it in a real `Error` named by its code is what
 * makes the issue say which failure it is.
 */
function asException(error: unknown, code: string | null): unknown {
  if (error instanceof Error) return error;

  const wrapped = new Error(
    code ? `Supabase request failed (${code})` : "Non-Error value was thrown",
  );
  wrapped.name = "SupabaseError";
  return wrapped;
}
