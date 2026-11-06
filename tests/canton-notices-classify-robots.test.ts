import { describe, expect, it } from 'vitest';
import { classifyNotice, isExcludedTitle } from '../scripts/lib/canton-notices-classify.mjs';
import { aiInputBlock, isAllowed, parseRobotsTxt, robotsFromResponse } from '../scripts/lib/robots-policy.mjs';

describe('classifyNotice', () => {
  const multi = { fixedCategory: null, categories: ['servizi', 'mobilita', 'fisco', 'pensioni'] };

  it('fonte di categoria: la categoria e\' quella della fonte, senza parole chiave', () => {
    expect(classifyNotice({ title: 'Jahresbericht 2025' }, { fixedCategory: 'pensioni', categories: ['pensioni'] })).toBe('pensioni');
  });

  it('fonte generalista: decide il titolo, solo fra i temi dichiarati', () => {
    expect(classifyNotice({ title: 'Quellensteuertarife 2026 publiziert' }, multi)).toBe('fisco');
    expect(classifyNotice({ title: 'Neubau der Bushaltestelle Zürichstrasse Nord' }, multi)).toBe('mobilita');
    expect(classifyNotice({ title: '13. AHV-Rente ab Dezember 2026' }, multi)).toBe('pensioni');
    expect(classifyNotice({ title: 'Primes d’assurance-maladie 2027' }, multi)).toBe('servizi');
    // eventi non e' fra i temi dichiarati: un festival non diventa «servizi»
    expect(classifyNotice({ title: 'Festival der Kulturen im Stadtpark' }, multi)).toBeNull();
  });

  it('un titolo che non tocca nessun tema resta fuori invece di finire nel piu\' vicino', () => {
    expect(classifyNotice({ title: 'Residierender Domherr gewählt' }, multi)).toBeNull();
  });

  it('cronaca e offerte di lavoro restano fuori anche con una parola chiave', () => {
    expect(isExcludedTitle('Unfall auf der A1 bei Kölliken')).toBe(true);
    expect(classifyNotice({ title: 'Véhicule intercepté à contresens sur l’A1' }, multi)).toBeNull();
    expect(classifyNotice({ title: 'Brand eines Mehrfamilienhauses in Illnau' }, multi)).toBeNull();
    expect(classifyNotice({ title: 'offene Stelle: Sachbearbeiter/in Steuern (50 %)' }, multi)).toBeNull();
  });

  it('sigle corte solo come parola intera: «Zug» il cantone non e\' un treno, «AVS» si', () => {
    expect(classifyNotice({ title: 'La rente minimale AVS augmentera' }, multi)).toBe('pensioni');
    expect(classifyNotice({ title: 'Zuger Kantonsrat tagt' }, multi)).toBeNull();
  });

  it('be.ch: topicTags strutturati prima delle parole chiave', () => {
    expect(classifyNotice({ title: 'Biel: Umgestaltung des Knotens kommt voran', meta: { topicTags: ['be-themen:strassen'] } }, multi)).toBe('mobilita');
  });

  it('un solo tema dichiarato (ospedale → servizi): fisso, ma senza cronaca', () => {
    const hospital = { fixedCategory: null, categories: ['servizi'] };
    expect(classifyNotice({ title: 'Roboter ROSA unterstützt neu bei Knieprothesen' }, hospital)).toBe('servizi');
    expect(classifyNotice({ title: 'Festnahme nach Körperverletzung' }, hospital)).toBeNull();
  });
});

describe('robots-policy', () => {
  const robots = parseRobotsTxt(`
User-agent: *
Disallow: /route/
Allow: /route/public/
Crawl-delay: 10

User-agent: ClaudeBot
Disallow: /

User-agent: GPTBot
Disallow: /news/
`);

  it('gruppo `*` per il nostro agente, regola piu\' lunga, Allow a parita\'', () => {
    expect(isAllowed(robots, 'frontaliereticinobot', 'https://www.gl.ch/public-newsroom.html/30')).toMatchObject({ allowed: true, crawlDelay: 10 });
    expect(isAllowed(robots, 'frontaliereticinobot', 'https://www.gl.ch/route/rss-rss-getRss')).toMatchObject({ allowed: false });
    expect(isAllowed(robots, 'frontaliereticinobot', 'https://www.gl.ch/route/public/x')).toMatchObject({ allowed: true });
  });

  it('D10: un divieto rivolto a un agente AI di input esclude la fonte anche con un UA onesto', () => {
    expect(aiInputBlock(robots, ['ClaudeBot', 'GPTBot'], 'https://x.ch/aktuell/')).toMatch(/claudebot -> Disallow: \//i);
    const onlyGpt = parseRobotsTxt('User-agent: GPTBot\nDisallow: /news/\n');
    expect(aiInputBlock(onlyGpt, ['ClaudeBot', 'GPTBot'], 'https://x.ch/aktuell/')).toBeNull();
    expect(aiInputBlock(onlyGpt, ['ClaudeBot', 'GPTBot'], 'https://x.ch/news/1')).toMatch(/gptbot/i);
    expect(aiInputBlock(parseRobotsTxt('Content-Signal: search=yes, ai-input=no\nUser-agent: *\nAllow: /'), ['ClaudeBot'], 'https://x.ch/')).toMatch(/ai-input=no/);
  });

  it('RFC 9309: 4xx = nessuna regola, 5xx/rete = tutto vietato, HTML servito con 200 = assente', () => {
    expect(robotsFromResponse(404, '').state).toBe('absent');
    const down = robotsFromResponse(503, '');
    expect(down.state).toBe('unreachable');
    expect(isAllowed(down.parsed, 'frontaliereticinobot', 'https://x.ch/a').allowed).toBe(false);
    expect(robotsFromResponse(200, '<!DOCTYPE html><html>').state).toBe('absent');
  });
});
