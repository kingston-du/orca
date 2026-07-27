import { validateCredentials } from "@/features/auth/auth-validation";

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
        { email: "friend@example.com", password: "short" },
        "different",
      ),
    ).toEqual({
      password: "Use at least 8 characters.",
      confirmPassword: "Passwords do not match.",
    });
  });
});
