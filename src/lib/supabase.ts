import "react-native-url-polyfill/auto";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { authStorage } from "@/lib/auth-storage";

const supabaseURL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseURL || !supabasePublishableKey) {
  throw new Error("Missing Supabase environment variables");
}

/** Exposed so account-scoped local records can be bound to the environment
 * they belong to, preventing a build pointed at a different backend from
 * reusing state the current server would not recognize. */
export const supabaseUrl = supabaseURL;

export const supabase = createClient<Database>(
  supabaseURL,
  supabasePublishableKey,
  {
    auth: {
      storage: authStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);
