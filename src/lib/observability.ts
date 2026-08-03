import {
  scrubBreadcrumb,
  scrubEvent,
  type ScrubbableBreadcrumb,
} from "@/lib/observability-scrub";

/**
 * The one place Orca talks to a crash reporter.
 *
 * Expo and React Native do not symbolicate or aggregate production crashes on
 * their own, which is the whole justification for a native dependency here.
 * Everything else about this integration is subtraction:
 *
 * - Session Replay is off, in both configuration and integration list. A replay
 *   of this app is a replay of private photos.
 * - Tracing is off. Orca has no performance question a sampled trace answers
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

/** Distinguishes the development backend from anything later; it never carries
 * a project reference or a key. */
const environment = __DEV__ ? "development" : "release";

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
    environment,
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
 * Reports a failure Orca could not handle, with no content attached.
 *
 * `domain` is a fixed, developer-written string such as `query:recent-moments`.
 * It is never built from user input, which is what keeps this call site safe
 * even before scrubbing runs.
 */
export function reportUnexpectedError(domain: string, error: unknown): void {
  if (!dsn) return;

  const Sentry = getSentryModule();
  Sentry.captureException(error, (scope) => {
    scope.setTag("domain", domain);
    return scope;
  });
}
