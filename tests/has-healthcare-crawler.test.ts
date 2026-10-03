import { describe, expect, it } from 'vitest';

import {
  classifyHasHealthcareDiscovery,
  parseListingPage,
} from '../scripts/update-has-healthcare-jobs.mjs';

describe('HAS Healthcare crawler discovery', () => {
  it('parses the e-lavoro listing card shape', () => {
    const html = `
      <div class="job-card">
        <span class="job-title-row">Assistente di Produzione</span>
        <span class="rounded-pill main-list-job-percentage">100%</span>
        <time class="datetime">01.07.26</time>
        <a href="/node/276" target="_self" class="w-100 p-3">
          <span class="main-list-job-button-view">Visualizza annuncio</span>
        </a>
      </div>
    `;

    expect(parseListingPage(html)).toEqual([
      {
        title: 'Assistente di Produzione',
        detailUrl: 'https://e-lavoro.ch/node/276',
        percentage: '100%',
        dateStr: '01.07.26',
      },
    ]);
  });

  it('records a listing transport failure instead of an unexplained empty source', () => {
    expect(classifyHasHealthcareDiscovery({ listingFetchOutcome: 'connection_error' })).toEqual({
      lastFetchOutcome: 'connection_error',
      abortKind: 'connection-level-fetch',
    });
  });

  it('records a repeated detail transport failure when every discovered detail fails', () => {
    expect(classifyHasHealthcareDiscovery({
      discovered: 2,
      parsed: 0,
      detailFetchOutcomes: ['exhausted_retry', 'exhausted_retry'],
    })).toEqual({
      lastFetchOutcome: 'exhausted_retry',
      abortKind: 'connection-level-fetch',
    });
  });

  it('aborts a partial detail run before stale HAS rows can be pruned', () => {
    expect(classifyHasHealthcareDiscovery({
      discovered: 2,
      parsed: 1,
      detailFetchOutcomes: ['connection_error'],
    })).toEqual({
      lastFetchOutcome: 'connection_error',
      abortKind: 'connection-level-fetch',
    });
  });

  it('keeps parser misses distinct from transport failures', () => {
    expect(classifyHasHealthcareDiscovery({ discovered: 1, parsed: 0 })).toEqual({
      lastFetchOutcome: 'selector_miss',
      abortKind: 'no-jobs-parsed',
    });
  });

  it('marks a run with publishable jobs as successful', () => {
    expect(classifyHasHealthcareDiscovery({ discovered: 1, parsed: 1 })).toEqual({
      lastFetchOutcome: 'ok',
      abortKind: null,
    });
  });
});
