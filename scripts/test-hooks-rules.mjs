// Real-Gitleaks tests of the repository rules in .gitleaks.toml for secret
// names, Discord IDs, private JSON, deployment and identifying settings. The
// shared fixtures and helpers are in scripts/hook-test-helpers.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gitleaksSkip, fixture, repoRules, assignment, commitRules, scanAssignment, realShaped, otherReal, firPrefixes,
  coordinatorName, jsonName, identifyingCases,
} from './hook-test-helpers.mjs';

test('the repository Gitleaks rule blocks low-entropy values of its secret names (T1-5)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    // Gitleaks' default allowlist treats one repeated character as a placeholder,
    // so the low-entropy fixture alternates two.
    const value = 'ab'.repeat(10);
    const text = assignment('IVAO_WEBHOOK_SECRET', value);
    // Default rules alone miss it, so only the repository rule can block it.
    commitRules(f, '[extend]\nuseDefault = true\n');
    let { hook, scan } = scanAssignment(f, text);
    for (const result of hook) assert.equal(result.status, 0, result.stderr);
    assert.equal(scan.status, 0, scan.stderr);
    commitRules(f, repoRules());
    for (const [name, quoted] of [['IVAO_WEBHOOK_SECRET', text], ['POLL_SECRET', `POLL_SECRET: '${value}',\n`],
      ['HISTORY_SECRET', `export HISTORY_SECRET=${value}\n`], ['IVAO_CLIENT_SECRET', `"IVAO_CLIENT_SECRET": "${value}"\n`],
      ['DISCORD_BOT_TOKEN', `DISCORD_BOT_TOKEN = ${value}\n`]]) {
      ({ hook, scan } = scanAssignment(f, quoted));
      for (const result of hook) {
        assert.equal(result.status, 1, `${name}: ${result.stderr}`);
        assert.match(result.stderr, /pre-commit: BLOCKED — the secret scan failed or found a secret/, name);
        assert.doesNotMatch(result.stderr + result.stdout, new RegExp(value), name);
      }
      assert.equal(scan.status, 1, `${name}: ${scan.stderr}`);
      assert.doesNotMatch(scan.stderr + scan.stdout, new RegExp(value), name);
    }
    // Shorter values and empty placeholders are not flagged.
    ({ hook, scan } = scanAssignment(f, assignment('POLL_SECRET', 'a'.repeat(15)) + assignment('HISTORY_SECRET', '')));
    for (const result of hook) assert.equal(result.status, 0, result.stderr);
    assert.equal(scan.status, 0, scan.stderr);
  });

test('the repository Gitleaks allowlist matches whole synthetic fixture values only (T1-5)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const value of ['aaaaaaaa-synthetic-aaaaaaaa', 'notsynthetic-aaaaaaaaaaaa', 'synthetic-aaaaaaaa.aaaaaaaa',
      'aaaatest-poll-secret', 'test-poll-secret-aaaa', 'env.POLL_SECRET.aaaaaaaa', 'aaaaaaaa.env.POLL_SECRET']) {
      const { hook, scan } = scanAssignment(f, assignment('IVAO_WEBHOOK_SECRET', value));
      for (const result of hook) assert.equal(result.status, 1, `${value}: ${result.stderr}`);
      assert.equal(scan.status, 1, `${value}: ${scan.stderr}`);
    }
    // A fixture value, and a code reference to a binding rather than a value.
    const reference = (name) => `${name}: env.${name},\n`;
    const { hook, scan } = scanAssignment(f, assignment('IVAO_WEBHOOK_SECRET', 'synthetic-webhook-fixture-0123')
      + reference('POLL_SECRET'));
    for (const result of hook) assert.equal(result.status, 0, result.stderr);
    assert.equal(scan.status, 0, scan.stderr);
  });

test('the repository Gitleaks rules block real-shaped Discord IDs and private JSON literals, redacted (ROT-1)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    const blocked = (text, secret, label) => {
      const { hook, scan } = scanAssignment(f, text);
      for (const result of hook) {
        assert.equal(result.status, 1, `${label}: ${result.stderr}`);
        assert.doesNotMatch(result.stderr + result.stdout, new RegExp(secret), label);
      }
      assert.equal(scan.status, 1, `${label}: ${scan.stderr}`);
      assert.doesNotMatch(scan.stderr + scan.stdout, new RegExp(secret), label);
    };
    for (const name of ['MENTION_ROLE_ID', 'GCA_DISCORD_GUILD_ID', 'GCA_MEMBER_ROLE_ID', 'GCA_VERIFIED_ROLE_ID',
      'GCA_COPY_USER_ID', 'DISCORD_CHANNEL_IDS']) blocked(assignment(name, realShaped), realShaped, name);
    blocked(assignment('DISCORD_CHANNEL_IDS', `900000000000000001,${otherReal}`), otherReal, 'mixed list');
    const vid = ['73', '4125'].join('');
    for (const name of ['GCA_REGIONS', 'GCA_APPROVALS', 'GCA_HOME_OVERRIDES', 'FIR_LABELS']) {
      blocked(`${name}='{"${vid}":"AC"}'\n`, vid, name);
    }
    // Setting names match in any case.
    const lower = (name) => name.toLowerCase();
    blocked(assignment(lower('GCA_MEMBER_ROLE_ID'), realShaped), realShaped, 'lowercase ID name');
    blocked(`${lower('GCA_HOME_OVERRIDES')}='{"${vid}":"AC"}'\n`, vid, 'lowercase JSON name');
  });

