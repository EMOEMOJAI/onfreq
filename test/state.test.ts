import { describe, expect, it } from 'vitest';
import { diffState, newestCardedSession } from '../src/state';
import type { OnlineAtc, StateMap, TrackedAtc } from '../src/types';

const NOW = '2026-08-16T12:00:00.000Z';
const EARLIER = '2026-08-16T10:30:00.000Z';

function atc(callsign: string, overrides: Partial<OnlineAtc> = {}): OnlineAtc {
  return {
    sessionId: 1,
    userId: 100,
    callsign,
    frequency: 118.8,
    position: 'TWR',
    station: 'Test Tower',
    location: 'Test Airport',
    ...overrides,
  };
}

function tracked(callsign: string, overrides: Partial<TrackedAtc> = {}): TrackedAtc {
  return { ...atc(callsign), since: EARLIER, missed: 0, ...overrides };
}

describe('diffState', () => {
  it('reports a new callsign as online', () => {
    const result = diffState({}, [atc('QCTT_TWR')], NOW, 2);
    expect(result.wentOnline.map((a) => a.callsign)).toEqual(['QCTT_TWR']);
    expect(result.wentOffline).toEqual([]);
    expect(result.next['QCTT_TWR']).toMatchObject({ since: NOW, missed: 0 });
    expect(result.changed).toBe(true);
  });

  it('is quiet and unchanged when the same callsign stays online', () => {
    const prev: StateMap = { QCTT_TWR: tracked('QCTT_TWR') };
    const result = diffState(prev, [atc('QCTT_TWR')], NOW, 2);
    expect(result.wentOnline).toEqual([]);
    expect(result.wentOffline).toEqual([]);
    expect(result.next['QCTT_TWR']?.since).toBe(EARLIER);
    expect(result.changed).toBe(false);
  });

  it('keeps a missing callsign during the grace window without notifying', () => {
    const prev: StateMap = { QESS_APP: tracked('QESS_APP') };
    const result = diffState(prev, [], NOW, 2);
    expect(result.wentOffline).toEqual([]);
    expect(result.next['QESS_APP']).toMatchObject({ missed: 1, missingSince: NOW });
    expect(result.changed).toBe(true);
  });

  it('ends the session at the first missed poll, not the grace expiry', () => {
    const firstMiss = '2026-08-16T11:59:00.000Z';
    const prev: StateMap = {
      QESS_APP: tracked('QESS_APP', { missed: 1, missingSince: firstMiss }),
    };
    const result = diffState(prev, [], NOW, 2);
    expect(result.wentOffline[0]).toMatchObject({
      endedAt: firstMiss,
      durationSeconds: 5340, // 10:30 -> 11:59, the grace minute excluded
    });
  });

  it('carries the posted message refs into the offline event', () => {
    const messages = [{ channelId: '1', messageId: '2' }];
    const prev: StateMap = { QESS_APP: tracked('QESS_APP', { missed: 1, messages }) };
    const result = diffState(prev, [], NOW, 2);
    expect(result.wentOffline[0]?.messages).toEqual(messages);
  });

  it('preserves message refs and clears missingSince when a session resumes', () => {
    const messages = [{ channelId: '1', messageId: '2' }];
    const prev: StateMap = {
      QESS_APP: tracked('QESS_APP', { missed: 1, missingSince: NOW, messages }),
    };
    const result = diffState(prev, [atc('QESS_APP')], NOW, 2);
    expect(result.wentOnline).toEqual([]);
    expect(result.next['QESS_APP']?.messages).toEqual(messages);
    expect(result.next['QESS_APP']).not.toHaveProperty('missingSince');
  });

  it('reports offline once the grace window is exhausted', () => {
    const prev: StateMap = { QESS_APP: tracked('QESS_APP', { missed: 1 }) };
    const result = diffState(prev, [], NOW, 2);
    expect(result.wentOffline).toHaveLength(1);
    expect(result.wentOffline[0]).toMatchObject({
      callsign: 'QESS_APP',
      durationSeconds: 5400, // 10:30 -> 12:00
    });
    expect(result.next['QESS_APP']).toBeUndefined();
    expect(result.changed).toBe(true);
  });

  it('reports offline immediately with a grace of 1', () => {
    const prev: StateMap = { XAHH_TWR: tracked('XAHH_TWR') };
    const result = diffState(prev, [], NOW, 1);
    expect(result.wentOffline.map((a) => a.callsign)).toEqual(['XAHH_TWR']);
  });

  it('resumes silently when a callsign reappears within the grace window', () => {
    const prev: StateMap = { QKPD_GND: tracked('QKPD_GND', { missed: 1 }) };
    const result = diffState(prev, [atc('QKPD_GND', { sessionId: 99 })], NOW, 2);
    expect(result.wentOnline).toEqual([]);
    expect(result.wentOffline).toEqual([]);
    expect(result.next['QKPD_GND']).toMatchObject({
      since: EARLIER, // original start preserved
      missed: 0,
      sessionId: 99, // refreshed session data
    });
    expect(result.changed).toBe(true);
  });

  it('handles simultaneous online and offline transitions', () => {
    const prev: StateMap = { QFTP_TWR: tracked('QFTP_TWR', { missed: 1 }) };
    const result = diffState(prev, [atc('QGLL_APP')], NOW, 2);
    expect(result.wentOnline.map((a) => a.callsign)).toEqual(['QGLL_APP']);
    expect(result.wentOffline.map((a) => a.callsign)).toEqual(['QFTP_TWR']);
    expect(Object.keys(result.next)).toEqual(['QGLL_APP']);
  });

  it('holds back a controller the feed reports at 0.000 MHz', () => {
    const result = diffState({}, [atc('QCTT_TWR', { frequency: 0 })], NOW, 2);
    expect(result.wentOnline).toEqual([]);
    expect(result.pending).toEqual(['QCTT_TWR']);
    // Tracked anyway, so the start time is when it actually connected.
    expect(result.next['QCTT_TWR']).toMatchObject({ since: NOW, pending: true });
  });

  it('announces a held-back controller once the frequency lands, dated from connect', () => {
    const prev: StateMap = {
      QCTT_TWR: tracked('QCTT_TWR', { frequency: 0, pending: true }),
    };
    const result = diffState(prev, [atc('QCTT_TWR', { frequency: 118.1 })], NOW, 2);
    expect(result.wentOnline.map((a) => a.callsign)).toEqual(['QCTT_TWR']);
    expect(result.wentOnline[0]).toMatchObject({ frequency: 118.1, since: EARLIER });
    expect(result.next['QCTT_TWR']).not.toHaveProperty('pending');
    expect(result.pending).toEqual([]);
  });

  it('keeps holding back while the frequency stays 0.000', () => {
    const prev: StateMap = {
      QCTT_TWR: tracked('QCTT_TWR', { frequency: 0, pending: true }),
    };
    const result = diffState(prev, [atc('QCTT_TWR', { frequency: 0 })], NOW, 2);
    expect(result.wentOnline).toEqual([]);
    expect(result.next['QCTT_TWR']).toMatchObject({ pending: true, since: EARLIER });
  });

  it('never sends an offline card for a controller that was never announced', () => {
    const prev: StateMap = {
      QCTT_TWR: tracked('QCTT_TWR', { frequency: 0, pending: true, missed: 1 }),
    };
    const result = diffState(prev, [], NOW, 2);
    expect(result.wentOffline).toEqual([]);
    expect(result.next['QCTT_TWR']).toBeUndefined();
    expect(result.changed).toBe(true);
  });

  it('keeps the last known frequency when an announced session blips to 0.000', () => {
    const prev: StateMap = { QCTT_TWR: tracked('QCTT_TWR', { frequency: 118.1 }) };
    const result = diffState(prev, [atc('QCTT_TWR', { frequency: 0 })], NOW, 2);
    expect(result.wentOnline).toEqual([]);
    expect(result.wentOffline).toEqual([]);
    expect(result.next['QCTT_TWR']?.frequency).toBe(118.1);
    expect(result.pending).toEqual([]);
  });

  it('never reports a negative duration', () => {
    const prev: StateMap = {
      QHTS_TWR: tracked('QHTS_TWR', { since: '2026-08-16T13:00:00.000Z', missed: 1 }),
    };
    const result = diffState(prev, [], NOW, 2);
    expect(result.wentOffline[0]?.durationSeconds).toBe(0);
  });
});

