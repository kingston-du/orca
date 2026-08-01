import { File } from "expo-file-system";

import {
  MAX_CAPTION_CHARACTERS,
  MAX_MOMENT_TAGS,
  MAX_SELECTED_RECIPIENTS,
} from "@/constants/moments";
import {
  UNKNOWN_CAPTURE_EVIDENCE,
  type CaptureEvidence,
} from "@/features/moments/capture/capture-evidence";
import type { MomentPhotoSource } from "@/features/moments/capture/photo-normalizer";
import {
  canonicalIds,
  type ComposerAudience,
  type MomentDraft,
} from "@/features/moments/composer/moment-draft";
import {
  userScopedCacheDirectory,
  type UserScope,
} from "@/lib/user-scoped-file-cache";

/**
 * Persistence for the one recoverable draft.
 *
 * What is written: a normalized JPEG and a small manifest of nonsecret
 * identity/shape metadata. What is deliberately never written: image bytes or
 * base64 in AsyncStorage or the query cache, a bearer token, a signed URL, or
 * the caption anywhere but this app-private cache file.
 *
 * Write order matters. The media file is copied to a `.part` name and only then
 * renamed into place, and the manifest is written *last* — so a manifest on
 * disk always implies a complete media file, and a crash mid-save leaves either
 * the previous draft or nothing, never a half-described one.
 */

const FEATURE_DIRECTORY = "moment-draft";
const MEDIA_FILE_NAME = "media.jpg";
const PARTIAL_MEDIA_FILE_NAME = "media.jpg.part";
const MANIFEST_FILE_NAME = "manifest.json";

/** Bumped when the shape changes; an unrecognized version is discarded rather
 * than migrated, because a pre-reservation draft is always safe to drop. */
const MANIFEST_VERSION = 1;

type DraftManifest = {
  version: number;
  draftId: string;
  createdAt: string;
  source: MomentPhotoSource;
  evidence: CaptureEvidence;
  width: number;
  height: number;
  byteSize: number;
  caption: string;
  audience: ComposerAudience;
  audienceChosenByAuthor: boolean;
  recipientIds: string[];
  tagIds: string[];
};

function draftFiles(scope: UserScope) {
  const directory = userScopedCacheDirectory(scope, FEATURE_DIRECTORY);
  return {
    directory,
    media: new File(directory, MEDIA_FILE_NAME),
    partialMedia: new File(directory, PARTIAL_MEDIA_FILE_NAME),
    manifest: new File(directory, MANIFEST_FILE_NAME),
  };
}

export async function saveMomentDraft(
  scope: UserScope,
  draft: MomentDraft,
): Promise<MomentDraft> {
  const { media, partialMedia, manifest } = draftFiles(scope);

  // A caption or audience edit does not move bytes; only a new photo does.
  if (draft.photo.uri !== media.uri) {
    if (partialMedia.exists) partialMedia.delete();
    await new File(draft.photo.uri).copy(partialMedia);
    await partialMedia.move(media, { overwrite: true });
  }

  const payload: DraftManifest = {
    version: MANIFEST_VERSION,
    draftId: draft.draftId,
    createdAt: draft.createdAt,
    source: draft.photo.source,
    evidence: draft.photo.evidence,
    width: draft.photo.width,
    height: draft.photo.height,
    byteSize: draft.photo.byteSize,
    caption: draft.caption,
    audience: draft.audience,
    audienceChosenByAuthor: draft.audienceChosenByAuthor,
    recipientIds: canonicalIds(draft.recipientIds),
    tagIds: canonicalIds(draft.tagIds),
  };

  manifest.create({ intermediates: true, overwrite: true });
  manifest.write(JSON.stringify(payload));

  return { ...draft, photo: { ...draft.photo, uri: media.uri } };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readIdArray(value: unknown, maximum: number): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > maximum) return null;
  if (!value.every(isNonEmptyString)) return null;
  return canonicalIds(value);
}

