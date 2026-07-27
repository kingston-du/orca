import { createPasswordAuthActions } from "@/features/auth/auth-action-factory";
import { supabase } from "@/lib/supabase";

export type {
  AuthSubmissionResult,
  EmailPasswordCredentials,
} from "@/features/auth/auth-action-factory";

export const { signInWithPassword, signUpWithPassword } =
  createPasswordAuthActions(supabase.auth);
