import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configuredSecret, extractBearer, logConfigInvalidOnce, MIN_SECRET_LENGTH, resetConfigInvalidLogForTests, secretsMatch,
} from '../src/auth';

describe('extractBearer', () => {
  it('reads the token from a Bearer header', () => {
    expect(extractBearer('Bearer abc123')).toBe('abc123');
    expect(extractBearer('bearer abc123')).toBe('abc123');
    expect(extractBearer('  Bearer   abc123  ')).toBe('abc123');
  });

  it('returns an empty string for anything else', () => {
    expect(extractBearer(null)).toBe('');
    expect(extractBearer('')).toBe('');
    expect(extractBearer('Basic abc123')).toBe('');
    expect(extractBearer('abc123')).toBe('');
    expect(extractBearer('Bearer')).toBe('');
  });
});

describe('secretsMatch', () => {
  it('accepts the exact secret', async () => {
    await expect(secretsMatch('s3cret-value', 's3cret-value')).resolves.toBe(true);
  });

  it('rejects a wrong secret', async () => {
    await expect(secretsMatch('s3cret-valuf', 's3cret-value')).resolves.toBe(false);
    await expect(secretsMatch('', 's3cret-value')).resolves.toBe(false);
  });

  it('rejects a prefix of the real secret', async () => {
    await expect(secretsMatch('s3cret', 's3cret-value')).resolves.toBe(false);
    await expect(secretsMatch('s3cret-value-extra', 's3cret-value')).resolves.toBe(false);
  });

  it('never authorises when no secret is configured', async () => {
    await expect(secretsMatch('', '')).resolves.toBe(false);
    await expect(secretsMatch('anything', '')).resolves.toBe(false);
  });
});

describe('configuredSecret', () => {
  beforeEach(resetConfigInvalidLogForTests);
  afterEach(() => vi.restoreAllMocks());

  it('treats a secret shorter than 32 characters as unset and logs only its name', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const weak = `  ${'w'.repeat(MIN_SECRET_LENGTH - 1)}  `;
    expect(MIN_SECRET_LENGTH).toBe(32);
    expect(configuredSecret('a', 'POLL_SECRET')).toBe('');
    expect(configuredSecret(weak, 'HISTORY_SECRET')).toBe('');
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { event: 'config_invalid', reason: 'POLL_SECRET_too_short' },
      { event: 'config_invalid', reason: 'HISTORY_SECRET_too_short' },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('w'.repeat(MIN_SECRET_LENGTH - 1));
  });

  it('S8-3: logs each invalid secret name at most once per isolate', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 5; i++) {
      expect(configuredSecret('short', 'POLL_SECRET')).toBe('');
      expect(configuredSecret('also-short', 'HISTORY_SECRET')).toBe('');
    }
    logConfigInvalidOnce('HISTORY_SECRET_reuses_POLL_SECRET');
    logConfigInvalidOnce('HISTORY_SECRET_reuses_POLL_SECRET');
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { event: 'config_invalid', reason: 'POLL_SECRET_too_short' },
      { event: 'config_invalid', reason: 'HISTORY_SECRET_too_short' },
      { event: 'config_invalid', reason: 'HISTORY_SECRET_reuses_POLL_SECRET' },
    ]);
    resetConfigInvalidLogForTests();
    configuredSecret('short', 'POLL_SECRET');
    expect(log).toHaveBeenCalledTimes(4);
  });

  it('accepts a trimmed secret of at least 32 characters', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret = 's'.repeat(MIN_SECRET_LENGTH);
    expect(configuredSecret(` ${secret}\n`, 'POLL_SECRET')).toBe(secret);
    expect(log).not.toHaveBeenCalled();
  });

  it('returns empty without logging when the secret is unset', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(configuredSecret(undefined, 'HISTORY_SECRET')).toBe('');
    expect(configuredSecret('   ', 'HISTORY_SECRET')).toBe('');
    expect(log).not.toHaveBeenCalled();
  });
});
