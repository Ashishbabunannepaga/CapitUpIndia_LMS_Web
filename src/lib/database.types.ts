// Types for the Supabase schema in supabase/migrations.
// Regenerate with `npm run db:types` once a local Supabase stack is running;
// until then keep this file in sync with the migrations by hand.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type UserRole = "ADMIN" | "AGENT";
export type LeadType = "New" | "Renewal";
export type BusinessType = "Corporate" | "Retail";
export type PolicyProduct =
  | "Health"
  | "Fire or Property"
  | "Life"
  | "Motor"
  | "Liability"
  | "Travel"
  | "Marine"
  | "Credit";
export type LeadStatus =
  | "Prospect"
  | "Quoted"
  | "Active Client"
  | "Follow-up"
  | "Closed Won"
  | "Closed Lost";
export type AiFeature =
  | "lead_intake"
  | "card_ocr"
  | "follow_up"
  | "follow_up_rephrase"
  | "bulk_mapping"
  | "other";

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string;
          role: UserRole;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: {
          full_name?: string;
          role?: UserRole;
          is_active?: boolean;
        };
        Relationships: [];
      };
      leads: {
        Row: {
          id: number;
          client_name: string;
          client_name_normalized: string;
          type: LeadType;
          business_type: BusinessType;
          policy_product: PolicyProduct;
          sub_product_name: string;
          renewal_date: string | null;
          poc_name: string;
          poc_designation: string;
          poc_contact_number: string;
          poc_email_id: string;
          poc2_name: string;
          poc2_designation: string;
          poc2_contact_number: string;
          poc2_email_id: string;
          notes: string;
          status: LeadStatus;
          assigned_agent_id: string | null;
          // Maintained by the database whenever assigned_agent_id changes.
          assigned_at: string | null;
          is_duplicate: boolean;
          duplicate_label: string;
          duplicate_resolved_at: string | null;
          duplicate_resolved_by: string | null;
          visiting_card_path: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          client_name: string;
          type?: LeadType;
          business_type?: BusinessType;
          policy_product?: PolicyProduct;
          sub_product_name?: string;
          renewal_date?: string | null;
          poc_name?: string;
          poc_designation?: string;
          poc_contact_number?: string;
          poc_email_id?: string;
          poc2_name?: string;
          poc2_designation?: string;
          poc2_contact_number?: string;
          poc2_email_id?: string;
          notes?: string;
          status?: LeadStatus;
          assigned_agent_id?: string | null;
          visiting_card_path?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["leads"]["Insert"]> & {
          is_duplicate?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "leads_assigned_agent_id_fkey";
            columns: ["assigned_agent_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      events: {
        Row: {
          id: number;
          lead_id: number | null;
          title: string;
          event_timestamp: string;
          notes: string;
          milestone: string | null;
          is_completed: boolean;
          completed_at: string | null;
          is_system_generated: boolean;
          is_background_reminder: boolean;
          reminder_sent_at: string | null;
          assigned_agent_id: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          lead_id?: number | null;
          title: string;
          event_timestamp: string;
          notes?: string;
          is_completed?: boolean;
          assigned_agent_id?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["events"]["Insert"]> & {
          reminder_sent_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "events_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
        ];
      };
      lead_notes: {
        Row: {
          id: number;
          lead_id: number;
          agent_id: string | null;
          agent_name: string;
          content: string;
          created_at: string;
        };
        Insert: {
          lead_id: number;
          content: string;
          // Overwritten by the database from the author's profile.
          agent_name?: string;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: "lead_notes_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
        ];
      };
      lead_note_reads: {
        Row: { note_id: number; user_id: string; read_at: string };
        Insert: { note_id: number };
        Update: never;
        Relationships: [];
      };
      ai_model_pricing: {
        Row: {
          model_name: string;
          display_name: string;
          input_usd_per_million: number;
          output_usd_per_million: number;
          is_active: boolean;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          model_name: string;
          display_name: string;
          input_usd_per_million: number;
          output_usd_per_million: number;
          is_active?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["ai_model_pricing"]["Insert"]>;
        Relationships: [];
      };
      app_settings: {
        Row: { key: string; value: Json; description: string; updated_at: string; updated_by: string | null };
        Insert: { key: string; value: Json; description?: string };
        Update: { value?: Json; description?: string };
        Relationships: [];
      };
      ai_usage_logs: {
        Row: {
          id: number;
          user_id: string | null;
          agent_name: string;
          feature_name: AiFeature;
          model_name: string;
          input_tokens: number;
          output_tokens: number;
          cost_inr: number;
          created_at: string;
        };
        // Server-only (service role). cost_inr is recomputed by the database.
        Insert: {
          user_id: string | null;
          agent_name?: string;
          feature_name: AiFeature;
          model_name: string;
          input_tokens: number;
          output_tokens: number;
          cost_inr?: number;
        };
        Update: never;
        Relationships: [];
      };
      audit_logs: {
        Row: {
          id: number;
          table_name: string;
          record_id: string;
          action: "INSERT" | "UPDATE" | "DELETE";
          actor_id: string | null;
          old_data: Json | null;
          new_data: Json | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      renewal_milestone_offsets: {
        Row: { milestone: string; offset_interval: string; sort_order: number };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      current_user_role: { Args: Record<string, never>; Returns: UserRole | null };
      is_admin: { Args: Record<string, never>; Returns: boolean };
      is_active_user: { Args: Record<string, never>; Returns: boolean };
      normalize_company_name: { Args: { name: string }; Returns: string };
      renewal_due_at: { Args: { p_renewal_date: string }; Returns: string };
      find_similar_leads: {
        Args: {
          p_client_name: string;
          p_exclude_id?: number | null;
          p_threshold?: number;
          p_limit?: number;
        };
        Returns: {
          lead_id: number;
          client_name: string;
          assigned_agent_id: string | null;
          assigned_agent_name: string;
          similarity: number;
          is_exact: boolean;
        }[];
      };
      add_lead_contact: {
        Args: {
          p_lead_id: number;
          p_name: string;
          p_designation?: string;
          p_phone?: string;
          p_email?: string;
        };
        Returns: "poc1" | "poc2" | "notes" | "existing";
      };
      unread_lead_notes: {
        Args: { p_limit?: number };
        Returns: {
          id: number;
          lead_id: number;
          client_name: string;
          agent_id: string | null;
          agent_name: string;
          content: string;
          created_at: string;
        }[];
      };
      count_unread_lead_notes: { Args: Record<string, never>; Returns: number };
      mark_lead_notes_read: { Args: { p_lead_id?: number | null }; Returns: number };
    };
    Enums: {
      user_role: UserRole;
      lead_type: LeadType;
      business_type: BusinessType;
      policy_product: PolicyProduct;
      lead_status: LeadStatus;
    };
    CompositeTypes: { [_ in never]: never };
  };
};

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];

export type Profile = Tables<"profiles">;
export type Lead = Tables<"leads">;
export type LeadEvent = Tables<"events">;
export type LeadNote = Tables<"lead_notes">;
export type AiUsageLog = Tables<"ai_usage_logs">;
