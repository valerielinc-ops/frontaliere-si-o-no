import { describe, it, expect } from 'vitest';
import {
  IPERSONAL_KEY,
  IPERSONAL_COMPANY_NAME,
  isIpersonalJob,
  isTrustedDomain,
} from '../scripts/lib/ipersonal-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import {
  assertCompleteIpersonalSnapshot,
  extractIpersonalDescription,
  getVerifiedIpersonalGeography,
  runIpersonalSpecInProduction,
} from '../scripts/lib/ipersonal-spec-runtime.mjs';

describe('iPersonal AG crawler parser', () => {
  describe('shared Simple Job Board detail boundary', () => {
    it('preserves legacy arrow lists and stops before application boilerplate', () => {
      const html = `
        <nav>Navigation noise</nav>
        <section class="job-profile-section"><div id="Jobdetails">
          <h2>Dipl. Pflegefachperson Spiez</h2>
          <p>Du betreust Patientinnen und Patienten in einem professionellen Pflegeteam.</p>
          <h3>Deine Aufgaben</h3>
          <p>› Pflege planen und dokumentieren› Angehörige kompetent beraten</p>
          <h3>Kontakt und Bewerbung</h3>
          <p>Lebenslauf hochladen und info@example.test kontaktieren.</p>
        </div></section>
        <form id="sjb-application-form">Formularfelder</form>`;

      const description = extractIpersonalDescription(html);
      expect(description).toContain('\n• Pflege planen und dokumentieren');
      expect(description).toContain('\n• Angehörige kompetent beraten');
      expect(description).not.toContain('Navigation noise');
      expect(description).not.toContain('Lebenslauf hochladen');
      expect(description).not.toContain('Formularfelder');
    });

    it('fails closed when the authoritative detail boundary is absent', () => {
      expect(extractIpersonalDescription('<main><p>Generic page copy</p></main>')).toBe('');
    });

    it('keeps nested legacy content and recovers paragraph-backed lists', () => {
      const html = `
        <section class="job-profile-section"><div id="Jobdetails"><div>
          <p>Wir suchen eine erfahrene Fachperson für einen langfristigen Einsatz.</p>
          <h3>Deine Aufgaben</h3>
          <p>Patientinnen und Patienten fachgerecht betreuen und dokumentieren.</p>
          <p>Das interdisziplinäre Team im Alltag zuverlässig unterstützen.</p>
          <h3>Jetzt bewerben</h3><p>Wiederholter Bewerbungstext.</p>
        </div><p>Keyword- und Kontakttail.</p></div></section>`;

      const description = extractIpersonalDescription(html);
      expect(description).toContain('\n• Patientinnen und Patienten');
      expect(description).toContain('\n• Das interdisziplinäre Team');
      expect(description).not.toContain('Wiederholter Bewerbungstext');
      expect(description).not.toContain('Keyword- und Kontakttail');
    });

    it('recognizes paragraph-only section headings and application boundaries', () => {
      const html = `
        <section class="job-profile-section"><div id="Jobdetails"><div>
          <p>Eine verantwortungsvolle Aufgabe in der Intensivpflege mit langfristiger fachlicher Begleitung.</p>
          <p>Deine Aufgaben im Intensivalltag</p>
          <p>Patientinnen sicher betreuen und Veränderungen rechtzeitig erkennen.</p>
          <p>Die Behandlung mit dem interdisziplinären Team sorgfältig abstimmen.</p>
          <p>Das bringst du mit</p>
          <p>Mehrjährige Berufserfahrung und eine anerkannte Weiterbildung.</p>
          <p>Das erwartet dich</p>
          <p>Ein unterstützendes Team und verlässliche Entwicklungsmöglichkeiten.</p>
          <p>Interessiert?</p>
          <p>Lebenslauf und Zeugnisse per E-Mail senden.</p>
          <p>Keyword- und Kontakttail für Suchmaschinen.</p>
        </div></div></section>`;

      const description = extractIpersonalDescription(html);
      expect(description).toContain('\n• Patientinnen sicher betreuen');
      expect(description).toContain('\n• Die Behandlung mit dem interdisziplinären Team');
      expect(description).toContain('\n• Mehrjährige Berufserfahrung');
      expect(description).toContain('\n• Ein unterstützendes Team');
      expect(description).not.toContain('Interessiert?');
      expect(description).not.toContain('Lebenslauf und Zeugnisse');
      expect(description).not.toContain('Keyword- und Kontakttail');
    });

    it('requests identity encoding and stays idempotent on the shared runtime', async () => {
      const seedUrl = 'https://ipersonal-fixture.example/';
      const detailUrl = `${seedUrl}jobs/pflegefachperson-zuerich/`;
      const acceptedEncodings: string[] = [];
      const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
        acceptedEncodings.push(new Headers(init.headers).get('Accept-Encoding') || '');
        const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (url === seedUrl) {
          return new Response(`<a href="${detailUrl}">Pflegefachperson Zürich</a>`, {
            status: 200, headers: { 'Content-Type': 'text/html' },
          });
        }
        const escapedLocalitySchema = JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'JobPosting',
            title: 'Pflegefachperson Zürich',
            url: detailUrl,
            description: 'Eine langfristige Aufgabe in einem professionellen Team mit persönlicher Begleitung und klarer fachlicher Verantwortung im Pflegealltag.',
            jobLocation: {
              '@type': 'Place',
              address: {
                '@type': 'PostalAddress', addressLocality: 'Züberwangen', addressRegion: 'St. Gallen',
                addressCountry: 'CH', postalCode: '9523',
              },
            },
          }).replace('Züberwangen', 'Z\\u00fcberwangen');
        return new Response(`
          <script type="application/ld+json">${escapedLocalitySchema}</script>
          <section class="job-profile-section"><div id="Jobdetails">
            <p>Eine langfristige Aufgabe in einem professionellen Team mit persönlicher Begleitung und klarer fachlicher Verantwortung im Pflegealltag.</p>
            <h3>Deine Aufgaben</h3><ul><li>Patientinnen kompetent betreuen</li><li>Pflege sorgfältig dokumentieren</li></ul>
          </div></section>`, { status: 200, headers: { 'Content-Type': 'text/html' } });
      };
      const spec = {
        companyKey: 'ipersonal', companyName: 'iPersonal AG', platform: 'med-ipersonal.ch',
        seedUrls: [seedUrl], mode: 'template', detailTemplate: '/jobs/*/', detailFetchWorkers: 1,
      } as any;
      const runtime = {
        fetchImpl: fetchImpl as typeof fetch,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => undefined,
        retries: 0,
      };

      const first = await runIpersonalSpecInProduction(spec, runtime);
      const second = await runIpersonalSpecInProduction(spec, runtime);
      expect(second).toEqual(first);
      expect(first).toHaveLength(1);
      const evidence = first as typeof first & {
        discoveredCount: number;
        expectedSeedCount: number;
        loadedSeedCount: number;
      };
      expect(evidence.discoveredCount).toBe(1);
      expect(evidence.expectedSeedCount).toBe(1);
      expect(evidence.loadedSeedCount).toBe(1);
      expect(first[0]).toMatchObject({
        title: 'Pflegefachperson Zürich', url: detailUrl,
        location: 'Zuzwil SG, St. Gallen', canton: 'SG',
      });
      expect(first[0].description).toContain('\n• Patientinnen kompetent betreuen');
      expect(acceptedEncodings.length).toBeGreaterThan(0);
      expect(acceptedEncodings.every((value) => value === 'identity')).toBe(true);
    });

    it('commits observer state and parsed content only from the retry that succeeds', async () => {
      const seedUrl = 'https://ipersonal-retry.example/';
      const detailUrl = `${seedUrl}jobs/retry-winner/`;
      let detailCalls = 0;
      const winningDescription = 'Eine ausführliche Aufgabenbeschreibung mit professioneller Verantwortung, enger Zusammenarbeit und dokumentierten Qualitätsstandards. Die Fachperson plant Einsätze, berät Kundinnen und Kunden, koordiniert Termine und hält alle Ergebnisse nachvollziehbar fest.';
      const fetchImpl = async (input: string | URL | Request) => {
        const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (url === seedUrl) return new Response(`<a href="${detailUrl}">Retry winner</a>`, { status: 200 });
        detailCalls++;
        if (detailCalls === 1) {
          return new Response('<p>poison body from failed attempt</p>', { status: 503 });
        }
        return new Response(`
          <script type="application/ld+json">${JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'JobPosting',
            title: 'Retry winner',
            url: detailUrl,
            description: winningDescription,
            jobLocation: {
              '@type': 'Place',
              address: {
                '@type': 'PostalAddress',
                addressLocality: 'Zürich',
                addressRegion: 'ZH',
                addressCountry: 'CH',
              },
            },
          })}</script>
          <section class="job-profile-section"><div id="Jobdetails">
            <p>${winningDescription}</p>
            <h3>Deine Aufgaben</h3><ul><li>Ergebnisse zuverlässig dokumentieren</li></ul>
          </div></section>`, { status: 200 });
      };
      const jobs = await runIpersonalSpecInProduction({
        companyKey: 'ipersonal', companyName: 'iPersonal AG', platform: 'med-ipersonal.ch',
        seedUrls: [seedUrl], mode: 'template', detailTemplate: '/jobs/*/', detailFetchWorkers: 1,
      } as any, {
        fetchImpl: fetchImpl as typeof fetch,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => undefined,
        retries: 1,
      });
      const evidence = jobs as typeof jobs & {
        discoveredCount: number;
        resolvedDetailCount: number;
        parsedDetailCount: number;
        detailFailureCount: number;
      };
      expect(detailCalls).toBe(2);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].title).toBe('Retry winner');
      expect(jobs[0].description).toContain('Ergebnisse zuverlässig dokumentieren');
      expect(jobs[0].description).not.toContain('poison body');
      expect(evidence.discoveredCount).toBe(1);
      expect(evidence.resolvedDetailCount).toBe(1);
      expect(evidence.parsedDetailCount).toBe(1);
      expect(evidence.detailFailureCount).toBe(0);
    });

    it('does not schedule another transport attempt after a successful detail', async () => {
      const seedUrl = 'https://ipersonal-no-retry-after-success.example/';
      const detailUrl = `${seedUrl}jobs/first-success/`;
      let detailCalls = 0;
      const fetchImpl = async (input: string | URL | Request) => {
        const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (url === seedUrl) return new Response(`<a href="${detailUrl}">First success</a>`, { status: 200 });
        detailCalls++;
        if (detailCalls > 1) throw new Error('a successful detail must terminate retries');
        const description = 'Eine ausführliche Aufgabenbeschreibung mit professioneller Verantwortung, enger Zusammenarbeit und dokumentierten Qualitätsstandards. Die Fachperson plant Einsätze, berät Kundinnen und Kunden, koordiniert Termine und hält alle Ergebnisse nachvollziehbar fest.';
        return new Response(`
          <script type="application/ld+json">${JSON.stringify({
            '@context': 'https://schema.org', '@type': 'JobPosting', title: 'First success',
            url: detailUrl, description,
            jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Bern', addressRegion: 'BE', addressCountry: 'CH' } },
          })}</script>
          <section class="job-profile-section"><div id="Jobdetails"><p>${description}</p>
            <h3>Deine Aufgaben</h3><ul><li>Ergebnisse zuverlässig dokumentieren</li></ul>
          </div></section>`, { status: 200 });
      };
      const jobs = await runIpersonalSpecInProduction({
        companyKey: 'ipersonal', companyName: 'iPersonal AG', platform: 'med-ipersonal.ch',
        seedUrls: [seedUrl], mode: 'template', detailTemplate: '/jobs/*/', detailFetchWorkers: 1,
      } as any, {
        fetchImpl: fetchImpl as typeof fetch,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => undefined,
        retries: 3,
      });
      expect(detailCalls).toBe(1);
      expect(jobs).toHaveLength(1);
      expect((jobs as any).resolvedDetailCount).toBe(1);
      expect((jobs as any).parsedDetailCount).toBe(1);
    });

    it('counts a validated one-to-one redirect as one attempted vacancy', async () => {
      const seedUrl = 'https://ipersonal-one-to-one.example/';
      const aliasUrl = `${seedUrl}jobs/legacy-alias/`;
      const canonicalDetailUrl = `${seedUrl}jobs/canonical-role/`;
      const description = 'Eine ausführliche Aufgabenbeschreibung mit professioneller Verantwortung, enger Zusammenarbeit und dokumentierten Qualitätsstandards. Die Fachperson plant Einsätze, berät Kundinnen und Kunden, koordiniert Termine und hält alle Ergebnisse nachvollziehbar fest.';
      const fetchImpl = async (input: string | URL | Request) => {
        const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (url === seedUrl) return new Response(`<a href="${aliasUrl}">Canonical role</a>`, { status: 200 });
        if (url === aliasUrl) {
          return new Response('', { status: 302, headers: { Location: canonicalDetailUrl } });
        }
        return new Response(`
          <script type="application/ld+json">${JSON.stringify({
            '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Canonical role',
            url: canonicalDetailUrl, description,
            jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Obbürgen', postalCode: '6363', addressRegion: 'Nidwalden', addressCountry: 'CH' } },
          })}</script>
          <section class="job-profile-section"><div id="Jobdetails"><p>${description}</p>
            <h3>Deine Aufgaben</h3><ul><li>Ergebnisse zuverlässig dokumentieren</li></ul>
          </div></section>`, { status: 200 });
      };
      const jobs = await runIpersonalSpecInProduction({
        companyKey: 'ipersonal', companyName: 'iPersonal AG', platform: 'med-ipersonal.ch',
        seedUrls: [seedUrl], mode: 'template', detailTemplate: '/jobs/*/', detailFetchWorkers: 1,
      } as any, {
        fetchImpl: fetchImpl as typeof fetch,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => undefined,
        retries: 0,
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].url).toBe(aliasUrl);
      expect(getVerifiedIpersonalGeography(jobs[0])).toMatchObject({ canton: 'NW' });
      expect((jobs as any).discoveredCount).toBe(1);
      expect((jobs as any).resolvedDetailCount).toBe(1);
      expect((jobs as any).parsedDetailCount).toBe(1);
      expect((jobs as any).sourceIdentityCollisionCount).toBe(0);
    });

    it('accounts only explicitly rejected source rows and not duplicate listing links', async () => {
      const seedUrl = 'https://ipersonal-accounting.example/';
      const acceptedUrl = `${seedUrl}jobs/accepted/`;
      const rejectedUrl = `${seedUrl}jobs/rejected-no-swiss-location/`;
      const fetchImpl = async (input: string | URL | Request) => {
        const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (url === seedUrl) {
          return new Response(`
            <a href="${acceptedUrl}">Fachperson Zürich</a>
            <a href="${acceptedUrl}">Fachperson Zürich duplicate link</a>
            <a href="${rejectedUrl}">Remote role without Swiss location</a>`, { status: 200 });
        }
        const accepted = url === acceptedUrl;
        const schema = {
          '@context': 'https://schema.org',
          '@type': 'JobPosting',
          title: accepted ? 'Fachperson Zürich' : 'Remote role without Swiss location',
          url,
          description: 'Eine ausführliche Aufgabenbeschreibung mit professioneller Verantwortung, enger Zusammenarbeit und dokumentierten Qualitätsstandards. Die Fachperson plant Einsätze, berät Kundinnen und Kunden, koordiniert Termine und hält alle Ergebnisse nachvollziehbar fest.',
          ...(accepted ? {
            jobLocation: {
              '@type': 'Place',
              address: {
                '@type': 'PostalAddress',
                addressLocality: 'Zürich',
                addressRegion: 'ZH',
                addressCountry: 'CH',
              },
            },
          } : {}),
        };
        return new Response(`
          <script type="application/ld+json">${JSON.stringify(schema)}</script>
          <section class="job-profile-section"><div id="Jobdetails">
            <p>Eine ausführliche Aufgabenbeschreibung mit professioneller Verantwortung, enger Zusammenarbeit und dokumentierten Qualitätsstandards.</p>
            <h3>Deine Aufgaben</h3><ul><li>Ergebnisse zuverlässig und nachvollziehbar dokumentieren</li><li>Kundinnen und Kunden professionell beraten und Termine koordinieren</li></ul>
          </div></section>`, { status: 200 });
      };
      const jobs = await runIpersonalSpecInProduction({
        companyKey: 'ipersonal',
        companyName: 'iPersonal AG',
        platform: 'med-ipersonal.ch',
        seedUrls: [seedUrl],
        mode: 'template',
        detailTemplate: '/jobs/*/',
        detailFetchWorkers: 1,
      } as any, {
        fetchImpl: fetchImpl as typeof fetch,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => undefined,
        retries: 0,
      });
      const evidence = jobs as typeof jobs & {
        discoveredCount: number;
        qualityDroppedCount: number;
        sourceIdentityCollisionCount: number;
        unaccountedReturnedCount: number;
      };
      expect(jobs).toHaveLength(1);
      expect(evidence.discoveredCount).toBe(2);
      expect(evidence.qualityDroppedCount).toBe(1);
      expect(evidence.sourceIdentityCollisionCount).toBe(0);
      expect(evidence.unaccountedReturnedCount).toBe(0);
    });

    it('keeps a detail HTTP failure separate from source-proven quality drops', async () => {
      const seedUrl = 'https://ipersonal-http-failure.example/';
      const acceptedUrl = `${seedUrl}jobs/accepted/`;
      const failedUrl = `${seedUrl}jobs/unavailable/`;
      const fetchImpl = async (input: string | URL | Request) => {
        const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (url === seedUrl) {
          return new Response(
            `<a href="${acceptedUrl}">Fachperson Zürich</a><a href="${failedUrl}">Unavailable role</a>`,
            { status: 200 },
          );
        }
        if (url === failedUrl) return new Response('temporary upstream outage', { status: 500 });
        return new Response(`
          <script type="application/ld+json">${JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'JobPosting',
            title: 'Fachperson Zürich',
            url: acceptedUrl,
            description: 'Eine ausführliche Aufgabenbeschreibung mit professioneller Verantwortung, enger Zusammenarbeit und dokumentierten Qualitätsstandards. Die Fachperson plant Einsätze, berät Kundinnen und Kunden, koordiniert Termine und hält alle Ergebnisse nachvollziehbar fest.',
            jobLocation: {
              '@type': 'Place',
              address: {
                '@type': 'PostalAddress',
                addressLocality: 'Zürich',
                addressRegion: 'ZH',
                addressCountry: 'CH',
              },
            },
          })}</script>
          <section class="job-profile-section"><div id="Jobdetails">
            <p>Eine ausführliche Aufgabenbeschreibung mit professioneller Verantwortung, enger Zusammenarbeit und dokumentierten Qualitätsstandards.</p>
            <h3>Deine Aufgaben</h3><ul><li>Ergebnisse zuverlässig dokumentieren</li></ul>
          </div></section>`, { status: 200 });
      };
      const jobs = await runIpersonalSpecInProduction({
        companyKey: 'ipersonal',
        companyName: 'iPersonal AG',
        platform: 'med-ipersonal.ch',
        seedUrls: [seedUrl],
        mode: 'template',
        detailTemplate: '/jobs/*/',
        detailFetchWorkers: 1,
      } as any, {
        fetchImpl: fetchImpl as typeof fetch,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => undefined,
        retries: 0,
      });
      const evidence = jobs as typeof jobs & {
        discoveredCount: number;
        qualityDroppedCount: number;
        detailFailureCount: number;
      };
      expect(jobs).toHaveLength(1);
      expect(evidence.discoveredCount).toBe(2);
      expect(evidence.qualityDroppedCount).toBe(0);
      expect(evidence.detailFailureCount).toBe(1);
      expect(() => assertCompleteIpersonalSnapshot(evidence)).toThrow(
        /detail fetch\/parse failure/,
      );
    });

    it('surfaces two detail aliases resolving to one response identity', async () => {
      const seedUrl = 'https://ipersonal-redirect.example/';
      const firstUrl = `${seedUrl}jobs/first/`;
      const secondUrl = `${seedUrl}jobs/second/`;
      const canonicalDetailUrl = `${seedUrl}jobs/canonical/`;
      const fetchImpl = async (input: string | URL | Request) => {
        const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (url === seedUrl) {
          return new Response(`<a href="${firstUrl}">First role</a><a href="${secondUrl}">Second role</a>`, {
            status: 200,
          });
        }
        const response = new Response(`
          <script type="application/ld+json">${JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'JobPosting',
            title: url === firstUrl ? 'First role' : 'Second role',
            url: canonicalDetailUrl,
            description: 'Eine ausführliche Aufgabenbeschreibung mit professioneller Verantwortung, enger Zusammenarbeit und dokumentierten Qualitätsstandards. Die Fachperson plant Einsätze, berät Kundinnen und Kunden, koordiniert Termine und hält alle Ergebnisse nachvollziehbar fest.',
            jobLocation: {
              '@type': 'Place',
              address: {
                '@type': 'PostalAddress',
                addressLocality: 'Zürich',
                addressRegion: 'ZH',
                addressCountry: 'CH',
              },
            },
          })}</script>
          <section class="job-profile-section"><div id="Jobdetails">
            <p>Eine ausführliche Aufgabenbeschreibung mit professioneller Verantwortung, enger Zusammenarbeit und dokumentierten Qualitätsstandards.</p>
            <h3>Deine Aufgaben</h3><ul><li>Ergebnisse zuverlässig und nachvollziehbar dokumentieren</li><li>Kundinnen und Kunden professionell beraten und Termine koordinieren</li></ul>
          </div></section>`, { status: 200 });
        Object.defineProperty(response, 'url', { value: canonicalDetailUrl });
        return response;
      };
      const jobs = await runIpersonalSpecInProduction({
        companyKey: 'ipersonal',
        companyName: 'iPersonal AG',
        platform: 'med-ipersonal.ch',
        seedUrls: [seedUrl],
        mode: 'template',
        detailTemplate: '/jobs/*/',
        detailFetchWorkers: 1,
      } as any, {
        fetchImpl: fetchImpl as typeof fetch,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => undefined,
        retries: 0,
      });
      const evidence = jobs as typeof jobs & {
        qualityDroppedCount: number;
        sourceIdentityCollisionCount: number;
      };
      expect(evidence.qualityDroppedCount).toBe(0);
      expect(evidence.sourceIdentityCollisionCount).toBe(1);
    });

    it('records an empty configured listing seed and rejects the batch as partial', async () => {
      const seedUrl = 'https://ipersonal-seeds.example/';
      const emptySeedUrl = `${seedUrl}empty/`;
      const detailUrl = `${seedUrl}jobs/elettricista/`;
      const fetchImpl = async (input: string | URL | Request) => {
        const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.endsWith('/robots.txt') || url === emptySeedUrl) return new Response('', { status: 200 });
        if (url === seedUrl) {
          return new Response(`<a href="${detailUrl}">Elettricista</a>`, { status: 200 });
        }
        return new Response(`
          <script type="application/ld+json">${JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'JobPosting',
            title: 'Elettricista',
            url: detailUrl,
            description: 'Attività professionale con responsabilità tecniche e collaborazione continuativa in un team qualificato.',
            jobLocation: {
              '@type': 'Place',
              address: {
                '@type': 'PostalAddress',
                addressLocality: 'Zürich',
                addressRegion: 'ZH',
                addressCountry: 'CH',
              },
            },
          })}</script>
          <section class="job-profile-section"><div id="Jobdetails">
            <p>Attività professionale con responsabilità tecniche e collaborazione continuativa in un team qualificato.</p>
            <h3>Deine Aufgaben</h3><ul><li>Impianti tecnici verificare e documentare accuratamente</li></ul>
          </div></section>`, { status: 200 });
      };
      const jobs = await runIpersonalSpecInProduction({
        companyKey: 'ipersonal',
        companyName: 'iPersonal AG',
        platform: 'med-ipersonal.ch',
        seedUrls: [seedUrl, emptySeedUrl],
        mode: 'template',
        detailTemplate: '/jobs/*/',
        detailFetchWorkers: 1,
      } as any, {
        fetchImpl: fetchImpl as typeof fetch,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => undefined,
        retries: 0,
      });
      const evidence = jobs as typeof jobs & {
        discoveredCount: number;
        expectedSeedCount: number;
        loadedSeedCount: number;
      };
      expect(evidence.expectedSeedCount).toBe(2);
      expect(evidence.loadedSeedCount).toBe(1);
      expect(() => assertCompleteIpersonalSnapshot(evidence)).toThrow(/loaded 1\/2 listing seeds/);
    });
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(IPERSONAL_KEY).toBe('ipersonal');
    expect(IPERSONAL_COMPANY_NAME).toBe('iPersonal AG');
  });

  // ── isCompanyJob ──
  describe('isIpersonalJob', () => {
    it('matches by companyKey', () => {
      expect(isIpersonalJob({ companyKey: 'ipersonal' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isIpersonalJob({ company: 'iPersonal AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isIpersonalJob({ url: 'https://med-ipersonal.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isIpersonalJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isIpersonalJob(null)).toBe(false);
      expect(isIpersonalJob(undefined)).toBe(false);
      expect(isIpersonalJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://med-ipersonal.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.med-ipersonal.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer ipersonal ch')).toBe('developer-ipersonal-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'ipersonal-abc123',
      slug: 'test-position-ipersonal-ch',
      slugByLocale: { de: 'test-position-ipersonal-ch' },
      company: 'iPersonal AG',
      companyKey: 'ipersonal',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://med-ipersonal.ch/jobs/test',
      source: 'iPersonal AG Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^ipersonal-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
