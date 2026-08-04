import { UNKNOWN_CAPTURE_EVIDENCE } from "@/features/moments/capture/capture-evidence";
import type { NormalizedPhoto } from "@/features/moments/capture/photo-normalizer";
import {
  discardMomentDraft,
  readMomentDraft,
  saveMomentDraft,
} from "@/features/moments/composer/draft-storage";
import type { MomentDraft } from "@/features/moments/composer/moment-draft";

/**
 * A minimal in-memory filesystem standing in for the native module.
 *
 * The point is not to reimplement Expo FileSystem; it is to prove Splotty's own
 * rules — scoping, write order, and what happens when the media file is gone —
 * without a device.
 */
const mockFiles = new Map<string, string>();
const mockDirectories = new Set<string>();

function mockJoin(parts: unknown[]): string {
  return parts
    .map((part) =>
      typeof part === "string"
        ? part
        : (part as { uri: string }).uri.replace(/\/$/, ""),
    )
    .join("/");
}

jest.mock("expo-file-system", () => {
  class MockDirectory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = mockJoin(parts);
    }
    get exists() {
      return mockDirectories.has(this.uri);
    }
    create() {
      const segments = this.uri.split("/");
      for (let index = 1; index <= segments.length; index += 1) {
        mockDirectories.add(segments.slice(0, index).join("/"));
      }
    }
    delete() {
      mockDirectories.delete(this.uri);
      for (const key of [...mockFiles.keys()]) {
        if (key.startsWith(`${this.uri}/`)) mockFiles.delete(key);
      }
      for (const key of [...mockDirectories]) {
        if (key.startsWith(`${this.uri}/`)) mockDirectories.delete(key);
      }
    }
  }

  class MockFile {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = mockJoin(parts);
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    get size() {
      return mockFiles.get(this.uri)?.length ?? 0;
    }
    create() {
      mockFiles.set(this.uri, "");
    }
    write(content: string) {
      mockFiles.set(this.uri, content);
    }
    text() {
      const content = mockFiles.get(this.uri);
      if (content === undefined) throw new Error("missing");
      return Promise.resolve(content);
    }
    delete() {
      mockFiles.delete(this.uri);
    }
    copy(destination: MockFile) {
      const content = mockFiles.get(this.uri);
      if (content === undefined) return Promise.reject(new Error("missing"));
      mockFiles.set(destination.uri, content);
      return Promise.resolve();
    }
    move(destination: MockFile) {
      const content = mockFiles.get(this.uri);
      if (content === undefined) return Promise.reject(new Error("missing"));
      mockFiles.delete(this.uri);
      mockFiles.set(destination.uri, content);
      this.uri = destination.uri;
      return Promise.resolve();
    }
  }

  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: { cache: { uri: "file:///cache" } },
  };
});

const scope = {
  userId: "11111111-1111-1111-1111-111111111111",
  environmentUrl: "https://project-a.example.supabase.co",
};
const otherScope = {
  userId: "22222222-2222-2222-2222-222222222222",
  environmentUrl: scope.environmentUrl,
};
const otherEnvironment = {
  userId: scope.userId,
  environmentUrl: "https://project-b.example.supabase.co",
};

const photo: NormalizedPhoto = {
  uri: "file:///tmp/normalized.jpg",
  width: 1600,
  height: 2000,
  byteSize: 9,
  mimeType: "image/jpeg",
  source: "picker",
  evidence: {
    evidence: "picker_original_with_offset",
    capturedAt: "2026-07-31T16:30:00.000Z",
    capturedUtcOffsetMinutes: -420,
  },
};

const draft: MomentDraft = {
  draftId: "draft-1",
  photo,
  caption: "a quiet morning",
  audience: "selected_friends",
  audienceChosenByAuthor: true,
  recipientIds: ["friend-b", "friend-a", "friend-a"],
  tagIds: ["friend-a"],
  createdAt: "2026-07-31T16:31:00.000Z",
};

beforeEach(() => {
  mockFiles.clear();
  mockDirectories.clear();
  mockFiles.set(photo.uri, "jpegbytes");
});

function mediaUriFor(saved: MomentDraft) {
  return saved.photo.uri;
}