function readEvidence(value: unknown): CaptureEvidence | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;

  if (candidate.evidence === "unknown") {
    // The table constraint is that unknown carries *both* nulls; a manifest
    // that disagrees is corrupt, not merely unusual.
    return candidate.capturedAt === null &&
      candidate.capturedUtcOffsetMinutes === null
      ? UNKNOWN_CAPTURE_EVIDENCE
      : null;
  }

  if (
    (candidate.evidence !== "camera_clock" &&
      candidate.evidence !== "picker_original_with_offset") ||
    !isNonEmptyString(candidate.capturedAt) ||
    Number.isNaN(Date.parse(candidate.capturedAt)) ||
    !Number.isInteger(candidate.capturedUtcOffsetMinutes)
  ) {
    return null;
  }

  return {
    evidence: candidate.evidence,
    capturedAt: candidate.capturedAt,
    capturedUtcOffsetMinutes: candidate.capturedUtcOffsetMinutes as number,
  };
}

/**
 * Rebuilds a draft from an untrusted file. The manifest is app-private, but it
 * survives OS eviction, app updates, and interrupted writes, so every field is
 * validated the same way a network payload would be. Anything unparseable is a
 * discard, never a partially populated draft.
 */
function parseManifest(raw: string, mediaUri: string): MomentDraft | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (candidate.version !== MANIFEST_VERSION) return null;
  if (!isNonEmptyString(candidate.draftId)) return null;
  if (!isNonEmptyString(candidate.createdAt)) return null;
  if (candidate.source !== "camera" && candidate.source !== "picker") {
    return null;
  }
  if (
    candidate.audience !== "all_friends" &&
    candidate.audience !== "selected_friends" &&
    candidate.audience !== "only_me"
  ) {
    return null;
  }
  if (typeof candidate.audienceChosenByAuthor !== "boolean") return null;
  if (
    typeof candidate.caption !== "string" ||
    [...candidate.caption].length > MAX_CAPTION_CHARACTERS
  ) {
    return null;
  }
  if (
    !Number.isInteger(candidate.width) ||
    !Number.isInteger(candidate.height) ||
    !Number.isInteger(candidate.byteSize)
  ) {
    return null;
  }

  const evidence = readEvidence(candidate.evidence);
  const recipientIds = readIdArray(
    candidate.recipientIds,
    MAX_SELECTED_RECIPIENTS,
  );
  const tagIds = readIdArray(candidate.tagIds, MAX_MOMENT_TAGS);
  if (evidence === null || recipientIds === null || tagIds === null) {
    return null;
  }

  return {
    draftId: candidate.draftId,
    createdAt: candidate.createdAt,
    caption: candidate.caption,
    audience: candidate.audience,
    audienceChosenByAuthor: candidate.audienceChosenByAuthor,
    recipientIds,
    tagIds,
    photo: {
      uri: mediaUri,
      width: candidate.width as number,
      height: candidate.height as number,
      byteSize: candidate.byteSize as number,
      mimeType: "image/jpeg",
      source: candidate.source,
      evidence,
    },
  };
}

/**
 * Restart recovery. Phase 3 drafts are all pre-reservation, so a missing or
 * unreadable file is an unambiguously safe discard — nothing exists on the
 * server to reconcile against. Once Phase 4 records a server stage in this
 * manifest, absent local bytes will stop implying "nothing happened" and the
 * caller will have to reconcile publication status first.
 */
export async function readMomentDraft(
  scope: UserScope,
): Promise<MomentDraft | null> {
  const { media, manifest } = draftFiles(scope);

  if (!manifest.exists) {
    discardMomentDraft(scope);
    return null;
  }

  if (!media.exists || media.size <= 0) {
    discardMomentDraft(scope);
    return null;
  }

  let raw: string;
  try {
    raw = await manifest.text();
  } catch {
    discardMomentDraft(scope);
    return null;
  }

  const draft = parseManifest(raw, media.uri);
  if (draft === null) {
    discardMomentDraft(scope);
    return null;
  }

  return draft;
}

export function discardMomentDraft(scope: UserScope): void {
  const { directory } = draftFiles(scope);
  if (directory.exists) {
    directory.delete();
  }
}
