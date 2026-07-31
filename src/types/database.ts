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
      circle_invites: {
        Row: {
          circle_id: string
          created_at: string
          created_by: string | null
          expires_at: string
          id: string
          max_uses: number
          revoked_at: string | null
          token_hash: string
          use_count: number
        }
        Insert: {
          circle_id: string
          created_at?: string
          created_by?: string | null
          expires_at: string
          id?: string
          max_uses?: number
          revoked_at?: string | null
          token_hash: string
          use_count?: number
        }
        Update: {
          circle_id?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          max_uses?: number
          revoked_at?: string | null
          token_hash?: string
          use_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "circle_invites_circle_id_fkey"
            columns: ["circle_id"]
            isOneToOne: false
            referencedRelation: "circles"
            referencedColumns: ["id"]
          },
        ]
      }
      circle_members: {
        Row: {
          circle_id: string
          joined_at: string
          role: string
          user_id: string
        }
        Insert: {
          circle_id: string
          joined_at?: string
          role?: string
          user_id: string
        }
        Update: {
          circle_id?: string
          joined_at?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "circle_members_circle_id_fkey"
            columns: ["circle_id"]
            isOneToOne: false
            referencedRelation: "circles"
            referencedColumns: ["id"]
          },
        ]
      }
      circles: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          state: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          state?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          state?: string
          updated_at?: string
        }
        Relationships: []
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
      posts: {
        Row: {
          author_id: string
          caption: string | null
          captured_at: string
          captured_at_source: string
          captured_utc_offset_minutes: number
          circle_id: string
          created_at: string | null
          id: string
          media_byte_size: number | null
          media_height: number | null
          media_mime_type: string | null
          media_path: string
          media_width: number | null
          status: string
          upload_expires_at: string
          upload_started_at: string
        }
        Insert: {
          author_id: string
          caption?: string | null
          captured_at: string
          captured_at_source: string
          captured_utc_offset_minutes: number
          circle_id: string
          created_at?: string | null
          id: string
          media_byte_size?: number | null
          media_height?: number | null
          media_mime_type?: string | null
          media_path: string
          media_width?: number | null
          status?: string
          upload_expires_at?: string
          upload_started_at?: string
        }
        Update: {
          author_id?: string
          caption?: string | null
          captured_at?: string
          captured_at_source?: string
          captured_utc_offset_minutes?: number
          circle_id?: string
          created_at?: string | null
          id?: string
          media_byte_size?: number | null
          media_height?: number | null
          media_mime_type?: string | null
          media_path?: string
          media_width?: number | null
          status?: string
          upload_expires_at?: string
          upload_started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "posts_circle_id_fkey"
            columns: ["circle_id"]
            isOneToOne: false
            referencedRelation: "circles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_path: string | null
          created_at: string
          display_name: string | null
          id: string
          onboarding_completed_at: string | null
          updated_at: string
        }
        Insert: {
          avatar_path?: string | null
          created_at?: string
          display_name?: string | null
          id: string
          onboarding_completed_at?: string | null
          updated_at?: string
        }
        Update: {
          avatar_path?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          onboarding_completed_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
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
        }
        Returns: {
          avatar_path: string | null
          created_at: string
          display_name: string | null
          id: string
          onboarding_completed_at: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "profiles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_circle: {
        Args: { p_name: string }
        Returns: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          state: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "circles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_circle_invite: {
        Args: { p_circle_id: string; p_expires_at: string; p_max_uses: number }
        Returns: {
          circle_id: string
          expires_at: string
          id: string
          max_uses: number
          token: string
        }[]
      }
      finalize_post: {
        Args: { p_post_id: string }
        Returns: {
          author_id: string
          caption: string | null
          captured_at: string
          captured_at_source: string
          captured_utc_offset_minutes: number
          circle_id: string
          created_at: string | null
          id: string
          media_byte_size: number | null
          media_height: number | null
          media_mime_type: string | null
          media_path: string
          media_width: number | null
          status: string
          upload_expires_at: string
          upload_started_at: string
        }
        SetofOptions: {
          from: "*"
          to: "posts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      leave_circle: { Args: { p_circle_id: string }; Returns: undefined }
      list_circle_members: {
        Args: { p_circle_id: string }
        Returns: {
          display_name: string
          role: string
          user_id: string
        }[]
      }
      preview_circle_invite: {
        Args: { p_token: string }
        Returns: {
          circle_id: string
          circle_name: string
          expires_at: string
          is_usable: boolean
        }[]
      }
      record_post_media_verification: {
        Args: {
          p_author_id: string
          p_media_byte_size: number
          p_media_height: number
          p_media_mime_type: string
          p_media_path: string
          p_media_width: number
          p_post_id: string
        }
        Returns: undefined
      }
      redeem_circle_invite: {
        Args: { p_token: string }
        Returns: {
          circle_id: string
          joined: boolean
        }[]
      }
      remove_circle_member: {
        Args: { p_circle_id: string; p_user_id: string }
        Returns: undefined
      }
      request_circle_deletion: {
        Args: { p_circle_id: string }
        Returns: {
          circle_id: string
          completed: boolean
        }[]
      }
      reserve_post: {
        Args: {
          p_caption?: string
          p_captured_at: string
          p_captured_at_source: string
          p_captured_utc_offset_minutes: number
          p_circle_id: string
          p_post_id: string
        }
        Returns: {
          author_id: string
          caption: string | null
          captured_at: string
          captured_at_source: string
          captured_utc_offset_minutes: number
          circle_id: string
          created_at: string | null
          id: string
          media_byte_size: number | null
          media_height: number | null
          media_mime_type: string | null
          media_path: string
          media_width: number | null
          status: string
          upload_expires_at: string
          upload_started_at: string
        }
        SetofOptions: {
          from: "*"
          to: "posts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_circle_invite: {
        Args: { p_circle_id: string; p_invite_id: string }
        Returns: undefined
      }
      set_circle_member_role: {
        Args: { p_circle_id: string; p_role: string; p_user_id: string }
        Returns: {
          circle_id: string
          joined_at: string
          role: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "circle_members"
          isOneToOne: true
          isSetofReturn: false
        }
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

