import { createEmailAuthActions } from "@/features/auth/auth-action-factory";
import { supabase } from "@/lib/supabase";

export type {
  AuthSubmissionResult,
  EmailPasswordCredentials,
} from "@/features/auth/auth-action-factory";

export const {
  requestPasswordReset,
  resendSignupCode,
  resetPasswordWithCode,
  signInWithPassword,
  signUpWithPassword,
  verifyEmailCode,
} = createEmailAuthActions(supabase.auth);
