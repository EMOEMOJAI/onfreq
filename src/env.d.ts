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
//
// P1-6 asked for POLL_SECRET to join OptionalSecrets too (every call site
// already treats it as optional via `env.POLL_SECRET?.trim()`, so the
// generated required `string` is a type lie). Tried and reverted: excluding
// 'POLL_SECRET' from this Omit — whether via OptionalSecrets or a literal
// union — makes `tsc` silently fall back to the bare `DurableObject` type for
// `POLL_COORDINATOR: DurableObjectNamespace<PollCoordinator>` in
// worker-configuration.d.ts (PollCoordinator extends DurableObject<Env>, so
// Env, CloudflareBindings and the coordinator's own class form a cycle;
// touching this one key tips tsc's structural resolution of that cycle into
// the fallback union, breaking `test/poll.test.ts`'s `instance.poll()` /
// `instance.cleanupGcaHistory()` calls with real compile errors). Widening it
// via a trailing `& Partial<Pick<CloudflareBindings, 'POLL_SECRET'>>` instead
// compiles, but an intersection's required member always wins, so it does not
// actually change `Env['POLL_SECRET']` from `string` to `string | undefined`
// — a no-op that would misleadingly look fixed. Leaving POLL_SECRET out of
// OptionalSecrets and relying on the existing `?.` guards until this circular
// type can be restructured deliberately (own risk, out of scope here).
type Env = Omit<CloudflareBindings, keyof OptionalSecrets> & OptionalSecrets;