test('the repository Gitleaks rules pass synthetic IDs, empty values, references and expressions (ROT-1)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    const reference = (name) => `${name}: env.${name},\n`;
    const text = assignment('GCA_MEMBER_ROLE_ID', '100000000000000002')
      + assignment('DISCORD_CHANNEL_IDS', '900000000000000001,900000000000000002')
      + assignment('MENTION_ROLE_ID', '') + assignment('GCA_COPY_USER_ID', '200000000000000099')
      + `GCA_APPROVALS='{}'\nFIR_LABELS='[]'\n` + reference('GCA_DISCORD_GUILD_ID') + 'GCA_VERIFIED_ROLE_ID: VERIFIED,\n'
      + "GCA_REGIONS: JSON.stringify({ AA: { name: 'Example', prefixes: ['XA'] } }),\n"
      + `GCA_HOME_OVERRIDES: '{"600001":"ZZ"}',\n`;
    const { hook, scan } = scanAssignment(f, text);
    for (const result of hook) assert.equal(result.status, 0, result.stderr);
    assert.equal(scan.status, 0, scan.stderr);
  });

test('the repository Gitleaks rules block multi-line JSON literals and deployment settings, redacted (NX-1c)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    // Each line sits between others, so the match is mid-stream in the scanned log.
    // `secret` is text on the matched line that redacted output never shows.
    const blocked = (line, secret, label) => {
      const { hook, scan } = scanAssignment(f, `# synthetic settings\n${line}# end\n`);
      for (const result of [...hook, scan]) {
        assert.equal(result.status, 1, `${label}: ${result.stderr}`);
        if (secret) assert.ok(!(result.stderr + result.stdout).includes(secret), label);
      }
    };
    blocked(`${firPrefixes}="XD, JD"\n`, 'XD, JD', 'quoted list with one real-looking prefix');
    blocked(`${firPrefixes}=JD\n`, '=JD', 'unquoted prefix');
    blocked(`${firPrefixes}=XD, JD # note\n`, 'XD, JD', 'unquoted list read to the comment, as dotenv does');
    blocked(`export ${coordinatorName}="synthetic realname"\n`, 'realname', 'quoted name with a space');
    blocked(`${coordinatorName}=prod-state\n`, 'prod-state', 'unquoted name');
    blocked(`${coordinatorName}='prod state'\n`, 'prod state', 'single-quoted name');
    const vid = ['73', '4125'].join('');
    for (const [name, open, close] of [['GCA_REGIONS', '{', '}'], ['GCA_APPROVALS', '{', '}'],
      ['GCA_HOME_OVERRIDES', '{', '}'], ['FIR_LABELS', '[', ']'], ['gca_regions', '{', '}']]) {
      // The match is the opening line, so its text is checked; the VID on the next line is never printed either.
      const opening = `${name}='${open}`;
      blocked(`${opening}\n  "${vid}": "AC"\n${close}'\n`, opening, `multi-line ${name}`);
    }
  });

test('the repository Gitleaks rules pass synthetic deployment settings, empty values, code and expressions (NX-1c)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    const text = `${firPrefixes}="XD,QC"\n${firPrefixes}=""\n${firPrefixes}=xd, q,\n`
      + `${coordinatorName}=synthetic-state\n${coordinatorName}=synthetic-state # note\n${coordinatorName}=''\n`
      // Not dotenv or shell lines: TypeScript fixtures, code and commands.
      + `  ${firPrefixes}: 'XD',\nexport const ${coordinatorName} = 'onfreq';\n`
      + `npx wrangler secret put ${firPrefixes}\n`
      // Dotenv names are case-sensitive, so a lowercase name sets nothing.
      + `${firPrefixes.toLowerCase()}=JD\n`
      + "GCA_REGIONS: JSON.stringify({\n  AA: { name: 'Example', prefixes: ['XA'] },\n}),\n";
    const { hook, scan } = scanAssignment(f, text);
    for (const result of hook) assert.equal(result.status, 0, result.stderr);
    assert.equal(scan.status, 0, scan.stderr);
  });

