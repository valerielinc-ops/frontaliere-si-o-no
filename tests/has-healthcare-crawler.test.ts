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

  it('survives portal attribute reordering, extra classes, absolute URLs and label drift', () => {
    const html = `
      <section class="job-card has-extra-layout-class">
        <span class="job-title-row text-body">Production Manager</span>
        <time data-source="published" class="datetime">21.11.25</time>
        <span class="main-list-job-percentage rounded-pill">100% full time</span>
        <a class="stretched-link view-posting" target="_self" href="https://www.e-lavoro.ch/node/264">
          <span class="icon main-list-job-button-view">View posting</span>
        </a>
      </section>
    `;

    expect(parseListingPage(html)).toEqual([
      {
        title: 'Production Manager',
        detailUrl: 'https://e-lavoro.ch/node/264',
        percentage: '100% full time',
        dateStr: '21.11.25',
      },
    ]);
  });

  it('falls back to a bounded node link when the portal renames the action classes', () => {
    const html = `
      <div class="job-card">
        <span class="renamed-title-class">Assistente di Produzione</span>
        <a href="/node/276" class="new-action-class">View job</a>
      </div>
      <footer><a href="/node/75">Login</a><a href="/node/76">Published Announcements</a></footer>
    `;

    expect(parseListingPage(html)).toEqual([
      {
        title: 'Assistente di Produzione',
        detailUrl: 'https://e-lavoro.ch/node/276',
        percentage: '',
        dateStr: '',
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
