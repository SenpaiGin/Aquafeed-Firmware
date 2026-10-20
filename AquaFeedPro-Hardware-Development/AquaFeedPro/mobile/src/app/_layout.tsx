import "@/lib/install-crypto";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import {
  AppIcon,
  AppPage,
  Button,
  Notice,
  ScreenHeader,
} from "@/components/app-shell";
import { Colors, Spacing, Typography } from "@/constants/theme";
import { DeviceAccessProvider, useDeviceAccess } from "@/lib/device-access";
import { NotificationController } from "@/lib/notification-controller";

void SplashScreen.preventAutoHideAsync();

export const unstable_settings = { anchor: "(tabs)" };

const sheetOptions = {
  presentation: "transparentModal",
  animation: "none",
  contentStyle: { backgroundColor: "transparent" },
} as const;

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      void SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <DeviceAccessProvider>
      <NotificationController />
      <StatusBar style="dark" />
      <RootNavigator />
    </DeviceAccessProvider>
  );
}

function RootNavigator() {
  const { phase, bootstrapError, retryBootstrap } = useDeviceAccess();
  if (phase === "loading") {
    return (
      <View style={styles.launch}>
        <AppIcon size={96} decorative />
        <Text accessibilityRole="header" style={styles.launchTitle}>
          AquaFeed Pro
        </Text>
        <View style={styles.launchStatus}>
          <ActivityIndicator size="small" color={Colors.light.ink} />
          <Text style={Typography.supporting}>
            Restoring this installation securely.
          </Text>
        </View>
      </View>
    );
  }
  if (phase === "error") {
    return (
      <AppPage>
        <ScreenHeader title="Installation unavailable" />
        <Notice tone="error">
          {bootstrapError ?? "Secure installation access is unavailable."}
        </Notice>
        <Button onPress={retryBootstrap} icon="rotate-ccw">
          Retry installation
        </Button>
      </AppPage>
    );
  }
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: Colors.light.background },
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="dev/components" />
      <Stack.Screen name="devices/add" />
      <Stack.Screen name="devices/[deviceId]" />
      <Stack.Screen name="schedules/new" options={sheetOptions} />
      <Stack.Screen name="schedules/[scheduleId]" options={sheetOptions} />
      <Stack.Screen name="history/[runId]" />
      <Stack.Screen name="feed/confirm" options={sheetOptions} />
      <Stack.Screen name="settings/[field]" options={sheetOptions} />
      <Stack.Screen name="notifications" options={sheetOptions} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  launch: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.page,
    paddingBottom: 120,
    backgroundColor: Colors.light.background,
  },
  launchTitle: {
    ...Typography.title,
    marginTop: Spacing.four,
    textAlign: "center",
  },
  launchStatus: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.two,
  },
});