test('the repository Gitleaks rules block the first line of a pretty-printed JSON literal, redacted (NX-2c)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    // Each literal continues on later lines, so neither single-line nor bare-bracket rule applies.
    const blocked = (line, secret, rest) => {
      const { hook, scan } = scanAssignment(f, `# synthetic settings\n${line}${rest}# end\n`);
      for (const result of [...hook, scan]) {
        assert.equal(result.status, 1, `${line}: ${result.stderr}`);
        assert.ok(!(result.stderr + result.stdout).includes(secret), line);
      }
    };
    const key = ['JD', 'DD'].join('');
    for (const [line, secret, rest] of [
      [`${jsonName('GCA', 'REGIONS')}='{"${key}": [\n`, `{"${key}": [`, '    "JD"\n  ]\n}\'\n'],
      [`export ${jsonName('GCA', 'APPROVALS')}={"a": {\n`, '{"a": {', '  "b": 1\n}}\n'],
      [`${jsonName('FIR', 'LABELS')} = [{"x": 1},\n`, '[{"x": 1},', '  {"y": 2}]\n'],
      // Shell-escaped quotes, a key whose value starts on the next line, nested
      // brackets, a lowercase name, a CRLF line and a TypeScript property.
      [`${jsonName('GCA', 'HOME', 'OVERRIDES')}="{\\"${key}\\": {\n`, `{\\"${key}\\": {`, '  \\"b\\": 1\n}}"\n'],
      [`${jsonName('GCA', 'REGIONS')}='{"${key}":\n`, `{"${key}":`, '  ["JD"]\n}\'\n'],
      [`${jsonName('gca', 'regions')}='[ {"${key}": [\n`, `[ {"${key}": [`, '  "JD"]}]\'\n'],
      [`${jsonName('FIR', 'LABELS')}='{"${key}": "Synthetic",\r\n`, `{"${key}": "Synthetic",`, '  "JDXX": "Other"\r\n}\'\r\n'],
      [`  ${jsonName('GCA', 'APPROVALS')}: \`{"${key}": [\n`, `{"${key}": [`, '    "1"\n  ]}`,\n'],
    ]) blocked(line, secret, rest);
  });

test('the repository Gitleaks rules pass JSON expressions, empty and fixture values and unquoted keys (NX-2c)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    // A quote or backtick ends the value, so later code on the line is not read as JSON.
    const text = "  GCA_APPROVALS: '{}', GCA_HOME_OVERRIDES: JSON.stringify({\n    JDDD: ['JD'],\n  }),\n"
      + "  GCA_REGIONS: JSON.stringify({\n    AA: { name: 'Example', prefixes: ['XA'] },\n  }),\n"
      + "GCA_REGIONS='{}'\n"
      // The single-line rule's published synthetic fixture.
      + `  GCA_HOME_OVERRIDES: '{"600001":"ZZ"}',\n`
      // TypeScript object literals without a quoted key.
      + 'const GCA_REGIONS = { JDDD: [\n  \'JD\',\n] };\nconst FIR_LABELS = [{ x: 1 },\n  { y: 2 }];\n';
    const { hook, scan } = scanAssignment(f, text);
    for (const result of hook) assert.equal(result.status, 0, result.stderr);
    assert.equal(scan.status, 0, scan.stderr);
  });

test('the repository Gitleaks rules flag values after blanks inside the quotes (RA)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    const vid = ['73', '4125'].join('');
    const value = 'ab'.repeat(10);
    for (const [line, label] of [
      [assignment('POLL_SECRET', ` ${value}`), 'secret'],
      [`${jsonName('POLL', 'SECRET')}=' \t${value}'\n`, 'secret after a tab'],
      [assignment('GCA_MEMBER_ROLE_ID', ` ${realShaped}`), 'Discord ID'],
      [`${jsonName('GCA', 'REGIONS')}=' {"${vid}":"AC"}'\n`, 'JSON literal'],
      [`${jsonName('FIR', 'LABELS')}=" [\n  "JD"\n]"\n`, 'multi-line JSON literal'],
      [`${jsonName('GCA', 'APPROVALS')}=' {"JDDD": [\n  "1"\n]}'\n`, 'pretty-printed JSON literal'],
    ]) {
      const { hook, scan } = scanAssignment(f, `# synthetic settings\n${line}# end\n`);
      for (const result of [...hook, scan]) assert.equal(result.status, 1, `${label}: ${result.stderr}`);
    }
  });

