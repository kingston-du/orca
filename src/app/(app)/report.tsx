import { useLocalSearchParams, useRouter } from "expo-router";

import { ReportScreen } from "@/features/safety/report-screen";

/**
 * The report route.
 *
 * It carries an opaque subject ID and a kind, and nothing else: no caption, no
 * username, no signed URL. `subjectLabel` is display text the calling screen
 * already had on screen, so passing it reveals nothing the reporter cannot see.
 */
export default function ReportRoute() {
  const router = useRouter();
  const { id, kind, label } = useLocalSearchParams<{
    id?: string;
    kind?: string;
    label?: string;
  }>();

  const subjectKind = kind === "profile" ? "profile" : "moment";

  if (!id) {
    router.back();
    return null;
  }

  return (
    <ReportScreen
      onBack={() => router.back()}
      onDone={() => router.back()}
      subjectId={id}
      subjectKind={subjectKind}
      subjectLabel={label ?? null}
    />
  );
}
