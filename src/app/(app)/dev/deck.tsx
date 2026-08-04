import { Redirect } from "expo-router";
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { color, spacing, typeScale } from "@/constants/design";
import {
  isDeckInstrumentationEnabled,
  measureDeckStages,
} from "@/features/moments/feed/deck-instrumentation";
import {
  MomentAuthor,
  MomentCaption,
  MomentCaptureTime,
} from "@/features/moments/feed/moment-card";
import { MomentPhotoFrame } from "@/features/moments/feed/moment-photo";

/**
 * The release-build design and performance harness.
 *
 * It is gated on the same build-time flag as the instrumentation, not on
 * `__DEV__`, for the reason that flag exists: the things worth checking here —
 * how the fixed photo container behaves at real Dynamic Type sizes, whether the
 * metadata still reads at 200%, what the deck's timings actually are — are all
 * properties of an optimized build on a real device. A `__DEV__` harness can
 * only ever show them under Metro, where they are not true.
 *
 * In every ordinary build `isDeckInstrumentationEnabled()` folds to false and
 * this route redirects to Home before rendering anything.
 *
 * It draws the **real** components — the same photo frame and the same metadata
 * elements the feed ships — against extreme aspect ratios. It deliberately
 * cannot show a real photo: media needs an authorized row and a signed URL, and
 * a harness that faked one would be checking something Splotty never renders.
 */
export default function DeckHarnessRoute() {
  const { width } = useWindowDimensions();
  const availableWidth = width - spacing.lg * 2;

  if (!isDeckInstrumentationEnabled()) {
    return <Redirect href="/" />;
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text accessibilityRole="header" style={styles.title}>
        Deck harness
      </Text>

      <Text style={styles.section}>Photo container</Text>
      <Text style={styles.note}>
        Every ratio below must produce the same container height, with the
        subject letterboxed onto the neutral backing rather than cropped.
      </Text>
      {ASPECTS.map((aspect) => (
        <View key={aspect.label} style={styles.specimen}>
          <Text style={styles.specimenLabel}>{aspect.label}</Text>
          <MomentPhotoFrame availableWidth={availableWidth}>
            <View style={styles.contain}>
              <View
                style={[
                  styles.stand,
                  aspect.ratio >= 1
                    ? { width: "100%", aspectRatio: aspect.ratio }
                    : { height: "100%", aspectRatio: aspect.ratio },
                ]}
              />
            </View>
          </MomentPhotoFrame>
        </View>
      ))}

      <Text style={styles.section}>Metadata</Text>
      {SPECIMENS.map((specimen) => (
        <View key={specimen.author_username} style={styles.specimen}>
          <MomentAuthor moment={specimen} />
          <MomentCaptureTime moment={specimen} now={new Date()} />
          <MomentCaption caption={specimen.caption} />
        </View>
      ))}

      <Text style={styles.section}>Timings</Text>
      {BUDGETS.map((budget) => {
        const measured = measureDeckStages(budget.from, budget.to);
        return (
          <Text key={budget.label} style={styles.note}>
            {budget.label}:{" "}
            {measured === null ? "not measured yet" : `${measured} ms`}
          </Text>
        );
      })}
    </ScrollView>
  );
}

const ASPECTS = [
  { label: "iPhone portrait 3:4", ratio: 3 / 4 },
  { label: "Portrait 4:5", ratio: 4 / 5 },
  { label: "Square 1:1", ratio: 1 },
  { label: "Landscape 3:2", ratio: 3 / 2 },
  { label: "Panorama 3:1", ratio: 3 },
  { label: "Tall 9:21", ratio: 9 / 21 },
] as const;

const SPECIMENS = [
  {
    author_avatar_path: null,
    author_display_name: "Sam",
    author_username: "sam",
    captured_at: new Date().toISOString(),
    captured_utc_offset_minutes: -300,
    caption: null,
    viewer_is_author: false,
  },
  {
    author_avatar_path: null,
    author_display_name:
      "A display name long enough to need more than one line on a small phone",
    author_username: "long_name_example",
    captured_at: "2026-01-14T21:07:00.000Z",
    captured_utc_offset_minutes: 540,
    caption:
      "A caption at the full one hundred and sixty code points, which is the " +
      "longest thing this card ever has to lay out without clipping a word.",
    viewer_is_author: false,
  },
  {
    author_avatar_path: null,
    author_display_name: "Unknown time",
    author_username: "unknown_time",
    captured_at: null,
    captured_utc_offset_minutes: null,
    caption: "Publication time is never shown here as capture time.",
    viewer_is_author: false,
  },
  {
    // The viewer's own Moment: the card says "You" and drops the handle, so
    // this specimen exists to prove the row still balances without one.
    author_avatar_path: null,
    author_display_name: "Your Own Long Display Name",
    author_username: "you",
    captured_at: new Date().toISOString(),
    captured_utc_offset_minutes: -300,
    caption:
      "Your own Moment reads as “You” wherever anyone else's name would.",
    viewer_is_author: true,
  },
] as const;

const BUDGETS = [
  {
    label: "Page request to first card",
    from: "page_requested",
    to: "page_rendered",
  },
  {
    label: "Photo request to decode",
    from: "photo_requested",
    to: "photo_shown",
  },
  {
    label: "Older/Newer to settled",
    from: "move_requested",
    to: "move_settled",
  },
] as const;

const styles = StyleSheet.create({
  contain: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  note: { ...typeScale.caption, color: color.textSecondary },
  page: {
    backgroundColor: color.canvas,
    gap: spacing.md,
    padding: spacing.lg,
  },
  section: {
    ...typeScale.heading,
    color: color.textPrimary,
    marginTop: spacing.lg,
  },
  specimen: { gap: spacing.sm },
  specimenLabel: { ...typeScale.caption, color: color.textSecondary },
  stand: { backgroundColor: color.brand },
  title: { ...typeScale.title, color: color.textPrimary },
});
