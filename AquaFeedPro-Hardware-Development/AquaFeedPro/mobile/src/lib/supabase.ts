import "react-native-url-polyfill/auto";

import { createClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import "expo-sqlite/localStorage/install";
import { Platform } from "react-native";

import type { Database } from "../../../supabase/database.types";
import {
  createSecureSessionStorage,
  SESSION_STORAGE_KEY,
} from "./secure-session-storage";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabasePublishableKey =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

const secureOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const secureSessionStorage = createSecureSessionStorage(
  SecureStore,
  secureOptions,
);

/** Remove only the previous Supabase SQLite auth value; it is never read or used as fallback. */
export function removeLegacySqliteSession() {
  if (Platform.OS === "web") return;
  const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
  if (projectRef) localStorage.removeItem(`sb-${projectRef}-auth-token`);
}

export const supabase = createClient<Database>(
  supabaseUrl,
  supabasePublishableKey,
  {
    auth: {
      storage: secureSessionStorage,
      storageKey: SESSION_STORAGE_KEY,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);
