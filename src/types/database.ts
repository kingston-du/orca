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
      block_user: {
        Args: { p_command_id: string; p_other_id: string }
        Returns: {
          generation_id: string
          request_id: string
          result_state: string
        }[]
      }
      can_view_friendship: {
        Args: { p_user_high: string; p_user_low: string }
        Returns: boolean
      }
      can_view_profile: { Args: { p_profile_id: string }; Returns: boolean }
      cancel_friend_request: {
        Args: { p_command_id: string; p_other_id: string; p_request_id: string }
        Returns: {
          generation_id: string
          request_id: string
          result_state: string
        }[]
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
      get_account_control_state: {
        Args: never
        Returns: {
          account_state: string
          display_name: string
          email_verified: boolean
          has_current_legal: boolean
          is_eligible: boolean
          onboarding_completed_at: string
          profile_id: string
          username: string
        }[]
      }
      get_profile_summary: {
        Args: { p_profile_id: string }
        Returns: {
          access_tier: string
          display_name: string
          id: string
          mutual_friend_count: number
          relationship_state: string
          username: string
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
      list_friend_friends: {
        Args: {
          p_after_id?: string
          p_after_username?: string
          p_friend_id: string
          p_limit?: number
        }
        Returns: {
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
          display_name: string
          generation_id: string
          id: string
          username: string
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
      reject_friend_request: {
        Args: { p_command_id: string; p_other_id: string; p_request_id: string }
        Returns: {
          generation_id: string
          request_id: string
          result_state: string
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

