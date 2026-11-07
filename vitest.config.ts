import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scratch work under the ignored .local/ must never change the test gate.
    exclude: [...configDefaults.exclude, '.local/**', '.wrangler/**'],
    // Durable Object scenarios run many polls each; a loaded machine must not time them out at 5 s.
    testTimeout: 30_000,
  },
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    remoteBindings: false,
    miniflare: {
      bindings: {
        DISCORD_BOT_TOKEN: 'test-token',
        COORDINATOR_NAME: '',
        DISCORD_CHANNEL_IDS: '900000000000000001',
        MENTION_ROLE_ID: '',
        MENTION_COOLDOWN_MINUTES: '',
        GCA_DM_ENABLED: 'false',
        GCA_DISCORD_GUILD_ID: '100000000000000001',
        GCA_MEMBER_ROLE_ID: '100000000000000002',
        GCA_VERIFIED_ROLE_ID: '',
        GCA_COPY_USER_ID: '',
        GCA_REGIONS: '',
        GCA_APPROVALS: '{}',
        GCA_HOME_OVERRIDES: '',
        GCA_POLICY_URL: '',
        SHORT_SESSION_DM_ENABLED: 'false',
        IVAO_CLIENT_ID: '',
        IVAO_CLIENT_SECRET: '',
        // Distinct synthetic values: a HISTORY_SECRET equal to POLL_SECRET disables history routes.
        POLL_SECRET: 'synthetic-poll-secret-for-vitest-only',
        HISTORY_SECRET: 'synthetic-history-secret-for-vitest-only',
        IVAO_WEBHOOK_SECRET: 'synthetic-ivao-webhook-signing-secret-vitest',
        // The plan's fixed-vector dummy key (key id 839683debc9ccbd0) and a distinct next key.
        GCA_ADMIN_HMAC_KEY: 'synthetic-gca-admin-test-key-0001-abcdef',
        GCA_ADMIN_HMAC_KEY_NEXT: 'synthetic-gca-admin-next-key-0002-abcdef',
        FIR_PREFIXES: 'XA,QC,QE,QF,QG,QH',
        FIR_LABELS: '',
        OFFLINE_GRACE_POLLS: '2',
        EXCLUDED_CALLSIGNS: '',
      },
    },
  })],
});
