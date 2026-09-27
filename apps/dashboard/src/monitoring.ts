import * as Sentry from "@sentry/react";

export function startFrontendMonitoring(dsn: string, environment: string) {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
    tracePropagationTargets: [/^\/graphql$/],
    beforeSend(event) {
      delete event.user;
      if (event.request) {
        delete event.request.headers;
        delete event.request.data;
        if (event.request.url)
          event.request.url = event.request.url.split("?")[0];
      }
      return event;
    },
  });
}
