import * as Haptics from "expo-haptics";

/**
 * Restrained haptic feedback.
 *
 * Every call here accompanies something the user can already see or hear.
 * Haptics never carry meaning alone — a user with the Taptic Engine disabled,
 * or one who cannot feel it, must lose nothing — so these are confirmation of
 * an event that has its own visible result, not the result itself.
 *
 * Failures are swallowed on purpose. A device without a Taptic Engine, or one
 * where the system refuses the request, is not a reason to fail the action the
 * haptic was decorating.
 */
function fire(run: () => Promise<void>) {
  void run().catch(() => {
    // Decoration only; a missing tap is never worth surfacing.
  });
}

/** The camera shutter fired. */
export function hapticShutter() {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}

/** A Moment finished publishing. */
export function hapticPublished() {
  fire(() =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  );
}

/** A Heart was committed, or a reaction was cleared. */
export function hapticReaction() {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/**
 * A Superheart was committed.
 *
 * Heavier than a Heart on purpose: three a day is a budget, and the hand should
 * be able to tell which of the two controls it just spent without looking.
 */
export function hapticSuperheart() {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));
}

/** A selection changed — a segment, a tag, a recipient. */
export function hapticSelection() {
  fire(() => Haptics.selectionAsync());
}
