import { describe, expect, it } from 'vitest';

import {
  INSTAGRAM_COMMUNITY_TOPIC_MINIMUM,
  classifyInstagramCommunityQuestion,
  instagramCommunityTopicSignalKey,
  normalizeInstagramCommunityTopicSignals,
  summarizeInstagramCommunityQuestionDemand,
} from '../scripts/lib/instagram-community-topics.mjs';

const AS_OF = new Date('2026-11-02T12:00:00.000Z');

describe('privacy-safe Instagram community topic signals', () => {
  it('maps clear public questions into one closed category and discards personal or ambiguous cases', () => {
    expect(classifyInstagramCommunityQuestion('Quali documenti servono per il permesso G?'))
      .toBe('permessi-amministrazione');
    expect(classifyInstagramCommunityQuestion('Wie funktioniert die Krankenkasse?'))
      .toBe('assicurazione-salute');
    expect(classifyInstagramCommunityQuestion('Come funziona il contratto di lavoro?'))
      .toBe('lavoro-contratti');
    expect(classifyInstagramCommunityQuestion('Ho ricevuto una lettera con il mio numero fiscale: cosa faccio?'))
      .toBeNull();
    expect(classifyInstagramCommunityQuestion('Che contratto serve e come dichiaro le tasse?'))
      .toBeNull();
    expect(classifyInstagramCommunityQuestion('Nuova guida sul lavoro oltreconfine'))
      .toBeNull();
    expect(classifyInstagramCommunityQuestion('Dove posso leggere https://example.test sulla pensione?'))
      .toBeNull();
  });

  it('uses Unicode letter boundaries for accented question words and category terms', () => {
    expect(classifyInstagramCommunityQuestion("Où trouver l'école"))
      .toBe('vita-famiglia');
    expect(classifyInstagramCommunityQuestion("\u200bOù trouver l'e\u0301cole"))
      .toBe('vita-famiglia');
    expect(classifyInstagramCommunityQuestion('antécole?'))
      .toBeNull();
    expect(classifyInstagramCommunityQuestion('Dove c\'è traffico?'))
      .toBe('mobilita-valichi');
    expect(classifyInstagramCommunityQuestion('Is there traffic?'))
      .toBe('mobilita-valichi');
    expect(classifyInstagramCommunityQuestion('Is there trafficjam?'))
      .toBeNull();
    expect(classifyInstagramCommunityQuestion('How is ｔｒａｆｆｉｃ?'))
      .toBe('mobilita-valichi');
    expect(classifyInstagramCommunityQuestion('How is traffic\u200bjam?'))
      .toBeNull();
    expect(classifyInstagramCommunityQuestion('How is traffic\u0338?'))
      .toBeNull();
    expect(classifyInstagramCommunityQuestion('How is website traffic?'))
      .toBeNull();
    expect(classifyInstagramCommunityQuestion('How is traffic to a website?'))
      .toBeNull();
    expect(classifyInstagramCommunityQuestion('How much traffic on our website?'))
      .toBeNull();
    expect(classifyInstagramCommunityQuestion('How much traffic to our site?'))
      .toBeNull();
    expect(classifyInstagramCommunityQuestion('How is traffic on the road?'))
      .toBe('mobilita-valichi');
    expect(classifyInstagramCommunityQuestion('How is traffic and tax?'))
      .toBeNull();
    expect(classifyInstagramCommunityQuestion('Dove\u200bma fisco'))
      .toBeNull();
    expect(classifyInstagramCommunityQuestion('no\u200btax?'))
      .toBeNull();
  });

  it('deduplicates hashed comment keys, drops expired/unknown records, and suppresses every category below ten', () => {
    const lowVolume = Array.from({ length: INSTAGRAM_COMMUNITY_TOPIC_MINIMUM - 1 }, (_, index) => ({
      key: instagramCommunityTopicSignalKey(`comment-${index}`),
      category: 'permessi-amministrazione',
      receivedAt: '2026-11-01T10:00:00.000Z',
    }));
    const suppressed = summarizeInstagramCommunityQuestionDemand(lowVolume, { asOf: AS_OF });
    expect(suppressed).toMatchObject({ status: 'suppressed', categories: [] });

    const signals = [
      ...lowVolume,
      { ...lowVolume[0] },
      {
        key: instagramCommunityTopicSignalKey('old-comment'),
        category: 'permessi-amministrazione',
        receivedAt: '2026-09-01T10:00:00.000Z',
      },
      {
        key: 'not-a-hash',
        category: 'permessi-amministrazione',
        receivedAt: '2026-11-01T10:00:00.000Z',
      },
    ];
    const normalized = normalizeInstagramCommunityTopicSignals(signals, { asOf: AS_OF });
    expect(normalized).toHaveLength(INSTAGRAM_COMMUNITY_TOPIC_MINIMUM - 1);
    expect(summarizeInstagramCommunityQuestionDemand(normalized, { asOf: AS_OF }))
      .toMatchObject({ status: 'suppressed', categories: [] });
  });

  it('emits only count bands after ten distinct comments and never includes text or keys', () => {
    const signals = Array.from({ length: 12 }, (_, index) => ({
      key: instagramCommunityTopicSignalKey(`comment-${index}`),
      category: 'permessi-amministrazione',
      receivedAt: new Date(AS_OF.getTime() - index * 60_000).toISOString(),
    }));
    const summary = summarizeInstagramCommunityQuestionDemand(signals, { asOf: AS_OF });
    expect(summary).toMatchObject({
      status: 'available',
      source: 'public-instagram-comments-local-closed-taxonomy',
      categories: [{ category: 'permessi-amministrazione', countBand: '10-24' }],
    });
    expect(JSON.stringify(summary)).not.toContain('comment-0');
    expect(JSON.stringify(summary)).not.toContain('Quali documenti servono');
  });
});
