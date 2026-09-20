import { describe, expect, it } from 'vitest';
import { extractBearer, secretsMatch } from '../src/auth';

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
