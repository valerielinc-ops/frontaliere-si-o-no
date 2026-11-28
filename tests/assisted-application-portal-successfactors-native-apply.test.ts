import { describe, expect, it } from 'vitest';
import {
  applicationEntryControls,
  isVerifiedPostingEntry,
  portalEntryUrl,
} from '../scripts/assisted-application/lib/portal/portal.mjs';

// Synthetic tenant: an employer job board (not Jobs2Web) whose Apply anchors open the
// SuccessFactors module under `/careers`, with a requisition id that is not the public posting id.
const posting = 'https://jobs.example-group.test/fr/entreprises/job/coop-nord/vendeuse-fruits/00000000-0000-4000-8000-000000000001';
const moduleUrl = 'https://career2.successfactors.eu/careers?career_ns=job_application&company=ExampleP1&career_job_req_id=4723&lang=fr_FR';
const proof = { via: 'successfactors', applyUrl: moduleUrl, postingUrl: posting };
const job = { title: 'Venditrice di frutta e verdura', sourceTitle: 'Vendeuse fruits et legumes', company: 'Coop Nord' };

const link = (href: string) => ({ text: 'Postuler maintenant', href, tag: 'a', frame: 0 });
const snapshot = (controls: unknown[]) => ({ url: posting, fields: [], buttons: controls, links: [], dialogs: [] });
const context = { applyUrl: moduleUrl, postingUrl: posting, postingRouteProof: proof, job, allowSingleExternalApplicationEntry: true };

describe('SuccessFactors module reached from a native posting page', () => {
  it('binds the /careers module only through the recorded route proof', () => {
    expect(isVerifiedPostingEntry({ applyUrl: moduleUrl, postingUrl: posting, postingRouteProof: proof })).toBe(true);
    expect(isVerifiedPostingEntry({ applyUrl: moduleUrl, postingUrl: posting })).toBe(false);
    expect(isVerifiedPostingEntry({
      applyUrl: moduleUrl.replace('4723', '4724'), postingUrl: posting, postingRouteProof: proof,
    })).toBe(false);
    expect(isVerifiedPostingEntry({
      applyUrl: moduleUrl.replace('ExampleP1', 'OtherP1'), postingUrl: posting, postingRouteProof: proof,
    })).toBe(false);
  });

  it('enters through the posting page, not the cold module route', () => {
    expect(portalEntryUrl({ applyUrl: moduleUrl, postingUrl: posting, postingRouteProof: proof })).toBe(posting);
  });

  it('offers the proven Apply link, and no link of another requisition', () => {
    const entries = applicationEntryControls(snapshot([link(moduleUrl), link(moduleUrl)]), context);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry: { href: string }) => entry.href === moduleUrl)).toBe(true);
    expect(applicationEntryControls(snapshot([link(moduleUrl.replace('4723', '4724'))]), context)).toEqual([]);
  });
});
