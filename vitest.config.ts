import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    remoteBindings: false,
    miniflare: {
      bindings: {
        DISCORD_BOT_TOKEN: 'test-token',
        COORDINATOR_NAME: '',
        DISCORD_CHANNEL_IDS: 'test-channel',
        MENTION_ROLE_ID: '',
        GCA_DM_ENABLED: 'false',
        GCA_DISCORD_GUILD_ID: '100000000000000001',
        GCA_MEMBER_ROLE_ID: '100000000000000002',
        GCA_COPY_USER_ID: '',
        GCA_REGIONS: '',
        GCA_APPROVALS: '{}',
        GCA_HOME_OVERRIDES: '',
        GCA_POLICY_URL: '',
        IVAO_CLIENT_ID: '',
        IVAO_CLIENT_SECRET: '',
        POLL_SECRET: 'test-poll-secret',
        FIR_PREFIXES: 'XA,QC,QE,QF,QG,QH',
        FIR_LABELS: '',
        OFFLINE_GRACE_POLLS: '2',
        EXCLUDED_CALLSIGNS: '',
      },
    },
  })],
});
