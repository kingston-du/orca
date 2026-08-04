type ObservabilityModule = typeof import("@/lib/observability");

const originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
const originalEnvironment = process.env.EXPO_PUBLIC_ORCA_ENVIRONMENT;

function loadObservability(): ObservabilityModule {
  let loaded: ObservabilityModule | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<ObservabilityModule>("@/lib/observability");
  });
  if (!loaded) throw new Error("Observability module did not load");
  return loaded;
}

afterEach(() => {
  if (originalDsn === undefined) {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  } else {
    process.env.EXPO_PUBLIC_SENTRY_DSN = originalDsn;
  }
  if (originalEnvironment === undefined) {
    delete process.env.EXPO_PUBLIC_ORCA_ENVIRONMENT;
  } else {
    process.env.EXPO_PUBLIC_ORCA_ENVIRONMENT = originalEnvironment;
  }
  jest.resetModules();
  jest.dontMock("@sentry/react-native");
});

it("does not execute the Sentry runtime when no DSN is configured", () => {
  delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  let sentryLoaded = false;
  const captureException = jest.fn();
  const init = jest.fn();
  jest.doMock("@sentry/react-native", () => {
    sentryLoaded = true;
    return { captureException, init };
  });

  const observability = loadObservability();

  expect(sentryLoaded).toBe(false);
  expect(observability.initializeObservability()).toBe(false);
  observability.reportUnexpectedError("query:recent-moments", new Error());
  expect(sentryLoaded).toBe(false);
  expect(init).not.toHaveBeenCalled();
  expect(captureException).not.toHaveBeenCalled();
});

it("loads and initializes the scrubbed integration in a configured build", () => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = "https://public@example.test/1";
  process.env.EXPO_PUBLIC_ORCA_ENVIRONMENT = "preview";
  const captureException = jest.fn();
  const init = jest.fn();
  jest.doMock("@sentry/react-native", () => ({ captureException, init }));

  const observability = loadObservability();

  expect(observability.initializeObservability()).toBe(true);
  expect(init).toHaveBeenCalledWith(
    expect.objectContaining({
      dsn: "https://public@example.test/1",
      enableAutoPerformanceTracing: false,
      environment: "preview",
      replaysOnErrorSampleRate: 0,
      replaysSessionSampleRate: 0,
      sendDefaultPii: false,
      tracesSampleRate: 0,
    }),
  );

  const error = new Error("boom");
  observability.reportUnexpectedError("query:recent-moments", error);
  expect(captureException).toHaveBeenCalledWith(error, expect.any(Function));
});

it("does not let an invalid label masquerade as production", () => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = "https://public@example.test/1";
  process.env.EXPO_PUBLIC_ORCA_ENVIRONMENT = "prod-ish";
  const init = jest.fn();
  jest.doMock("@sentry/react-native", () => ({
    captureException: jest.fn(),
    init,
  }));

  loadObservability().initializeObservability();

  expect(init).toHaveBeenCalledWith(
    expect.objectContaining({ environment: "development" }),
  );
});
