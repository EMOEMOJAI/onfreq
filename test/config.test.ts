import { describe, expect, it } from 'vitest';
import { firOf, parseFirLabels } from '../src/config';
import { buildOnlineEmbed } from '../src/discord';
import type { TrackedAtc } from '../src/types';

describe('private display configuration', () => {
  it('uses neutral labels with no configured geography', () => {
    expect(parseFirLabels(undefined)).toEqual([]);
    expect(parseFirLabels('')).toEqual([]);
    expect(parseFirLabels('[]')).toEqual([]);
    expect(firOf('XAAA_APP')).toEqual({ flag: '🌐', name: 'Other' });
  });

  it('keeps different operators independent, without shared mutable defaults', () => {
    const first = parseFirLabels('[{"prefixes":["XA"],"flag":"🌐","name":"First"}]');
    const second = parseFirLabels('[{"prefixes":["XA"],"flag":"🇦🇺","name":"Second"}]');
    expect(firOf('xaaa_APP', first)).toEqual({ flag: '🌐', name: 'First' });
    expect(firOf('XAAA_APP', second)).toEqual({ flag: '🇦🇺', name: 'Second' });
    expect(firOf('XAAA_APP')).toEqual({ flag: '🌐', name: 'Other' });
    expect(firOf('XBBB_APP', first)).toEqual({ flag: '🌐', name: 'Other' });
  });

  it.each([
    'not json', '{}', '[null]', '[[]]',
    '[{"prefixes":[],"flag":"🌐","name":"Example"}]',
    '[{"prefixes":["xa"],"flag":"🌐","name":"Example"}]',
    '[{"prefixes":["XA"],"flag":"<@123>","name":"Example"}]',
    '[{"prefixes":["XA"],"flag":"🌐","name":"```"}]',
    '[{"prefixes":["XA"],"flag":"🌐","name":"More than twelve characters"}]',
    '[{"prefixes":["XA"],"flag":"🌐","name":""}]',
    '[{"prefixes":["XA","XA"],"flag":"🌐","name":"Example"}]',
    '[{"prefixes":["XA"],"flag":"🌐","name":"One"},{"prefixes":["X"],"flag":"🌐","name":"Two"}]',
  ])('rejects malformed or ambiguous labels without echoing private input', (raw) => {
    expect(() => parseFirLabels(raw)).toThrow('FIR_LABELS must be a valid, unambiguous label array');
  });

  it('uses airport metadata worldwide even without configured labels', () => {
    const atc: TrackedAtc = {
      callsign: 'XAAA_TWR', sessionId: 1, userId: 600001, frequency: 118.1,
      position: 'TWR', station: null, location: null, since: '2026-09-01T00:00:00Z', missed: 0,
      airport: { icao: 'XAAA', countryId: 'AU' },
    };
    expect(buildOnlineEmbed(atc).title).toContain('🇦🇺');
    expect(buildOnlineEmbed({ ...atc, airport: null }).title).toContain('🌐');
  });
});
