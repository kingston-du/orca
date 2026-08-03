import { Tabs } from "expo-router";
import type { ComponentProps } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, type IconName } from "@/components/icon";
import {
  CAMERA_BUTTON_SIZE,
  MINIMUM_TOUCH_TARGET,
  TAB_BAR_CONTENT_HEIGHT,
  TAB_LABEL_MAX_FONT_SCALE,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";

/**
 * How each route draws itself. Camera is `capture`: the design lifts it out of
 * the row into a filled disc, because taking a photo is the app's one primary
 * action and a text label beside two others would not say so.
 */
const TABS: Record<
  string,
  | { kind: "label"; icon: IconName; iconSelected: IconName; title: string }
  | { kind: "capture"; icon: IconName; title: string }
> = {
  index: {
    kind: "label",
    icon: "home",
    iconSelected: "homeSelected",
    title: "Home",
  },
  camera: { kind: "capture", icon: "camera", title: "Camera" },
  people: {
    kind: "label",
    icon: "people",
    iconSelected: "peopleSelected",
    title: "People",
  },
};

/**
 * Derived from Expo Router's own `tabBar` prop rather than imported from
 * `@react-navigation/bottom-tabs`, which is not a direct dependency — the
 * navigator is vendored inside `expo-router`, so importing its internal path
 * would break on any reshuffle. This is the public surface.
 */
type AppTabBarProps = Parameters<
  NonNullable<ComponentProps<typeof Tabs>["tabBar"]>
>[0];

export function AppTabBar({ descriptors, navigation, state }: AppTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.bar,
        { paddingBottom: Math.max(insets.bottom, spacing.md) },
      ]}
    >
      {state.routes.map((route, index) => {
        const config = TABS[route.name];
        if (!config) {
          return null;
        }

        const focused = state.index === index;
        const { options } = descriptors[route.key];

        function handlePress() {
          const event = navigation.emit({
            canPreventDefault: true,
            target: route.key,
            type: "tabPress",
          });

          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params);
          }
        }

        // The disc has no visible label, so the accessible name has to be
        // stated rather than inferred from the text beside the icon.
        if (config.kind === "capture") {
          return (
            <Pressable
              accessibilityLabel={options.title ?? config.title}
              accessibilityRole="button"
              accessibilityState={{ selected: focused }}
              key={route.key}
              onPress={handlePress}
              style={({ pressed }) => [
                styles.capture,
                pressed ? styles.capturePressed : null,
              ]}
              testID="tab-camera"
            >
              <Icon name={config.icon} size={26} tint={color.textInverse} />
            </Pressable>
          );
        }

        return (
          <Pressable
            accessibilityLabel={options.title ?? config.title}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            key={route.key}
            onPress={handlePress}
            style={styles.tab}
            testID={`tab-${route.name}`}
          >
            <Icon
              name={focused ? config.iconSelected : config.icon}
              size={24}
              tint={focused ? color.textPrimary : color.textSecondary}
            />
            <Text
              // The one capped role in the app: a tab bar cannot scroll, so an
              // uncapped label at 200% would clip. The icon above carries the
              // same meaning, so nothing is lost at the cap.
              maxFontSizeMultiplier={TAB_LABEL_MAX_FONT_SCALE}
              numberOfLines={1}
              style={focused ? styles.labelSelected : styles.label}
            >
              {config.title}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: "flex-start",
    backgroundColor: color.canvas,
    borderTopColor: color.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-around",
    paddingTop: spacing.md,
  },
  capture: {
    alignItems: "center",
    backgroundColor: color.brand,
    borderRadius: radius.pill,
    height: CAMERA_BUTTON_SIZE,
    justifyContent: "center",
    // Raised out of the row, as the design draws it.
    marginTop: -6,
    width: CAMERA_BUTTON_SIZE,
  },
  capturePressed: { backgroundColor: color.brandPressed },
  label: { ...typeScale.tabLabel, color: color.textSecondary },
  labelSelected: { ...typeScale.tabLabel, color: color.textPrimary },
  tab: {
    alignItems: "center",
    gap: spacing.xs,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    minWidth: 72,
    paddingTop: 2,
  },
});

export const TAB_BAR_HEIGHT = TAB_BAR_CONTENT_HEIGHT;
