export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      alert_events: {
        Row: {
          alert_kind: string
          applied_revision: number | null
          boot_id: string | null
          device_id: string
          event_id: string
          is_simulated: boolean
          limit_value: number | null
          measured_at: string | null
          metric_value: number | null
          raised_at: string
          sample_sequence: number | null
          sequence_id: string | null
        }
        Insert: {
          alert_kind: string
          applied_revision?: number | null
          boot_id?: string | null
          device_id: string
          event_id?: string
          is_simulated: boolean
          limit_value?: number | null
          measured_at?: string | null
          metric_value?: number | null
          raised_at?: string
          sample_sequence?: number | null
          sequence_id?: string | null
        }
        Update: {
          alert_kind?: string
          applied_revision?: number | null
          boot_id?: string | null
          device_id?: string
          event_id?: string
          is_simulated?: boolean
          limit_value?: number | null
          measured_at?: string | null
          metric_value?: number | null
          raised_at?: string
          sample_sequence?: number | null
          sequence_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "alert_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["device_id"]
          },
          {
            foreignKeyName: "alert_events_device_id_boot_id_sample_sequence_fkey"
            columns: ["device_id", "boot_id", "sample_sequence"]
            isOneToOne: false
            referencedRelation: "device_telemetry"
            referencedColumns: ["device_id", "boot_id", "sample_sequence"]
          },
          {
            foreignKeyName: "alert_events_device_id_applied_revision_fkey"
            columns: ["device_id", "applied_revision"]
            isOneToOne: false
            referencedRelation: "device_config_revisions"
            referencedColumns: ["device_id", "revision"]
          },
          {
            foreignKeyName: "alert_events_sequence_fkey"
            columns: ["device_id", "sequence_id"]
            isOneToOne: false
            referencedRelation: "feed_sequences"
            referencedColumns: ["device_id", "sequence_id"]
          },
        ]
      }
      device_access: {
        Row: {
          alias: string | null
          device_id: string
          granted_at: string
          installation_id: string
          location: string | null
          revoked_at: string | null
          status: string
        }
        Insert: {
          alias?: string | null
          device_id: string
          granted_at?: string
          installation_id: string
          location?: string | null
          revoked_at?: string | null
          status: string
        }
        Update: {
          alias?: string | null
          device_id?: string
          granted_at?: string
          installation_id?: string
          location?: string | null
          revoked_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_access_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["device_id"]
          },
        ]
      }
      device_config_revisions: {
        Row: {
          applied_at: string | null
          device_id: string
          requested_at: string
          requested_snapshot: Json
          revision: number
          state: string
        }
        Insert: {
          applied_at?: string | null
          device_id: string
          requested_at?: string
          requested_snapshot: Json
          revision: number
          state: string
        }
        Update: {
          applied_at?: string | null
          device_id?: string
          requested_at?: string
          requested_snapshot?: Json
          revision?: number
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_config_revisions_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["device_id"]
          },
        ]
      }
      device_config_schedule_slots: {
        Row: {
          device_id: string
          iso_weekday: number
          local_time: string
          nozzle_number: number
          revision: number
          schedule_id: string
        }
        Insert: {
          device_id: string
          iso_weekday: number
          local_time: string
          nozzle_number: number
          revision: number
          schedule_id: string
        }
        Update: {
          device_id?: string
          iso_weekday?: number
          local_time?: string
          nozzle_number?: number
          revision?: number
          schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_config_schedule_slots_device_id_revision_schedule_i_fkey"
            columns: ["device_id", "revision", "schedule_id", "nozzle_number"]
            isOneToOne: false
            referencedRelation: "device_config_schedules"
            referencedColumns: [
              "device_id",
              "revision",
              "schedule_id",
              "nozzle_number",
            ]
          },
        ]
      }
      device_config_schedules: {
        Row: {
          device_id: string
          enabled: boolean
          nozzle_number: number
          requested_dose: Json
          revision: number
          schedule_id: string
          timezone: string
        }
        Insert: {
          device_id: string
          enabled: boolean
          nozzle_number: number
          requested_dose: Json
          revision: number
          schedule_id: string
          timezone: string
        }
        Update: {
          device_id?: string
          enabled?: boolean
          nozzle_number?: number
          requested_dose?: Json
          revision?: number
          schedule_id?: string
          timezone?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_config_schedules_device_id_revision_fkey"
            columns: ["device_id", "revision"]
            isOneToOne: false
            referencedRelation: "device_config_revisions"
            referencedColumns: ["device_id", "revision"]
          },
          {
            foreignKeyName: "device_config_schedules_device_id_schedule_id_fkey"
            columns: ["device_id", "schedule_id"]
            isOneToOne: false
            referencedRelation: "device_schedule_identities"
            referencedColumns: ["device_id", "schedule_id"]
          },
        ]
      }
      device_events: {
        Row: {
          created_at: string
          device_id: string
          event_sequence: number
          event_type: string
          nozzle_number: number
          payload: Json
          requested_dose: Json
          sequence_id: string
          step_index: number
        }
        Insert: {
          created_at?: string
          device_id: string
          event_sequence: number
          event_type: string
          nozzle_number: number
          payload?: Json
          requested_dose: Json
          sequence_id: string
          step_index: number
        }
        Update: {
          created_at?: string
          device_id?: string
          event_sequence?: number
          event_type?: string
          nozzle_number?: number
          payload?: Json
          requested_dose?: Json
          sequence_id?: string
          step_index?: number
        }
        Relationships: [
          {
            foreignKeyName: "device_events_device_id_sequence_id_fkey"
            columns: ["device_id", "sequence_id"]
            isOneToOne: false
            referencedRelation: "feed_sequences"
            referencedColumns: ["device_id", "sequence_id"]
          },
          {
            foreignKeyName: "device_events_device_id_sequence_id_step_index_nozzle_numb_fkey"
            columns: [
              "device_id",
              "sequence_id",
              "step_index",
              "nozzle_number",
              "requested_dose",
            ]
            isOneToOne: false
            referencedRelation: "feed_steps"
            referencedColumns: [
              "device_id",
              "sequence_id",
              "step_index",
              "nozzle_number",
              "requested_dose",
            ]
          },
        ]
      }
      device_execution_reservations: {
        Row: {
          acquired_at: string
          device_id: string
          phase: string
          released_at: string | null
          sequence_id: string
        }
        Insert: {
          acquired_at?: string
          device_id: string
          phase: string
          released_at?: string | null
          sequence_id: string
        }
        Update: {
          acquired_at?: string
          device_id?: string
          phase?: string
          released_at?: string | null
          sequence_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_execution_reservations_device_id_sequence_id_fkey"
            columns: ["device_id", "sequence_id"]
            isOneToOne: true
            referencedRelation: "feed_sequences"
            referencedColumns: ["device_id", "sequence_id"]
          },
        ]
      }
      device_schedule_identities: {
        Row: {
          created_at: string
          device_id: string
          schedule_id: string
        }
        Insert: {
          created_at?: string
          device_id: string
          schedule_id: string
        }
        Update: {
          created_at?: string
          device_id?: string
          schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_schedule_identities_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["device_id"]
          },
        ]
      }
      device_schedule_tombstones: {
        Row: {
          device_id: string
          retired_at: string
          schedule_id: string
        }
        Insert: {
          device_id: string
          retired_at?: string
          schedule_id: string
        }
        Update: {
          device_id?: string
          retired_at?: string
          schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_schedule_tombstones_device_id_schedule_id_fkey"
            columns: ["device_id", "schedule_id"]
            isOneToOne: true
            referencedRelation: "device_schedule_identities"
            referencedColumns: ["device_id", "schedule_id"]
          },
        ]
      }
      device_state: {
        Row: {
          contact_freshness: string
          device_id: string
          last_authenticated_contact_at: string | null
          last_sample_at: string | null
          lockout_sequence_id: string | null
          safety_lockout: boolean
          sample_freshness: string
          sample_quality: string
          updated_at: string
        }
        Insert: {
          contact_freshness?: string
          device_id: string
          last_authenticated_contact_at?: string | null
          last_sample_at?: string | null
          lockout_sequence_id?: string | null
          safety_lockout?: boolean
          sample_freshness?: string
          sample_quality?: string
          updated_at?: string
        }
        Update: {
          contact_freshness?: string
          device_id?: string
          last_authenticated_contact_at?: string | null
          last_sample_at?: string | null
          lockout_sequence_id?: string | null
          safety_lockout?: boolean
          sample_freshness?: string
          sample_quality?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_state_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: true
            referencedRelation: "devices"
            referencedColumns: ["device_id"]
          },
          {
            foreignKeyName: "device_state_device_id_lockout_sequence_id_fkey"
            columns: ["device_id", "lockout_sequence_id"]
            isOneToOne: false
            referencedRelation: "feed_sequences"
            referencedColumns: ["device_id", "sequence_id"]
          },
        ]
      }
      device_telemetry: {
        Row: {
          boot_id: string
          calibration_revision: number | null
          device_id: string
          do_mg_l: number | null
          do_quality: string
          feed_percent: number | null
          feed_quality: string
          feed_remaining_g: number | null
          measured_at: string | null
          received_at: string
          sample_sequence: number
          time_quality: string
        }
        Insert: {
          boot_id: string
          calibration_revision?: number | null
          device_id: string
          do_mg_l?: number | null
          do_quality: string
          feed_percent?: number | null
          feed_quality: string
          feed_remaining_g?: number | null
          measured_at?: string | null
          received_at?: string
          sample_sequence: number
          time_quality: string
        }
        Update: {
          boot_id?: string
          calibration_revision?: number | null
          device_id?: string
          do_mg_l?: number | null
          do_quality?: string
          feed_percent?: number | null
          feed_quality?: string
          feed_remaining_g?: number | null
          measured_at?: string | null
          received_at?: string
          sample_sequence?: number
          time_quality?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_telemetry_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["device_id"]
          },
        ]
      }
      devices: {
        Row: {
          alias: string | null
          applied_revision: number | null
          capabilities: Json
          capabilities_revision: number
          created_at: string
          desired_revision: number | null
          device_id: string
          firmware_version: string
          is_simulated: boolean
          location: string | null
          metadata_conflict: boolean
          metadata_revision: number
          model: string
          protocol_major: number
        }
        Insert: {
          alias?: string | null
          applied_revision?: number | null
          capabilities: Json
          capabilities_revision: number
          created_at?: string
          desired_revision?: number | null
          device_id: string
          firmware_version: string
          is_simulated: boolean
          location?: string | null
          metadata_conflict?: boolean
          metadata_revision?: number
          model: string
          protocol_major: number
        }
        Update: {
          alias?: string | null
          applied_revision?: number | null
          capabilities?: Json
          capabilities_revision?: number
          created_at?: string
          desired_revision?: number | null
          device_id?: string
          firmware_version?: string
          is_simulated?: boolean
          location?: string | null
          metadata_conflict?: boolean
          metadata_revision?: number
          model?: string
          protocol_major?: number
        }
        Relationships: [
          {
            foreignKeyName: "devices_applied_revision_fkey"
            columns: ["device_id", "applied_revision"]
            isOneToOne: false
            referencedRelation: "device_config_revisions"
            referencedColumns: ["device_id", "revision"]
          },
          {
            foreignKeyName: "devices_desired_revision_fkey"
            columns: ["device_id", "desired_revision"]
            isOneToOne: false
            referencedRelation: "device_config_revisions"
            referencedColumns: ["device_id", "revision"]
          },
        ]
      }
      feed_sequence_targets: {
        Row: {
          device_id: string
          first_nozzle_number: number
          first_step_index: number
          nozzle_number: number
          requested_dose: Json
          sequence_id: string
          step_index: number
        }
        Insert: {
          device_id: string
          first_nozzle_number: number
          first_step_index: number
          nozzle_number: number
          requested_dose: Json
          sequence_id: string
          step_index: number
        }
        Update: {
          device_id?: string
          first_nozzle_number?: number
          first_step_index?: number
          nozzle_number?: number
          requested_dose?: Json
          sequence_id?: string
          step_index?: number
        }
        Relationships: [
          {
            foreignKeyName: "feed_sequence_target_anchor_fkey"
            columns: [
              "device_id",
              "sequence_id",
              "first_step_index",
              "first_nozzle_number",
            ]
            isOneToOne: false
            referencedRelation: "feed_sequence_targets"
            referencedColumns: [
              "device_id",
              "sequence_id",
              "step_index",
              "nozzle_number",
            ]
          },
          {
            foreignKeyName: "feed_sequence_targets_device_id_sequence_id_fkey"
            columns: ["device_id", "sequence_id"]
            isOneToOne: false
            referencedRelation: "feed_sequences"
            referencedColumns: ["device_id", "sequence_id"]
          },
        ]
      }
      feed_sequences: {
        Row: {
          admitted_at: string | null
          capabilities_revision: number
          created_at: string
          device_id: string
          delivered_at: string | null
          due_at: string | null
          idempotency_key: string | null
          installation_id: string | null
          lockout_resolution_source: string | null
          lockout_resolved_at: string | null
          maximum_settling_ms: number | null
          request_id: string | null
          safety_lockout: boolean
          scheduler_wake_grace_ms: number | null
          sequence_id: string
          source: string
          start_before: string | null
          status: string
          status_sequence: number
          target_count: number
          unresolved: boolean
        }
        Insert: {
          admitted_at?: string | null
          capabilities_revision: number
          created_at?: string
          device_id: string
          delivered_at?: string | null
          due_at?: string | null
          idempotency_key?: string | null
          installation_id?: string | null
          lockout_resolution_source?: string | null
          lockout_resolved_at?: string | null
          maximum_settling_ms?: number | null
          request_id?: string | null
          safety_lockout?: boolean
          scheduler_wake_grace_ms?: number | null
          sequence_id: string
          source: string
          start_before?: string | null
          status: string
          status_sequence?: number
          target_count: number
          unresolved?: boolean
        }
        Update: {
          admitted_at?: string | null
          capabilities_revision?: number
          created_at?: string
          device_id?: string
          delivered_at?: string | null
          due_at?: string | null
          idempotency_key?: string | null
          installation_id?: string | null
          lockout_resolution_source?: string | null
          lockout_resolved_at?: string | null
          maximum_settling_ms?: number | null
          request_id?: string | null
          safety_lockout?: boolean
          scheduler_wake_grace_ms?: number | null
          sequence_id?: string
          source?: string
          start_before?: string | null
          status?: string
          status_sequence?: number
          target_count?: number
          unresolved?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "feed_sequences_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["device_id"]
          },
        ]
      }
      feed_steps: {
        Row: {
          baseline_ready_at: string | null
          device_id: string
          estimated_dispensed_g: number | null
          measured_dispensed_g: number | null
          measurement_quality: string
          nozzle_number: number
          requested_dose: Json
          sequence_id: string
          start_before: string | null
          started_at: string | null
          status: string
          step_index: number
          stopped_at: string | null
        }
        Insert: {
          baseline_ready_at?: string | null
          device_id: string
          estimated_dispensed_g?: number | null
          measured_dispensed_g?: number | null
          measurement_quality: string
          nozzle_number: number
          requested_dose: Json
          sequence_id: string
          start_before?: string | null
          started_at?: string | null
          status: string
          step_index: number
          stopped_at?: string | null
        }
        Update: {
          baseline_ready_at?: string | null
          device_id?: string
          estimated_dispensed_g?: number | null
          measured_dispensed_g?: number | null
          measurement_quality?: string
          nozzle_number?: number
          requested_dose?: Json
          sequence_id?: string
          start_before?: string | null
          started_at?: string | null
          status?: string
          step_index?: number
          stopped_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "feed_steps_device_id_sequence_id_step_index_nozzle_number__fkey"
            columns: [
              "device_id",
              "sequence_id",
              "step_index",
              "nozzle_number",
              "requested_dose",
            ]
            isOneToOne: true
            referencedRelation: "feed_sequence_targets"
            referencedColumns: [
              "device_id",
              "sequence_id",
              "step_index",
              "nozzle_number",
              "requested_dose",
            ]
          },
        ]
      }
      scheduled_occurrences: {
        Row: {
          created_at: string
          device_id: string
          occurrence_local_date: string
          outcome: string
          schedule_id: string
          sequence_id: string
        }
        Insert: {
          created_at?: string
          device_id: string
          occurrence_local_date: string
          outcome: string
          schedule_id: string
          sequence_id: string
        }
        Update: {
          created_at?: string
          device_id?: string
          occurrence_local_date?: string
          outcome?: string
          schedule_id?: string
          sequence_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_occurrences_device_id_schedule_id_fkey"
            columns: ["device_id", "schedule_id"]
            isOneToOne: false
            referencedRelation: "device_schedule_identities"
            referencedColumns: ["device_id", "schedule_id"]
          },
          {
            foreignKeyName: "scheduled_occurrences_device_id_sequence_id_fkey"
            columns: ["device_id", "sequence_id"]
            isOneToOne: false
            referencedRelation: "feed_sequences"
            referencedColumns: ["device_id", "sequence_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      art102_update_device_metadata: {
        Args: {
          p_alias: string
          p_device_id: string
          p_expected_revision: number
          p_installation_id: string
          p_location: string
        }
        Returns: Json
      }
      art31_create_manual_feed: {
        Args: {
          p_capabilities_revision: number
          p_device_id: string
          p_idempotency_key: string
          p_installation_id: string
          p_request_id: string
          p_targets: Json
        }
        Returns: Json
      }
      art31_history_detail: {
        Args: { p_device_id: string; p_installation_id: string; p_sequence_id: string }
        Returns: Json
      }
      art31_history_page: {
        Args: {
          p_before_created_at?: string | null
          p_before_sequence_id?: string | null
          p_device_id: string
          p_from_date: string | null
          p_installation_id: string
          p_source: string
          p_status: string
          p_to_date: string | null
        }
        Returns: Json
      }
      art31_read_manual_command: {
        Args: { p_by_key?: boolean; p_device_id: string; p_installation_id: string; p_lookup: string }
        Returns: Json
      }
      art31_sync_manual_feed: {
        Args: {
          p_active_sequence_id: string | null
          p_actuator_state: string
          p_capabilities_revision: number
          p_clock_quality: string
          p_clock_uncertainty_ms: number | null
          p_device_id: string
          p_device_verifier_hex: string
          p_events: Json
        }
        Returns: Json
      }
      rt01_device_work_token: {
        Args: { p_device_id: string }
        Returns: string
      }
      art38_authenticate_device: {
        Args: { p_verifier_hex: string }
        Returns: string
      }
      art38_create_pairing_challenge: {
        Args: {
          p_challenge_id: string
          p_device_id: string
          p_device_verifier_hex: string
          p_request_id: string
          p_verifier_hex: string
        }
        Returns: Json
      }
      art38_provision_simulated_device: {
        Args: {
          p_allow_rotation?: boolean
          p_credential_verifier_hex: string
          p_device_id: string
        }
        Returns: Json
      }
      art38_redeem_pairing_challenge: {
        Args: {
          p_challenge_id: string
          p_device_id: string
          p_installation_id: string
          p_verifier_hex: string
        }
        Returns: Json
      }
      art38_revoke_device_access: {
        Args: { p_device_id: string; p_installation_id: string }
        Returns: Json
      }
      art38_take_rate_limit: {
        Args: { p_endpoint: string; p_subject: string }
        Returns: boolean
      }
      art95_list_alert_events: {
        Args: {
          p_before_event_id?: string | null
          p_before_raised_at?: string | null
          p_device_id: string
          p_installation_id: string
        }
        Returns: Json
      }
      art95_set_alert_event_state: {
        Args: {
          p_action: string
          p_device_id: string
          p_event_id: string
          p_installation_id: string
        }
        Returns: Json
      }
      art95_bulk_alert_event_state: {
        Args: {
          p_action: string
          p_device_id: string
          p_installation_id: string
          p_through_event_id: string
          p_through_raised_at: string
        }
        Returns: Json
      }
      art96_register_push_token: {
        Args: { p_eas_project_id: string; p_expo_push_token: string; p_installation_id: string; p_platform: string }
        Returns: Json
      }
      art96_revoke_push_token: {
        Args: { p_installation_id: string }
        Returns: Json
      }
      art96_read_alert_event: {
        Args: { p_device_id: string; p_event_id: string; p_installation_id: string }
        Returns: Json
      }
      art96_claim_push_deliveries: {
        Args: { p_limit?: number; p_lease_seconds?: number }
        Returns: Json
      }
      art96_begin_push_send: {
        Args: { p_delivery_id: string; p_generation: number; p_lease_id: string }
        Returns: Json
      }
      art96_validate_push_send_batch: {
        Args: { p_claims: Json }
        Returns: Json
      }
      art96_record_push_send: {
        Args: { p_delivery_id: string; p_error?: string | null; p_generation: number; p_lease_id: string; p_outcome: string; p_ticket_id?: string | null }
        Returns: Json
      }
      art96_claim_push_receipts: {
        Args: { p_limit?: number; p_lease_seconds?: number }
        Returns: Json
      }
      art96_record_push_receipt: {
        Args: { p_delivery_id: string; p_error?: string | null; p_lease_id: string; p_status: string }
        Returns: Json
      }
      art96_push_sender_status: {
        Args: Record<PropertyKey, never>
        Returns: Json
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