describe("saveMomentDraft", () => {
  test("moves the bytes into the scoped cache and points the draft at them", async () => {
    const saved = await saveMomentDraft(scope, draft);

    expect(saved.photo.uri).toMatch(/moment-draft\/media\.jpg$/);
    expect(mockFiles.get(saved.photo.uri)).toBe("jpegbytes");
    // The temporary `.part` name must not survive a completed save.
    expect([...mockFiles.keys()].some((key) => key.endsWith(".part"))).toBe(
      false,
    );
  });

  test("canonicalizes the recipient and tag arrays it writes", async () => {
    const saved = await saveMomentDraft(scope, draft);
    const restored = await readMomentDraft(scope);

    expect(saved.recipientIds).toEqual(draft.recipientIds);
    expect(restored?.recipientIds).toEqual(["friend-a", "friend-b"]);
  });

  test("a caption edit rewrites the manifest without recopying the photo", async () => {
    const saved = await saveMomentDraft(scope, draft);
    mockFiles.set(mediaUriFor(saved), "jpegbytes-original");

    await saveMomentDraft(scope, { ...saved, caption: "edited" });

    expect(mockFiles.get(mediaUriFor(saved))).toBe("jpegbytes-original");
    expect((await readMomentDraft(scope))?.caption).toBe("edited");
  });
});

describe("readMomentDraft", () => {
  test("round-trips every field the composer needs", async () => {
    const saved = await saveMomentDraft(scope, draft);
    const restored = await readMomentDraft(scope);

    expect(restored).toEqual({
      ...draft,
      recipientIds: ["friend-a", "friend-b"],
      photo: { ...photo, uri: saved.photo.uri },
    });
  });

  test("is a safe discard when the OS reclaimed the media file", async () => {
    const saved = await saveMomentDraft(scope, draft);
    mockFiles.delete(mediaUriFor(saved));

    expect(await readMomentDraft(scope)).toBeNull();
    // The orphaned manifest is removed too, so nothing half-described remains.
    expect([...mockFiles.keys()]).toHaveLength(1);
  });

  test("discards a manifest it cannot parse rather than partly trusting it", async () => {
    const saved = await saveMomentDraft(scope, draft);
    const manifestUri = mediaUriFor(saved).replace(
      "media.jpg",
      "manifest.json",
    );
    mockFiles.set(manifestUri, "{not json");

    expect(await readMomentDraft(scope)).toBeNull();
    expect(mockFiles.has(manifestUri)).toBe(false);
  });

  test("rejects a manifest whose evidence shape contradicts the table constraint", async () => {
    const saved = await saveMomentDraft(scope, draft);
    const manifestUri = mediaUriFor(saved).replace(
      "media.jpg",
      "manifest.json",
    );
    const parsed: Record<string, unknown> = JSON.parse(
      mockFiles.get(manifestUri) as string,
    );
    // Unknown evidence must carry both nulls; a capture time alongside it is
    // corrupt, not merely unusual.
    parsed.evidence = {
      evidence: "unknown",
      capturedAt: "2026-07-31T16:30:00.000Z",
      capturedUtcOffsetMinutes: -420,
    };
    mockFiles.set(manifestUri, JSON.stringify(parsed));

    expect(await readMomentDraft(scope)).toBeNull();
  });

  test("accepts a well-formed unknown-evidence draft", async () => {
    await saveMomentDraft(scope, {
      ...draft,
      photo: { ...photo, evidence: UNKNOWN_CAPTURE_EVIDENCE },
    });

    expect((await readMomentDraft(scope))?.photo.evidence).toEqual(
      UNKNOWN_CAPTURE_EVIDENCE,
    );
  });

  test("rejects an over-long caption or an oversized id array", async () => {
    const saved = await saveMomentDraft(scope, draft);
    const manifestUri = mediaUriFor(saved).replace(
      "media.jpg",
      "manifest.json",
    );
    const parsed: Record<string, unknown> = JSON.parse(
      mockFiles.get(manifestUri) as string,
    );

    mockFiles.set(
      manifestUri,
      JSON.stringify({ ...parsed, caption: "a".repeat(161) }),
    );
    expect(await readMomentDraft(scope)).toBeNull();

    await saveMomentDraft(scope, draft);
    mockFiles.set(
      manifestUri,
      JSON.stringify({
        ...parsed,
        tagIds: Array.from({ length: 21 }, (_, index) => `t${index}`),
      }),
    );
    expect(await readMomentDraft(scope)).toBeNull();
  });
});

describe("scoping", () => {
  test("another account on the same backend cannot see the draft", async () => {
    await saveMomentDraft(scope, draft);

    expect(await readMomentDraft(otherScope)).toBeNull();
    expect(await readMomentDraft(scope)).not.toBeNull();
  });

  test("the same account against another backend cannot see the draft", async () => {
    await saveMomentDraft(scope, draft);

    expect(await readMomentDraft(otherEnvironment)).toBeNull();
  });
});

describe("discardMomentDraft", () => {
  test("removes the manifest and the bytes together", async () => {
    const saved = await saveMomentDraft(scope, draft);
    discardMomentDraft(scope);

    expect(mockFiles.has(mediaUriFor(saved))).toBe(false);
    expect(await readMomentDraft(scope)).toBeNull();
  });
});