test('the deployment rules allow Q and X prefixes only for FIR prefixes (RA)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const line of [`${coordinatorName}=QXA\n`, `export ${coordinatorName}="QX, XD"\n`, `${firPrefixes}=synthetic-prefixes\n`]) {
      const { hook, scan } = scanAssignment(f, `# synthetic settings\n${line}# end\n`);
      for (const result of [...hook, scan]) assert.equal(result.status, 1, `${line}: ${result.stderr}`);
    }
    const { hook, scan } = scanAssignment(f, `${firPrefixes}="QX, XD"\n${firPrefixes}=xd\n${coordinatorName}=synthetic-state\n`);
    for (const result of [...hook, scan]) assert.equal(result.status, 0, result.stderr);
  });

test('the repository Gitleaks rules block identifying settings that the default rules miss, redacted (NX3-S2 F7-F9)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const cases = identifyingCases();
    // Default rules alone pass every case, so only the repository rules can block them.
    commitRules(f, '[extend]\nuseDefault = true\n');
    let { hook, scan } = scanAssignment(f, cases.map(([line]) => line).join(''));
    for (const result of [...hook, scan]) assert.equal(result.status, 0, result.stderr);
    commitRules(f, repoRules());
    for (const [line, secret, label] of cases) {
      ({ hook, scan } = scanAssignment(f, `# synthetic settings\n${line}# end\n`));
      for (const result of [...hook, scan]) {
        assert.equal(result.status, 1, `${label}: ${result.stderr}`);
        if (secret) assert.ok(!(result.stderr + result.stdout).includes(secret), label);
      }
    }
  });

test('the repository Gitleaks rules pass identifying-setting fixtures, empty values, code and reserved hosts (NX3-S2 F7-F9)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    // The tracked fixtures and references, as written in src/, test/, config/ and vitest.config.ts.
    const text = "    ...env, IVAO_CLIENT_ID: 'test-client', IVAO_CLIENT_SECRET: 'test-secret',\n"
      + "    expect(ivaoAuthFromEnv({ IVAO_CLIENT_ID: 'a' } as unknown as Env)).toBeUndefined();\n"
      + "      ivaoAuthFromEnv({ IVAO_CLIENT_ID: ' ', IVAO_CLIENT_SECRET: ' ' } as unknown as Env),\n"
      + '  IVAO_CLIENT_ID?: string;\n  const clientId = env.IVAO_CLIENT_ID?.trim();\n'
      + "IVAO_CLIENT_ID=\"\"\n        IVAO_CLIENT_ID: '',\nIVAO_CLIENT_ID=synthetic-ivao-client\n"
      + "IVAO_CLIENT_ID='00000000-0000-0000-0000-000000000000'\n  IVAO_CLIENT_ID: clientId,\n"
      + "  IVAO_CLIENT_ID: env.IVAO_CLIENT_ID,\n  IVAO_CLIENT_ID: 'abc1234',\n"
      + "const EXCLUDED = { EXCLUDED_CALLSIGNS: 'QCXX_CTR' };\n"
      + "    ['an excluded callsign', entry('QCTT_GND'), { EXCLUDED_CALLSIGNS: 'QCTT_GND' }],\n"
      + "    ['a listed excluded callsign', {}, { EXCLUDED_CALLSIGNS: 'QC_OTHER, xa_syn_ctr' }],\n"
      + "    await expect(configuredPoll({ EXCLUDED_CALLSIGNS: a, DISCORD_CHANNEL_IDS: '900000000000000001' }))\n"
      + '        ...env, EXCLUDED_CALLSIGNS: b,\n  const excluded = parseExcludedCallsigns(env.EXCLUDED_CALLSIGNS);\n'
      + 'EXCLUDED_CALLSIGNS=""\nEXCLUDED_CALLSIGNS=QCXX_CTR,\n'
      + "    const parsed = parseGcaPolicy({ ...settings(), GCA_POLICY_URL: 'https://example.test/gca' })!;\n"
      + "    await gcaConfig({ GCA_DM_ENABLED: 'true', GCA_POLICY_URL: 'http://example.test/gca' });\n"
      + "      expect(parseGcaPolicy({ ...settings(), GCA_POLICY_URL: String(url) })?.policyUrl).toBeUndefined();\n"
      + "    await check([atc({ sessionId: 2 })], { ...settings(), GCA_POLICY_URL: ' ' });\n"
      + 'GCA_POLICY_URL=""\nGCA_POLICY_URL=https://policy.example/gca?ref=1#top\nGCA_POLICY_URL="HTTPS://X.INVALID"\n'
      + "GCA_POLICY_URL='https://example.test/gca?ref=xxxx'\n";
    const { hook, scan } = scanAssignment(f, text);
    for (const result of [...hook, scan]) assert.equal(result.status, 0, result.stderr);
  });
