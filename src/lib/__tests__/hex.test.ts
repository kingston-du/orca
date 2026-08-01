import { toHex } from "@/lib/hex";

describe("toHex", () => {
  test("renders a digest as lowercase hex with leading zeros preserved", () => {
    const digest = Uint8Array.from([0x00, 0x0f, 0xff, 0xa0]).buffer;

    expect(toHex(digest)).toBe("000fffa0");
  });
});
