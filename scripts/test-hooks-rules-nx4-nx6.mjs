// Real-Gitleaks tests of the NX4-G1, NX5-L2 and NX-6 changes to the repository
// rules in .gitleaks.toml: each blocks or passes its cases and is needed. The
// shared fixtures and helpers are in scripts/hook-test-helpers.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  gitleaksSkip, fixture, repoRules, commitRules, scanAssignment, firPrefixes, coordinatorName, gitEnv, secretScan,
  callsignsName, policyUrlName, jPrefix, g1Cases, firNx7, firColonBeforeNx6, l2Texts, editRule, beforeL2, l2Cases,
  settingsText, withoutRule, previousCallsignRule, scanCommit,
} from './hook-test-helpers.mjs';

test('each NX5-L2 rule and change is needed: its cases pass without the rule or flip with its earlier text (NX5-L2)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    for (const [id, { block, pass }] of Object.entries(l2Cases())) {
      commitRules(f, withoutRule(repoRules(), id));
      let scan = scanCommit(f, block.map(([line]) => settingsText(line)).join(''));
      assert.equal(scan.status, 0, `${id} removed: ${scan.stderr}`);
      if (!l2Texts[id]) continue;
      commitRules(f, beforeL2(repoRules(), id));
      const needed = block.filter((item) => item[3]);
      if (needed.length) {
        scan = scanCommit(f, needed.map(([line]) => settingsText(line)).join(''));
        assert.equal(scan.status, 0, `${id} before NX5-L2: ${scan.stderr}`);
      }
      for (const [line, label] of pass.filter((item) => item[2])) {
        scan = scanCommit(f, settingsText(line));
        assert.equal(scan.status, 1, `${id} before NX5-L2 blocks ${label}: ${scan.stderr}`);
      }
    }
  });

test('the repository Gitleaks rules block NX5-L2 callsign, policy link, FIR prefix and coordinator forms, redacted (NX5-L2)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const { block } of Object.values(l2Cases())) {
      for (const [line, secret, label] of block) {
        const { hook, scan } = scanAssignment(f, settingsText(line));
        for (const result of [...hook, scan]) {
          assert.equal(result.status, 1, `${label}: ${result.stderr}`);
          for (const text of [secret].flat()) {
            if (text) assert.ok(!(result.stderr + result.stdout).includes(text), `${label}: ${text.length} characters shown`);
          }
        }
      }
    }
  });

test('the NX-6 blanks around commas in the FIR prefix NAME:list branch are needed: their cases pass with ASCII blanks (NX-6)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const id = 'onfreq-fir-prefixes-property';
    const needed = l2Cases()[id].block.filter((item) => item[4]);
    assert.ok(needed.length > 0);
    commitRules(f, editRule(repoRules(), id, [['regex', firNx7, firColonBeforeNx6]]));
    const scan = scanCommit(f, needed.map(([line]) => settingsText(line)).join(''));
    assert.equal(scan.status, 0, `${id} before NX-6: ${scan.stderr}`);
  });

test('the repository Gitleaks rules pass NX5-L2 synthetic, reference and shell-separated forms (NX5-L2)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const { pass } of Object.values(l2Cases())) {
      for (const [line, label] of pass) {
        const { hook, scan } = scanAssignment(f, settingsText(line));
        for (const result of [...hook, scan]) assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      }
    }
  });

test('each NX4-G1 rule is needed: its cases pass without it (NX4-G1)', { skip: gitleaksSkip }, (t) => {
  const f = fixture(t, { gitleaks: 'real' });
  for (const [id, cases] of Object.entries(g1Cases())) {
    const rules = id === 'onfreq-excluded-callsigns-assignment' ? previousCallsignRule(repoRules()) : withoutRule(repoRules(), id);
    commitRules(f, rules);
    const scan = scanCommit(f, cases.map(([line]) => `# synthetic settings\n${line}`).join(''));
    assert.equal(scan.status, 0, `${id}: ${scan.stderr}`);
  }
});

test('the repository Gitleaks rules block quoted userinfo, widened callsign items and FIR prefix properties, redacted (NX4-G1)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const cases of Object.values(g1Cases())) {
      for (const [index, [line, secret, label]] of cases.entries()) {
        const text = `# synthetic settings\n${line}# end\n`;
        // The first case of each rule also goes through pre-commit, directly and as git commit.
        let results = [scanCommit(f, text)];
        if (index === 0) {
          const { hook, scan } = scanAssignment(f, text);
          results = [...hook, scan];
        }
        for (const result of results) {
          assert.equal(result.status, 1, `${label}: ${result.stderr}`);
          if (secret) assert.ok(!(result.stderr + result.stdout).includes(secret), label);
        }
      }
    }
  });

test('the repository Gitleaks rules pass every tracked line naming these settings, and synthetic forms (NX4-G1)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    // The rules file itself, as committed.
    assert.equal(secretScan(f, 'HEAD^!').status, 0);
    const root = fileURLToPath(new URL('..', import.meta.url));
    const grep = spawnSync('git', ['grep', '-h', '-I', '-i', '-E', 'GCA_POLICY_URL|EXCLUDED_CALLSIGNS|FIR_PREFIXES|COORDINATOR_NAME'],
      { cwd: root, env: gitEnv(), encoding: 'utf8' });
    assert.equal(grep.status, 0, grep.stderr);
    const tracked = grep.stdout;
    for (const name of [firPrefixes, callsignsName, policyUrlName, coordinatorName]) assert.ok(tracked.includes(`${name}: '`), name);
    const address = ['owner', 'example.test'].join('@');
    const jd = jPrefix('D');
    const text = tracked
      // Q and X prefixes are synthetic, and a quoted list whose first item is one passes.
      + `  ${firPrefixes}: 'XD',\n"${firPrefixes}": "QC, QE"\n$env:${firPrefixes} = "XA"\n      - ${firPrefixes}=QC\n`
      + `env ${firPrefixes}=QC,XA npm test\nA=1 ${firPrefixes}=xd\n  ${firPrefixes}: QC, XA # note\n`
      + `  ${firPrefixes}: 'XD, ${jd}',\n`
      // Code and lowercase dotenv names.
      + `  ${firPrefixes}: prefixes,\n  ${firPrefixes}: JSON.parse(raw),\n  ${firPrefixes}: env.${firPrefixes},\n`
      + `${firPrefixes.toLowerCase()}=${jd}\n`
      // Synthetic callsigns after Unicode spaces.
      + `${callsignsName}='\u00a0QCXX_CTR'\n${callsignsName}=\ufeffQCXX_CTR,QCXX_APP\n`
      // A reserved policy link followed by a quote, then a field or comment holding an address.
      + `{"${policyUrlName}": "https://example.test/gca", "contact": "${address}"}\n`
      + `{"${policyUrlName}":"https://example.test","contact":"${address}"}\n`
      + `${policyUrlName}=https://example.test/gca # owner ${address}\n`
      + `${policyUrlName}="https://example.test" # ${address}\n`;
    const { hook, scan } = scanAssignment(f, text);
    for (const result of [...hook, scan]) assert.equal(result.status, 0, result.stderr);
  });
