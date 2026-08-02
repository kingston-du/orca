import { supabase } from "@/lib/supabase";
import type { ReactionType } from "@/features/moments/reactions/reaction-rules";
import type { Database } from "@/types/database";

type GeneratedDetail =
  Database["public"]["Functions"]["get_moment_detail"]["Returns"][number];
type GeneratedParticipant =
  Database["public"]["Functions"]["list_moment_participants"]["Returns"][number];

/**
 * One authorized Moment.
 *
 * `audience` and `recipient_count` are the author's own record of what they
 * chose and are null for everyone else, so they are typed nullable here rather
 * than being trusted from the generator. The avatar is null for a viewer who
 * holds only a preserved historical grant.
 */
export type MomentDetail = Omit<
  GeneratedDetail,
  | "audience"
  | "author_avatar_path"
  | "caption"
  | "captured_at"
  | "captured_utc_offset_minutes"
  | "recipient_count"
  | "viewer_reaction"
> & {
  audience: string | null;
  author_avatar_path: string | null;
  caption: string | null;
  captured_at: string | null;
  captured_utc_offset_minutes: number | null;
  recipient_count: number | null;
  viewer_reaction: ReactionType | null;
};

export type MomentParticipant = Omit<GeneratedParticipant, "avatar_path"> & {
  avatar_path: string | null;
};

/**
 * Returns null for a Moment that is deleted, blocked, never existed, or was
 * never the caller's to read. One answer for every reason, on purpose: the
 * difference between them is exactly what a viewer must not be able to infer.
 */
export async function getMomentDetail(
  momentId: string,
): Promise<MomentDetail | null> {
  const { data, error } = await supabase.rpc("get_moment_detail", {
    p_moment_id: momentId,
  });
  if (error) throw error;
  return (data[0] as MomentDetail | undefined) ?? null;
}

export async function listMomentParticipants(
  momentId: string,
): Promise<MomentParticipant[]> {
  const { data, error } = await supabase.rpc("list_moment_participants", {
    p_moment_id: momentId,
  });
  if (error) throw error;
  return data as MomentParticipant[];
}

/**
 * A tagged user removes their own participation. The server reports whether the
 * Moment is still readable afterwards — on a Recent Moment an independent
 * recipient grant usually survives, while on an Archive Moment the tag was the
 * only grant there was and the row goes with it.
 */
export async function removeMomentTag(
  momentId: string,
): Promise<{ stillVisible: boolean }> {
  const { data, error } = await supabase.rpc("remove_moment_tag", {
    p_moment_id: momentId,
  });
  if (error) throw error;
  return { stillVisible: data[0]?.still_visible ?? false };
}
