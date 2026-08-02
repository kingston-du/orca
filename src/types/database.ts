export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      blocks: {
        Row: {
          blocked_id: string
          blocker_id: string
          created_at: string
          generation_id: string
        }
        Insert: {
          blocked_id: string
          blocker_id: string
          created_at?: string
          generation_id: string
        }
        Update: {
          blocked_id?: string
          blocker_id?: string
          created_at?: string
          generation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "blocks_blocked_id_fkey"
            columns: ["blocked_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blocks_blocker_id_fkey"
            columns: ["blocker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      friendships: {
        Row: {
          accepted_at: string | null
          expires_at: string | null
          generation_id: string | null
          request_id: string | null
          requested_at: string | null
          requester_id: string | null
          state: string
          user_high: string
          user_low: string
        }
        Insert: {
          accepted_at?: string | null
          expires_at?: string | null
          generation_id?: string | null
          request_id?: string | null
          requested_at?: string | null
          requester_id?: string | null
          state: string
          user_high: string
          user_low: string
        }
        Update: {
          accepted_at?: string | null
          expires_at?: string | null
          generation_id?: string | null
          request_id?: string | null
          requested_at?: string | null
          requester_id?: string | null
          state?: string
          user_high?: string
          user_low?: string
        }
        Relationships: [
          {
            foreignKeyName: "friendships_user_high_fkey"
            columns: ["user_high"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friendships_user_low_fkey"
            columns: ["user_low"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_acceptances: {
        Row: {
          accepted_at: string
          content_sha256: string
          document_kind: string
          document_version: string
          user_id: string
        }
        Insert: {
          accepted_at: string
          content_sha256: string
          document_kind: string
          document_version: string
          user_id: string
        }
        Update: {
          accepted_at?: string
          content_sha256?: string
          document_kind?: string
          document_version?: string
          user_id?: string
        }
        Relationships: []
      }
      moment_reactions: {
        Row: {
          author_id: string
          moment_id: string
          reacted_at: string
          reaction: string
          user_id: string
        }
        Insert: {
          author_id: string
          moment_id: string
          reacted_at?: string
          reaction: string
          user_id: string
        }
        Update: {
          author_id?: string
          moment_id?: string
          reacted_at?: string
          reaction?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "moment_reactions_moment_id_author_id_fkey"
            columns: ["moment_id", "author_id"]
            isOneToOne: false
            referencedRelation: "moments"
            referencedColumns: ["id", "author_id"]
          },
          {
            foreignKeyName: "moment_reactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      moment_recipients: {
        Row: {
          author_id: string
          created_at: string
          friendship_generation_id: string
          moment_id: string
          recipient_id: string
          source: string
        }
        Insert: {
          author_id: string
          created_at?: string
          friendship_generation_id: string
          moment_id: string
          recipient_id: string
          source: string
        }
        Update: {
          author_id?: string
          created_at?: string
          friendship_generation_id?: string
          moment_id?: string
          recipient_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "moment_recipients_moment_id_author_id_fkey"
            columns: ["moment_id", "author_id"]
            isOneToOne: false
            referencedRelation: "moments"
            referencedColumns: ["id", "author_id"]
          },
          {
            foreignKeyName: "moment_recipients_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      moment_seen: {
        Row: {
          first_seen_at: string
          moment_id: string
          viewer_id: string
        }
        Insert: {
          first_seen_at?: string
          moment_id: string
          viewer_id: string
        }
        Update: {
          first_seen_at?: string
          moment_id?: string
          viewer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "moment_seen_moment_id_fkey"
            columns: ["moment_id"]
            isOneToOne: false
            referencedRelation: "moments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "moment_seen_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      moment_tags: {
        Row: {
          author_id: string
          created_at: string
          friendship_generation_id: string
          moment_id: string
          tagged_user_id: string
        }
        Insert: {
          author_id: string
          created_at?: string
          friendship_generation_id: string
          moment_id: string
          tagged_user_id: string
        }
        Update: {
          author_id?: string
          created_at?: string
          friendship_generation_id?: string
          moment_id?: string
          tagged_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "moment_tags_moment_id_author_id_fkey"
            columns: ["moment_id", "author_id"]
            isOneToOne: false
            referencedRelation: "moments"
            referencedColumns: ["id", "author_id"]
          },
          {
            foreignKeyName: "moment_tags_tagged_user_id_fkey"
            columns: ["tagged_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      moments: {
        Row: {
          audience: string | null
          author_id: string
          byte_size: number | null
          caption: string | null
          caption_updated_at: string | null
          capture_evidence: string
          captured_at: string | null
          captured_utc_offset_minutes: number | null
          content_sha256: string | null
          deleting_at: string | null
          expires_at: string | null
          height: number | null
          id: string
          kind: string | null
          mime_type: string | null
          object_path: string
          published_at: string | null
          reserved_at: string
          source: string
          status: string
          width: number | null
        }
        Insert: {
          audience?: string | null
          author_id: string
          byte_size?: number | null
          caption?: string | null
          caption_updated_at?: string | null
          capture_evidence: string
          captured_at?: string | null
          captured_utc_offset_minutes?: number | null
          content_sha256?: string | null
          deleting_at?: string | null
          expires_at?: string | null
          height?: number | null
          id: string
          kind?: string | null
          mime_type?: string | null
          object_path: string
          published_at?: string | null
          reserved_at?: string
          source: string
          status?: string
          width?: number | null
        }
        Update: {
          audience?: string | null
          author_id?: string
          byte_size?: number | null
          caption?: string | null
          caption_updated_at?: string | null
          capture_evidence?: string
          captured_at?: string | null
          captured_utc_offset_minutes?: number | null
          content_sha256?: string | null
          deleting_at?: string | null
          expires_at?: string | null
          height?: number | null
          id?: string
          kind?: string | null
          mime_type?: string | null
          object_path?: string
          published_at?: string | null
          reserved_at?: string
          source?: string
          status?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "moments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_path: string | null
          created_at: string
          display_name: string
          id: string
          onboarding_completed_at: string
          updated_at: string
          username: string
        }
        Insert: {
          avatar_path?: string | null
          created_at?: string
          display_name: string
          id: string
          onboarding_completed_at: string
          updated_at?: string
          username: string
        }
        Update: {
          avatar_path?: string | null
          created_at?: string
          display_name?: string
          id?: string
          onboarding_completed_at?: string
          updated_at?: string
          username?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_friend_request: {
        Args: { p_command_id: string; p_other_id: string; p_request_id: string }
        Returns: {
          generation_id: string
          request_id: string
          result_state: string
        }[]
      }
      begin_avatar_verification: {
        Args: { p_request_id: string; p_user_id: string }
        Returns: {
          client_byte_size: number
          client_sha256: string
          object_path: string
          request_id: string
          status: string
          user_id: string
        }[]
      }
      begin_moment_verification: {
        Args: { p_author_id: string; p_moment_id: string }
        Returns: {
          author_id: string
          client_byte_size: number
          client_sha256: string
          moment_id: string
          object_path: string
          status: string
        }[]
      }
      block_user: {
        Args: { p_command_id: string; p_other_id: string }
        Returns: {
          generation_id: string
          request_id: string
          result_state: string
        }[]
      }
      can_read_avatar: { Args: { p_object_path: string }; Returns: boolean }
      can_read_moment_media: {
        Args: { p_object_path: string }
        Returns: boolean
      }
      can_upload_reserved_avatar: {
        Args: { p_object_path: string }
        Returns: boolean
      }
      can_upload_reserved_moment: {
        Args: { p_object_path: string }
        Returns: boolean
      }
      can_view_friendship: {
        Args: { p_user_high: string; p_user_low: string }
        Returns: boolean
      }
      can_view_moment: { Args: { p_moment_id: string }; Returns: boolean }
      can_view_moment_reaction: {
        Args: { p_moment_id: string; p_user_id: string }
        Returns: boolean
      }
      can_view_moment_tag: {
        Args: { p_moment_id: string; p_tagged_user_id: string }
        Returns: boolean
      }
      can_view_profile: { Args: { p_profile_id: string }; Returns: boolean }
      cancel_avatar_upload: { Args: { p_request_id: string }; Returns: string }
      cancel_friend_request: {
        Args: { p_command_id: string; p_other_id: string; p_request_id: string }
        Returns: {
          generation_id: string
          request_id: string
          result_state: string
        }[]
      }
      cancel_moment_upload: { Args: { p_moment_id: string }; Returns: string }
      claim_media_cleanup_batch: {
        Args: { p_lease_seconds?: number; p_limit?: number }
        Returns: {
          attempt_count: number
          bucket_id: string
          job_id: string
          lease_token: string
          object_path: string
        }[]
      }
      complete_media_cleanup: {
        Args: { p_job_id: string; p_lease_token: string }
        Returns: boolean
      }
      complete_onboarding: {
        Args: {
          p_adult_eligible: boolean
          p_adult_sha256: string
          p_adult_version: string
          p_display_name: string
          p_guidelines_sha256: string
          p_guidelines_version: string
          p_privacy_sha256: string
          p_privacy_version: string
          p_terms_sha256: string
          p_terms_version: string
          p_username: string
        }
        Returns: {
          avatar_path: string | null
          created_at: string
          display_name: string
          id: string
          onboarding_completed_at: string
          updated_at: string
          username: string
        }
        SetofOptions: {
          from: "*"
          to: "profiles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      count_new_recent_moments: {
        Args: { p_anchor_at?: string }
        Returns: number
      }
      create_invite_link: {
        Args: { p_token_sha256: string }
        Returns: {
          expires_at: string
          fingerprint: string
        }[]
      }
      delete_moment: {
        Args: { p_command_id: string; p_moment_id: string }
        Returns: {
          moment_id: string
          status: string
        }[]
      }
      edit_moment_caption: {
        Args: {
          p_caption: string
          p_expected_caption_updated_at: string
          p_moment_id: string
        }
        Returns: {
          caption: string
          caption_updated_at: string
        }[]
      }
      fail_media_cleanup: {
        Args: { p_error_code: string; p_job_id: string; p_lease_token: string }
        Returns: string
      }
      finalize_avatar_upload: {
        Args: {
          p_byte_size: number
          p_content_sha256: string
          p_height: number
          p_object_path: string
          p_object_version: string
          p_request_id: string
          p_user_id: string
          p_verifier_version: string
          p_width: number
        }
        Returns: {
          avatar_path: string
          status: string
        }[]
      }
      finalize_moment_upload: {
        Args: {
          p_author_id: string
          p_byte_size: number
          p_content_sha256: string
          p_height: number
          p_moment_id: string
          p_object_path: string
          p_object_version: string
          p_verifier_version: string
          p_width: number
        }
        Returns: {
          audience: string
          kind: string
          published_at: string
          recipient_count: number
          review_reason: string
          status: string
          tag_count: number
        }[]
      }
      get_account_control_state: {
        Args: never
        Returns: {
          account_state: string
          avatar_path: string
          display_name: string
          email_verified: boolean
          has_current_legal: boolean
          is_eligible: boolean
          onboarding_completed_at: string
          profile_id: string
          username: string
        }[]
      }
      get_avatar_upload_status: {
        Args: { p_request_id: string }
        Returns: {
          avatar_path: string
          error_code: string
          expires_at: string
          object_path: string
          request_id: string
          status: string
        }[]
      }
      get_invite_status: {
        Args: never
        Returns: {
          expires_at: string
          fingerprint: string
        }[]
      }
      get_media_operations_metrics: {
        Args: never
        Returns: {
          active_moment_reservations: number
          active_reservations: number
          dead_jobs: number
          deleting_moments: number
          leased_jobs: number
          oldest_deleting_moment_age_seconds: number
          oldest_moment_reservation_age_seconds: number
          oldest_ready_age_seconds: number
          oldest_reservation_age_seconds: number
          ready_jobs: number
          retry_jobs: number
        }[]
      }
      get_moment_deletion_status: {
        Args: { p_moment_id: string }
        Returns: {
          completed_at: string
          error_code: string
          moment_id: string
          status: string
        }[]
      }
      get_moment_detail: {
        Args: { p_moment_id: string }
        Returns: {
          audience: string
          author_avatar_path: string
          author_display_name: string
          author_id: string
          author_username: string
          can_react: boolean
          caption: string
          caption_updated_at: string
          capture_evidence: string
          captured_at: string
          captured_utc_offset_minutes: number
          heart_count: number
          kind: string
          media_height: number
          media_width: number
          moment_id: string
          object_path: string
          participant_count: number
          published_at: string
          recipient_count: number
          superheart_count: number
          viewer_is_author: boolean
          viewer_is_tagged: boolean
          viewer_reaction: string
        }[]
      }
      get_moment_upload_status: {
        Args: { p_moment_id: string }
        Returns: {
          error_code: string
          expires_at: string
          kind: string
          moment_id: string
          object_path: string
          published_at: string
          status: string
        }[]
      }
      get_profile_summary: {
        Args: { p_profile_id: string }
        Returns: {
          access_tier: string
          avatar_path: string
          display_name: string
          id: string
          mutual_friend_count: number
          relationship_state: string
          username: string
        }[]
      }
      get_reaction_quota: {
        Args: never
        Returns: {
          resets_at: string
          uses_remaining: number
        }[]
      }
      is_account_active: { Args: never; Returns: boolean }
      is_app_eligible: { Args: never; Returns: boolean }
      list_blocked_profiles: {
        Args: {
          p_after_blocked_id?: string
          p_after_created_at?: string
          p_limit?: number
        }
        Returns: {
          created_at: string
          display_name: string
          generation_id: string
          id: string
          username: string
        }[]
      }
      list_diary_moments: {
        Args: {
          p_cursor_captured_at?: string
          p_cursor_id?: string
          p_cursor_published_at?: string
          p_limit?: number
        }
        Returns: {
          author_avatar_path: string
          author_display_name: string
          author_id: string
          author_username: string
          caption: string
          capture_evidence: string
          captured_at: string
          captured_utc_offset_minutes: number
          kind: string
          media_height: number
          media_width: number
          moment_id: string
          object_path: string
          published_at: string
          viewer_is_author: boolean
        }[]
      }
      list_friend_friends: {
        Args: {
          p_after_id?: string
          p_after_username?: string
          p_friend_id: string
          p_limit?: number
        }
        Returns: {
          avatar_path: string
          display_name: string
          id: string
          mutual_friend_count: number
          relationship_state: string
          username: string
        }[]
      }
      list_friend_requests: {
        Args: {
          p_before_request_id?: string
          p_before_requested_at?: string
          p_limit?: number
        }
        Returns: {
          direction: string
          display_name: string
          id: string
          request_id: string
          requested_at: string
          username: string
        }[]
      }
      list_friends: {
        Args: {
          p_after_id?: string
          p_after_username?: string
          p_limit?: number
        }
        Returns: {
          avatar_path: string
          display_name: string
          generation_id: string
          id: string
          username: string
        }[]
      }
      list_highlight_moments: {
        Args: { p_limit?: number }
        Returns: {
          author_avatar_path: string
          author_display_name: string
          author_id: string
          author_username: string
          caption: string
          caption_updated_at: string
          capture_evidence: string
          captured_at: string
          captured_utc_offset_minutes: number
          heart_count: number
          is_warming_up: boolean
          media_height: number
          media_width: number
          moment_id: string
          object_path: string
          published_at: string
          superheart_count: number
          viewer_reaction: string
        }[]
      }
      list_moment_participants: {
        Args: { p_moment_id: string }
        Returns: {
          avatar_path: string
          display_name: string
          user_id: string
          username: string
        }[]
      }
      list_moment_reactions: {
        Args: {
          p_cursor_reacted_at?: string
          p_cursor_user_id?: string
          p_limit?: number
          p_moment_id: string
        }
        Returns: {
          avatar_path: string
          display_name: string
          reacted_at: string
          reaction: string
          user_id: string
          username: string
        }[]
      }
      list_past_shares: {
        Args: {
          p_cursor_captured_at?: string
          p_cursor_id?: string
          p_cursor_published_at?: string
          p_limit?: number
        }
        Returns: {
          author_avatar_path: string
          author_display_name: string
          author_id: string
          author_username: string
          caption: string
          capture_evidence: string
          captured_at: string
          captured_utc_offset_minutes: number
          kind: string
          media_height: number
          media_width: number
          moment_id: string
          object_path: string
          published_at: string
          viewer_is_author: boolean
        }[]
      }
      list_recent_moments: {
        Args: {
          p_anchor_at?: string
          p_cursor_id?: string
          p_cursor_published_at?: string
          p_cursor_seen?: boolean
          p_direction?: string
          p_limit?: number
          p_session_started_at?: string
        }
        Returns: {
          anchor_at: string
          author_avatar_path: string
          author_display_name: string
          author_id: string
          author_username: string
          caption: string
          caption_updated_at: string
          capture_evidence: string
          captured_at: string
          captured_utc_offset_minutes: number
          heart_count: number
          media_height: number
          media_width: number
          moment_id: string
          object_path: string
          published_at: string
          seen_at_session_start: boolean
          session_started_at: string
          superheart_count: number
          viewer_is_author: boolean
          viewer_reaction: string
        }[]
      }
      list_shared_moments: {
        Args: {
          p_cursor_captured_at?: string
          p_cursor_id?: string
          p_cursor_published_at?: string
          p_friend_id: string
          p_limit?: number
        }
        Returns: {
          author_avatar_path: string
          author_display_name: string
          author_id: string
          author_username: string
          caption: string
          capture_evidence: string
          captured_at: string
          captured_utc_offset_minutes: number
          kind: string
          media_height: number
          media_width: number
          moment_id: string
          object_path: string
          published_at: string
          viewer_is_author: boolean
        }[]
      }
      lookup_profile_exact: {
        Args: { p_username: string }
        Returns: {
          display_name: string
          generation_id: string
          id: string
          relationship_state: string
          request_id: string
          requester_id: string
          username: string
        }[]
      }
      mark_moments_seen: { Args: { p_moment_ids: string[] }; Returns: number }
      reject_avatar_upload: {
        Args: { p_error_code: string; p_request_id: string; p_user_id: string }
        Returns: string
      }
      reject_friend_request: {
        Args: { p_command_id: string; p_other_id: string; p_request_id: string }
        Returns: {
          generation_id: string
          request_id: string
          result_state: string
        }[]
      }
      reject_moment_upload: {
        Args: { p_author_id: string; p_error_code: string; p_moment_id: string }
        Returns: string
      }
      remove_avatar: { Args: never; Returns: undefined }
      remove_moment_tag: {
        Args: { p_moment_id: string }
        Returns: {
          moment_id: string
          still_visible: boolean
        }[]
      }
      reserve_avatar_upload: {
        Args: { p_client_byte_size: number; p_client_sha256: string }
        Returns: {
          expires_at: string
          object_path: string
          request_id: string
          status: string
        }[]
      }
      reserve_moment_upload: {
        Args: {
          p_audience: string
          p_caption: string
          p_capture_evidence: string
          p_captured_at: string
          p_captured_utc_offset_minutes: number
          p_client_byte_size: number
          p_client_sha256: string
          p_intended_kind: string
          p_moment_id: string
          p_recipient_ids: string[]
          p_source: string
          p_tag_ids: string[]
        }
        Returns: {
          expires_at: string
          moment_id: string
          object_path: string
          status: string
        }[]
      }
      resolve_invite: {
        Args: { p_token_sha256: string }
        Returns: {
          display_name: string
          id: string
          mutual_friend_count: number
          relationship_state: string
          username: string
        }[]
      }
      revoke_invite_link: { Args: never; Returns: undefined }
      rotate_invite_link: {
        Args: { p_token_sha256: string }
        Returns: {
          expires_at: string
          fingerprint: string
        }[]
      }
      run_media_maintenance: {
        Args: { p_limit?: number }
        Returns: {
          expired_moment_reservations: number
          expired_reservations: number
          pruned_deletion_receipts: number
          pruned_friend_requests: number
          pruned_jobs: number
          pruned_moment_requests: number
          pruned_rate_buckets: number
          pruned_reaction_commands: number
          pruned_requests: number
          pruned_verifications: number
        }[]
      }
      send_friend_request: {
        Args: { p_command_id: string; p_other_id: string }
        Returns: {
          generation_id: string
          request_id: string
          result_state: string
        }[]
      }
      set_moment_reaction: {
        Args: { p_command_id: string; p_moment_id: string; p_reaction?: string }
        Returns: {
          heart_count: number
          previous_reaction: string
          reaction: string
          superheart_consumed: boolean
          superheart_count: number
          uses_remaining: number
        }[]
      }
      unblock_user: {
        Args: {
          p_block_generation_id: string
          p_command_id: string
          p_other_id: string
        }
        Returns: {
          generation_id: string
          request_id: string
          result_state: string
        }[]
      }
      unfriend: {
        Args: {
          p_command_id: string
          p_generation_id: string
          p_other_id: string
        }
        Returns: {
          generation_id: string
          request_id: string
          result_state: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

