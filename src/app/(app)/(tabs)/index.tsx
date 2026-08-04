import { router } from "expo-router";
import { useCallback, useEffect, useMemo } from "react";

import { useAuth } from "@/features/auth/auth-provider";
import { useMomentDraft } from "@/features/moments/composer/composer-provider";
import {
  HomeScreen,
  type PendingMoment,
} from "@/features/moments/feed/home-screen";
import { PublishBanner } from "@/features/moments/publish/publish-banner";
import { useOwnOnboardingState } from "@/features/onboarding/use-own-onboarding-state";

const COMPOSE_ROUTE = "/(app)/moments/compose" as const;

/**
 * Home, and the landing pad for a Moment being shared.
 *
 * The composer hands the screen back at the first byte, so this route is where
 * an attempt finishes its life: the banner carries its progress and its
 * failures, and `pendingMoment` lets the deck draw the photo from the local
 * file until the server's own row arrives. Both live here rather than inside
 * `HomeScreen` because both are ultimately about navigation — the one thing a
 * screen must not reach for.
 */
export default function HomeRoute() {
  const { user } = useAuth();
  const own = useOwnOnboardingState(user?.id);
  const { publish } = useMomentDraft();

  const attempt = publish.state;
  const photo = attempt.pendingPhoto;
  const momentId = attempt.momentId;
  const settled = attempt.status === "published";
  const avatarPath = own.data?.avatar_path ?? null;
  const displayName = own.data?.display_name ?? "You";

  // An Archive Moment goes to the author's Diary and never to Home, so there is
  // no card here to wait for and nothing to land. The attempt is simply retired
  // once the server has taken it.
  const isArchive = photo?.kind === "archive";

  const { dismiss } = publish;
  useEffect(() => {
    if (settled && isArchive) dismiss();
  }, [dismiss, isArchive, settled]);

  const pendingMoment = useMemo<PendingMoment | null>(
    () =>
      photo === null || momentId === null || photo.kind === "archive"
        ? null
        : {
            authorAvatarPath: avatarPath,
            authorDisplayName: displayName,
            caption: photo.caption,
            capturedAt: photo.capturedAt,
            capturedUtcOffsetMinutes: photo.capturedUtcOffsetMinutes,
            momentId,
            photoUri: photo.uri,
            settled,
          },
    [avatarPath, displayName, momentId, photo, settled],
  );

  const review = useCallback(() => router.push(COMPOSE_ROUTE), []);

  return (
    <HomeScreen
      banner={
        <PublishBanner
          onCancel={publish.cancel}
          onCheckStatus={publish.checkStatus}
          onDismiss={dismiss}
          onReview={review}
          state={attempt}
        />
      }
      onAddFriend={() => router.push("/people")}
      onOpenCamera={() => router.push("/camera")}
      // Routes carry an opaque Moment ID only. Detail refetches and the server
      // reauthorizes on every entry, including cold deep links.
      onOpenMoment={(momentId) => router.push(`/moments/${momentId}`)}
      onOpenReactions={(momentId) =>
        router.push(`/moments/${momentId}/reactions`)
      }
      onPendingMomentLanded={dismiss}
      pendingMoment={pendingMoment}
    />
  );
}
