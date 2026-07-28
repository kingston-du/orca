import { getAuthRouteAccess } from "@/features/auth/auth-route-access";

describe("getAuthRouteAccess", () => {
  test("keeps signed-out users in Auth routes", () => {
    expect(getAuthRouteAccess(false, false)).toEqual({
      canEnterApp: false,
      canEnterAuth: true,
    });
  });

  test("admits ordinary signed-in sessions to app routes", () => {
    expect(getAuthRouteAccess(true, false)).toEqual({
      canEnterApp: true,
      canEnterAuth: false,
    });
  });

  test("keeps temporary recovery sessions in Auth routes", () => {
    expect(getAuthRouteAccess(true, true)).toEqual({
      canEnterApp: false,
      canEnterAuth: true,
    });
  });
});
