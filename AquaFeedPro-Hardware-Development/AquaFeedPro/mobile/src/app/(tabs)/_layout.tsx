import { Lucide } from "@react-native-vector-icons/lucide";
import { Tabs } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  Colors,
  IconSize,
  InterFamilies,
  MaxContentWidth,
} from "@/constants/theme";

const icons = {
  home: "house",
  schedule: "calendar-clock",
  history: "history",
  settings: "settings",
} as const;

function TabIcon({
  name,
  focused,
}: {
  name: keyof typeof icons;
  focused: boolean;
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.iconWell}
    >
      <Lucide
        name={icons[name]}
        size={IconSize.nav}
        color={focused ? Colors.light.ink : Colors.light.textTertiary}
      />
    </View>
  );
}

export default function TabLayout() {
  const insets = useSafeAreaInsets();

  return (
    <>
      <Tabs
        backBehavior="history"
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: Colors.light.background },
          tabBarLabelPosition: "below-icon",
          tabBarLabel: ({ focused, children }) => (
            <Text style={[styles.label, focused && styles.labelSelected]}>
              {children}
            </Text>
          ),
          tabBarStyle: [
            styles.tabBar,
            { height: 64 + insets.bottom, paddingBottom: insets.bottom },
          ],
          tabBarItemStyle: styles.tabItem,
          tabBarIconStyle: styles.tabIcon,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Home",
            tabBarIcon: ({ focused }) => (
              <TabIcon name="home" focused={focused} />
            ),
          }}
        />
        <Tabs.Screen
          name="schedule"
          options={{
            title: "Schedule",
            tabBarIcon: ({ focused }) => (
              <TabIcon name="schedule" focused={focused} />
            ),
          }}
        />
        <Tabs.Screen
          name="history"
          options={{
            title: "History",
            tabBarIcon: ({ focused }) => (
              <TabIcon name="history" focused={focused} />
            ),
          }}
        />
        {/* shortcut: the route stays /device so existing links and back fallbacks keep working; rename it if a second settings route ever appears. */}
        <Tabs.Screen
          name="device"
          options={{
            title: "Settings",
            tabBarIcon: ({ focused }) => (
              <TabIcon name="settings" focused={focused} />
            ),
          }}
        />
      </Tabs>
    </>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: Colors.light.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.light.border,
    paddingTop: 0,
    elevation: 0,
    shadowOpacity: 0,
    width: "100%",
    maxWidth: MaxContentWidth,
    alignSelf: "center",
  },
  tabItem: { height: 64, justifyContent: "center", alignItems: "center" },
  tabIcon: { width: 56, height: 32 },
  label: {
    fontFamily: InterFamilies.medium,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 4,
    color: Colors.light.textTertiary,
  },
  labelSelected: {
    fontFamily: InterFamilies.semibold,
    color: Colors.light.ink,
  },
  iconWell: {
    width: 56,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
});
