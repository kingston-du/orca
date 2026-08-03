import { Tabs } from "expo-router";

import { AppTabBar } from "@/components/tab-bar";

/**
 * Home, Camera, People — the three primary destinations, unchanged.
 *
 * Every header is off: 9C's screens draw their own 44-point row so they can
 * hold an avatar, a badge, or nothing at all, none of which a native bar does
 * well. The bar itself is ours because the centre Camera affordance is a
 * raised disc rather than a labelled tab.
 */
export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <AppTabBar {...props} />}
    >
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="camera" options={{ title: "Camera" }} />
      <Tabs.Screen name="people" options={{ title: "People" }} />
    </Tabs>
  );
}
