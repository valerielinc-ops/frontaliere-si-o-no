import { describe, it, expect } from 'vitest';
import { nameTokens, domainMatchesName, extractDdgDomains, guessDomains, rankDomains } from '../scripts/lib/domain-finder.mjs';

describe('nameTokens', () => {
  it('strips legal/stop words + accents, keeps ≥3-char tokens', () => {
    expect(nameTokens('Fondazione La Fonte SA')).toEqual(['fondazione', 'fonte']);
    expect(nameTokens('ALDI SUISSE')).toEqual(['aldi']); // suisse is a stopword
    expect(nameTokens('Rapelli - ORIOR Food AG')).toEqual(['rapelli', 'orior', 'food']);
  });
});

describe('domainMatchesName (rejects directories, keeps real domains)', () => {
  it('matches when label shares a name token', () => {
    expect(domainMatchesName('lafonte.ch', 'Fondazione La Fonte')).toBe(true);
    expect(domainMatchesName('aldi-suisse.ch', 'ALDI SUISSE')).toBe(true);
    expect(domainMatchesName('eoc.ch', 'EOC Ente Ospedaliero Cantonale')).toBe(true);
    expect(domainMatchesName('rapelli.ch', 'Rapelli ORIOR')).toBe(true);
  });
  it('rejects unrelated directory domains', () => {
    expect(domainMatchesName('yellowpages.swiss', 'Ticino Premium Properties')).toBe(false);
    expect(domainMatchesName('help.ch', 'Ticino Premium Properties')).toBe(false);
  });
});

describe('extractDdgDomains', () => {
  it('parses uddg result links to apex domains, filters social/directories', () => {
    const html = `
      <a href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://www.lafonte.ch/chi-siamo')}">x</a>
      <a href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://linkedin.com/company/lafonte')}">y</a>
      <a href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://yellowpages.swiss/lafonte')}">z</a>`;
    expect(extractDdgDomains(html)).toEqual(['lafonte.ch']); // linkedin + yellowpages dropped
  });
});

describe('guessDomains', () => {
  it('produces slug.ch/.com + acronym.ch', () => {
    expect(guessDomains('USI Università della Svizzera italiana')).toContain('usi.ch');
    expect(guessDomains('Rapelli AG')).toEqual(expect.arrayContaining(['rapelli.ch', 'rapelli.com']));
  });
});

describe('rankDomains', () => {
  it('keeps only name-matching, prefers .ch then shorter label', () => {
    expect(rankDomains(['coop.it', 'coop.ch', 'help.ch'], 'Coop')).toEqual(['coop.ch', 'coop.it']);
    expect(rankDomains(['yellowpages.swiss'], 'Ticino Premium Properties')).toEqual([]);
  });
});