describe('newestCardedSession', () => {
  const card = [{ channelId: '1', messageId: '2' }];

  it('returns undefined when nothing is tracked', () => {
    expect(newestCardedSession({})).toBeUndefined();
  });

  it('picks the most recently carded session', () => {
    const state: StateMap = {
      QCTT_GND: tracked('QCTT_GND', { messages: card, cardAt: '2026-08-18T10:00:00.000Z' }),
      QESS_APP: tracked('QESS_APP', { messages: card, cardAt: '2026-08-18T11:00:00.000Z' }),
      QGLL_TWR: tracked('QGLL_TWR', { messages: card, cardAt: '2026-08-18T09:00:00.000Z' }),
    };
    expect(newestCardedSession(state)).toBe('QESS_APP');
  });

  it('falls back to the connect time for sessions carded before cardAt existed', () => {
    const state: StateMap = {
      OLD_ONE: tracked('OLD_ONE', { messages: card, since: '2026-08-18T08:00:00.000Z' }),
      NEW_ONE: tracked('NEW_ONE', { messages: card, since: '2026-08-18T12:00:00.000Z' }),
    };
    expect(newestCardedSession(state)).toBe('NEW_ONE');
  });

  it('prefers cardAt over since, so a held-back session is ordered by its card', () => {
    const state: StateMap = {
      // Connected first but held back awaiting a frequency, so carded later.
      HELD_BACK: tracked('HELD_BACK', {
        messages: card,
        since: '2026-08-18T10:00:00.000Z',
        cardAt: '2026-08-18T10:05:00.000Z',
      }),
      STRAIGHT: tracked('STRAIGHT', {
        messages: card,
        since: '2026-08-18T10:02:00.000Z',
        cardAt: '2026-08-18T10:02:00.000Z',
      }),
    };
    expect(newestCardedSession(state)).toBe('HELD_BACK');
  });

  it('ignores sessions that have no card to host the roster', () => {
    const state: StateMap = {
      NO_CARD: tracked('NO_CARD', { cardAt: '2026-08-18T12:00:00.000Z' }),
      HAS_CARD: tracked('HAS_CARD', { messages: card, cardAt: '2026-08-18T09:00:00.000Z' }),
    };
    expect(newestCardedSession(state)).toBe('HAS_CARD');
  });

  it('ignores sessions still waiting for a frequency', () => {
    const state: StateMap = {
      PENDING: tracked('PENDING', {
        messages: card,
        pending: true,
        cardAt: '2026-08-18T12:00:00.000Z',
      }),
      ANNOUNCED: tracked('ANNOUNCED', { messages: card, cardAt: '2026-08-18T09:00:00.000Z' }),
    };
    expect(newestCardedSession(state)).toBe('ANNOUNCED');
  });
});
