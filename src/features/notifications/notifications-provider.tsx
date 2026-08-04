import { useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import { useAuth } from "@/features/auth/auth-provider";
import { useMomentDraft } from "@/features/moments/composer/composer-provider";
import { useAppIsActive } from "@/features/moments/feed/use-app-is-active";
import { isPublishInFlight } from "@/features/moments/publish/publish-machine";

import { NotificationPrePrompt } from "./notification-pre-prompt";
import {
  readPermissionState,
  registerCurrentDevice,
  requestPermissionAndRegister,
  type PermissionState,
} from "./notification-permission";
import {
  dismissNotificationPrompt,
  markNotificationPromptEarned,
  readNotificationPromptState,
  shouldShowPrePrompt,
  type PromptState,
} from "./notification-prompt";
import {
  pushRouteToPath,
  queryKeysToInvalidate,
  toPushEventId,
  toPushRoute,
  type PendingNavigation,
} from "./notification-routing";
import { notificationSettingsQueryKey } from "./use-notification-settings";

/**
 * A foreground notification is shown, and that is all it does.
 *
 * It must not insert into or reorder the Home deck — Section 18 is explicit —
 * so the banner is the entire foreground behaviour and the cache invalidation
 * below is deliberately limited to the arrivals probe and scoped counts. The
 * badge is left alone because Splotty has no unread model to keep it honest.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

type NotificationsContextValue = {
  permission: PermissionState;
  enable: () => Promise<void>;
};

const NotificationsContext = createContext<NotificationsContextValue | null>(
  null,
);

export function NotificationsProvider({ children }: PropsWithChildren) {
  const { user } = useAuth();
  // Read once. The React Compiler cannot preserve a `useCallback` whose body
  // narrows `user.id` while its dependency list names `user?.id`.
  const userId = user?.id ?? null;
  const queryClient = useQueryClient();
  const { publish } = useMomentDraft();
  const [permission, setPermission] =
    useState<PermissionState>("not_requested");
  const [promptState, setPromptState] = useState<PromptState>("not_earned");
  const pending = useRef<PendingNavigation | null>(null);
  const handledEvents = useRef(new Set<string>());
  const publishInFlight = isPublishInFlight(publish.state);
  const appIsActive = useAppIsActive();

  // Launch, and every return to the foreground. The second case is what makes
  // the Settings screen honest after someone follows "Open iOS Settings" and
  // changes the permission out from under the app; the token refresh is here
  // because a rotated token the server never hears about is silently
  // undeliverable.
  useEffect(() => {
    if (!userId || !appIsActive) return;
    let cancelled = false;

    void (async () => {
      const state = await readPermissionState();
      if (cancelled) return;
      setPermission(state);
      setPromptState(await readNotificationPromptState(userId));

      if (state === "granted" || state === "provisional") {
        await registerCurrentDevice();
        if (!cancelled) {
          void queryClient.invalidateQueries({
            queryKey: notificationSettingsQueryKey(userId),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [appIsActive, queryClient, userId]);

  const follow = useCallback((navigation: PendingNavigation) => {
    pending.current = null;
    router.push(pushRouteToPath(navigation.route));
  }, []);

  const handleResponse = useCallback(
    (data: unknown) => {
      const route = toPushRoute(data);
      if (!route) return;

      const eventId = toPushEventId(data);
      // The OS replays the last response on cold start, so the same tap can
      // arrive twice. Navigating twice would push a duplicate screen.
      if (eventId && handledEvents.current.has(eventId)) return;
      if (eventId) handledEvents.current.add(eventId);

      const navigation: PendingNavigation = { eventId, route };
      if (publishInFlight) {
        // Never discard or replace an active draft to satisfy a link. The
        // newest intent is held and runs once publishing settles.
        pending.current = navigation;
        return;
      }
      follow(navigation);
    },
    [follow, publishInFlight],
  );

  // Held intents execute the moment the draft settles, in either direction —
  // published, cancelled, or recovered.
  useEffect(() => {
    if (publishInFlight) return;
    const held = pending.current;
    if (held) follow(held);
  }, [follow, publishInFlight]);

  // The second earning moment. Watched here rather than pushed from the publish
  // controller, because a controller that knows about notifications would have
  // to be told about every future reason to ask for a permission.
  useEffect(() => {
    if (publish.state.status !== "published" || !userId) return;
    let cancelled = false;

    void (async () => {
      await markNotificationPromptEarned(userId);
      const state = await readNotificationPromptState(userId);
      if (!cancelled) setPromptState(state);
    })();

    return () => {
      cancelled = true;
    };
  }, [publish.state.status, userId]);

  useEffect(() => {
    if (!userId) return;

    const received = Notifications.addNotificationReceivedListener(
      (notification) => {
        const route = toPushRoute(notification.request.content.data);
        if (!route) return;
        for (const key of queryKeysToInvalidate(route)) {
          void queryClient.invalidateQueries({ queryKey: [key] });
        }
      },
    );

    const responded = Notifications.addNotificationResponseReceivedListener(
      (response) => handleResponse(response.notification.request.content.data),
    );

    return () => {
      received.remove();
      responded.remove();
    };
  }, [handleResponse, queryClient, userId]);

  const enable = useCallback(async () => {
    const outcome = await requestPermissionAndRegister();
    setPermission(await readPermissionState());
    if (userId) {
      // Whatever iOS answered, the pre-prompt has had its turn.
      await dismissNotificationPrompt(userId);
      setPromptState("dismissed");
      if (outcome.status === "registered") {
        void queryClient.invalidateQueries({
          queryKey: notificationSettingsQueryKey(userId),
        });
      }
    }
  }, [queryClient, userId]);

  const declinePrePrompt = useCallback(async () => {
    if (!userId) return;
    await dismissNotificationPrompt(userId);
    setPromptState("dismissed");
  }, [userId]);

  return (
    <NotificationsContext.Provider value={{ enable, permission }}>
      {children}
      {shouldShowPrePrompt({ permission, promptState }) ? (
        <NotificationPrePrompt
          onDecline={() => void declinePrePrompt()}
          onEnable={() => void enable()}
        />
      ) : null}
    </NotificationsContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationsContext);
  if (!context) {
    throw new Error(
      "useNotifications must be used inside NotificationsProvider",
    );
  }
  return context;
}
