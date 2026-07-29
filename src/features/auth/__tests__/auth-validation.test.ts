import {
  validateCredentials,
  validateEmail,
  validateNewPassword,
} from "@/features/auth/auth-validation";

describe("validateCredentials", () => {
  test("requires valid sign-in credentials", () => {
    expect(
      validateCredentials(
        "sign-in",
        { email: "not-an-email", password: "" },
        "",
      ),
    ).toEqual({
      email: "Enter a valid email address.",
      password: "Enter your password.",
    });
  });

  test("requires an eight-character confirmed password for sign-up", () => {
    expect(
      validateCredentials(
        "sign-up",
        { email: "friend@example.com", password: "short", inviteCode: "" },
        "different",
      ),
    ).toEqual({
      password: "Use at least 8 characters.",
      confirmPassword: "Passwords do not match.",
      inviteCode: "Enter the 64-character invitation code from your friend.",
    });
  });

  test("accepts a trimmed uppercase invitation code after normalization", () => {
    expect(
      validateCredentials(
        "sign-up",
        {
          email: "friend@example.com",
          password: "password123",
          inviteCode: `  ${"A".repeat(64)}  `,
        },
        "password123",
      ),
    ).toEqual({});
  });

  test("validates recovery email without requiring a password", () => {
    expect(validateEmail("not-an-email")).toBe("Enter a valid email address.");
    expect(validateEmail("friend@example.com")).toBeUndefined();
  });

  test("validates a confirmed replacement password", () => {
    expect(validateNewPassword("short", "different")).toEqual({
      password: "Use at least 8 characters.",
      confirmPassword: "Passwords do not match.",
    });
  });
});
