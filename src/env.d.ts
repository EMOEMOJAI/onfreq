/** Optional features never require credentials during first-run setup. */
type OptionalSecrets = {
  MENTION_ROLE_ID?: string;
  FIR_LABELS?: string;
  EXCLUDED_CALLSIGNS?: string;
  GCA_DM_ENABLED?: string;
  GCA_DISCORD_GUILD_ID?: string;
  GCA_MEMBER_ROLE_ID?: string;
  GCA_COPY_USER_ID?: string;
  GCA_REGIONS?: string;
  GCA_APPROVALS?: string;
  GCA_HOME_OVERRIDES?: string;
  GCA_POLICY_URL?: string;
  IVAO_CLIENT_ID?: string;
  IVAO_CLIENT_SECRET?: string;
  COORDINATOR_NAME?: string;
};

// Extra local secret names must not turn optional features into required bindings.
type Env = Omit<CloudflareBindings, keyof OptionalSecrets> & OptionalSecrets;
