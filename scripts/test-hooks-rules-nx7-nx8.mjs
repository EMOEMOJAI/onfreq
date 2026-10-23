// Real-Gitleaks tests of the NX-7 and NX-8 changes to the repository rules in
// .gitleaks.toml: each blocks or passes its cases and is needed. The shared
// fixtures and helpers are in scripts/hook-test-helpers.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gitleaksSkip, fixture, repoRules, commitRules, scanAssignment, callsignRegexNx7, callsignAllowNx7, callsignRegexNx8,
  callsignAllowNx8, callsignRule, quotedJoinRule, editRule, settingsText, withoutRule, scanCommit, nx7Texts, as2210,
  nx7Cases, nx8Cases,
} from './hook-test-helpers.mjs';

test('the repository Gitleaks rules block NX-7 callsign, coordinator name and FIR prefix forms, redacted (NX-7)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const [line, secret, label] of nx7Cases().block) {
      const { hook, scan } = scanAssignment(f, settingsText(line));
      for (const result of [...hook, scan]) {
        assert.equal(result.status, 1, `${label}: ${result.stderr}`);
        for (const text of [secret].flat()) {
          if (text) assert.ok(!(result.stderr + result.stdout).includes(text), `${label}: ${text.length} characters shown`);
        }
      }
    }
  });

test('the repository Gitleaks rules pass NX-7 synthetic, quoted, code and Markdown forms (NX-7)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const [line, label] of nx7Cases().pass) {
      const { hook, scan } = scanAssignment(f, settingsText(line));
      for (const result of [...hook, scan]) assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    }
  });

test('each NX-7 rule change is needed: its cases pass with the 2.2.10 rule texts (NX-7)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const { block } = nx7Cases();
    for (const id of Object.keys(nx7Texts)) {
      const needed = block.filter(([, , , ids]) => ids.length === 1 && ids[0] === id);
      assert.ok(needed.length > 0, id);
      commitRules(f, as2210([id]));
      const scan = scanCommit(f, needed.map(([line]) => settingsText(line)).join(''));
      assert.equal(scan.status, 0, `${id} as in 2.2.10: ${scan.stderr}`);
    }
    // A case that several rules flag passes only with all of them as in 2.2.10.
    for (const [line, , label, ids] of block.filter((item) => item[3].length > 1)) {
      commitRules(f, as2210(ids));
      assert.equal(scanCommit(f, settingsText(line)).status, 0, `${label}: all as in 2.2.10`);
      for (const id of ids) {
        commitRules(f, as2210(ids.filter((other) => other !== id)));
        assert.equal(scanCommit(f, settingsText(line)).status, 1, `${label}: only ${id} current`);
      }
    }
    // Cases Gitleaks already flagged stay flagged with every rule as in 2.2.10.
    commitRules(f, as2210(Object.keys(nx7Texts)));
    for (const [line, , label] of block.filter((item) => !item[3].length)) {
      assert.equal(scanCommit(f, settingsText(line)).status, 1, label);
    }
  });

test('the repository Gitleaks rules block NX-8 callsign lists with empty or joined quotes, redacted (NX-8)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const [line, secret, label] of nx8Cases().block) {
      const { hook, scan } = scanAssignment(f, settingsText(line));
      for (const result of [...hook, scan]) {
        assert.equal(result.status, 1, `${label}: ${result.stderr}`);
        assert.ok(!(result.stderr + result.stdout).includes(secret), `${label}: ${secret.length} characters shown`);
      }
    }
  });

test('the repository Gitleaks rules pass NX-8 synthetic lists and JSON, TypeScript and array forms (NX-8)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const [line, label] of nx8Cases().pass) {
      const { hook, scan } = scanAssignment(f, settingsText(line));
      for (const result of [...hook, scan]) assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    }
  });

test('each NX-8 callsign change is needed: its cases pass with the 2.2.11 texts or without the quoted-join rule (NX-8)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const { block, pass } = nx8Cases();
    const [widened, joined] = ['regex', 'join'].map((need) => block.filter((item) => item[3] === need));
    const needsAllow = pass.filter((item) => item[2]);
    assert.ok(widened.length && joined.length && needsAllow.length);
    const text = (cases) => cases.map(([line]) => settingsText(line)).join('');
    // Without the quoted-join rule: the callsign rule alone blocks each A1 case, and the A2 cases pass.
    commitRules(f, withoutRule(repoRules(), quotedJoinRule));
    for (const [line, , label] of widened) assert.equal(scanCommit(f, settingsText(line)).status, 1, `${label}: callsign rule alone`);
    let scan = scanCommit(f, text(joined));
    assert.equal(scan.status, 0, `quoted-join rule removed: ${scan.stderr}`);
    // The callsign rule's 2.2.11 regex, alone and with its 2.2.11 allowlist (each edit also removes the quoted-join rule).
    const regex2211 = ['regex', callsignRegexNx8, callsignRegexNx7];
    const allow2211 = ['regexes', callsignAllowNx8, callsignAllowNx7];
    for (const edits of [[regex2211], [regex2211, allow2211]]) {
      commitRules(f, editRule(repoRules(), callsignRule, edits));
      scan = scanCommit(f, text(widened));
      assert.equal(scan.status, 0, `${edits.map(([key]) => key).join(' and ')} as in 2.2.11: ${scan.stderr}`);
    }
    // The NX-8 regex with the 2.2.11 allowlist flags synthetic lists with empty quotes.
    commitRules(f, editRule(repoRules(), callsignRule, [allow2211]));
    for (const [line, label] of needsAllow) assert.equal(scanCommit(f, settingsText(line)).status, 1, `${label}: 2.2.11 allowlist`);
  });
