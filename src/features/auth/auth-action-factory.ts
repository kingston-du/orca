import type { AuthError, SupabaseClient } from "@supabase/supabase-js";

export type EmailPasswordCredentials = {
  email: string;
  password: string;
};

export type AuthSubmissionResult =
  | {
      kind: "success";
      message?: string;
      nextStep?: { kind: "verify-email"; email: string };
    }
  | { kind: "error"; message: string };

type AuthAction = "sign-in" | "sign-up" | "verify-email" | "resend-code";
type EmailAuthClient = Pick<
  SupabaseClient["auth"],
  "resend" | "signInWithPassword" | "signUp" | "verifyOtp"
>;

function authErrorMessage(error: AuthError, action: AuthAction) {
  switch (error.code) {
    case "invalid_credentials":
      return "Email or password is incorrect.";
    case "email_not_confirmed":
      return "Confirm your email before signing in.";
    case "weak_password":
      return "Choose a stronger password and try again.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "Too many attempts. Wait a moment and try again.";
    case "otp_expired":
      return "That code is invalid or expired. Request a new one and try again.";
    case "email_address_invalid":
      return "Enter a valid email address.";
    case "email_address_not_authorized":
      return "Email delivery is not configured for this address yet.";
    case "signup_disabled":
      return "New account creation is temporarily unavailable.";
    case "request_timeout":
      return "The request timed out. Check your connection and try again.";
    default:
      if (action === "sign-in") {
        return "We couldn’t sign you in. Check your connection and try again.";
      }

      if (action === "verify-email") {
        return "We couldn’t verify that code. Check it and try again.";
      }

      if (action === "resend-code") {
        return "We couldn’t send a new code. Check your connection and try again.";
      }

      return "We couldn’t complete sign-up. Check your details and try again.";
  }
}

function normalizedCredentials(credentials: EmailPasswordCredentials) {
  return {
    email: credentials.email.trim().toLowerCase(),
    password: credentials.password,
  };
}

export function createEmailAuthActions(auth: EmailAuthClient) {
  async function signInWithPassword(
    credentials: EmailPasswordCredentials,
  ): Promise<AuthSubmissionResult> {
    const { error } = await auth.signInWithPassword(
      normalizedCredentials(credentials),
    );

    return error
      ? { kind: "error", message: authErrorMessage(error, "sign-in") }
      : { kind: "success" };
  }

  async function signUpWithPassword(
    credentials: EmailPasswordCredentials,
  ): Promise<AuthSubmissionResult> {
    const { data, error } = await auth.signUp(
      normalizedCredentials(credentials),
    );

    if (error) {
      return { kind: "error", message: authErrorMessage(error, "sign-up") };
    }

    return data.session
      ? { kind: "success" }
      : {
          kind: "success",
          nextStep: {
            kind: "verify-email",
            email: normalizedCredentials(credentials).email,
          },
        };
  }

  async function verifyEmailCode(
    email: string,
    token: string,
  ): Promise<AuthSubmissionResult> {
    const { error } = await auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token,
      type: "email",
    });

    return error
      ? { kind: "error", message: authErrorMessage(error, "verify-email") }
      : { kind: "success" };
  }

  async function resendSignupCode(
    email: string,
  ): Promise<AuthSubmissionResult> {
    const { error } = await auth.resend({
      email: email.trim().toLowerCase(),
      type: "signup",
    });

    return error
      ? { kind: "error", message: authErrorMessage(error, "resend-code") }
      : { kind: "success", message: "A new code is on its way." };
  }

  return {
    resendSignupCode,
    signInWithPassword,
    signUpWithPassword,
    verifyEmailCode,
  };
}
