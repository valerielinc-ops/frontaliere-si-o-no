import { describe, it, expect } from 'vitest';
import { LOGO_FALLBACK_SCRIPT } from '../../build-plugins/shared/logoFallbackScript';
import { generateInitialsLogo } from '../../build-plugins/shared/companyLogoResolver';

/**
 * Guard the lockstep invariant between the client `jcLF` handler (emitted in
 * LOGO_FALLBACK_SCRIPT and externalised from per-card `onerror`) and the
 * server-side `generateInitialsLogo`. Both MUST produce the byte-identical
 * coloured-initials data URI for the same company name, or the logo fallback
 * drifts between server-rendered HTML and client-rebuilt logos when a primary
 * logo 404s.
 */

type FakeImg = { alt: string; dataset: Record<string, string>; onerror: unknown; src: string };

// Extract and instantiate the `jcLF` defined inside the emitted <script>.
function loadJcLF(): (g: FakeImg) => void {
  const body = LOGO_FALLBACK_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const sandbox: { jcLF?: (g: FakeImg) => void } = {};
  // The script assigns `window.jcLF = …`; run it with `window` bound to sandbox.
  new Function('window', body)(sandbox);
  if (typeof sandbox.jcLF !== 'function') {
    throw new Error('LOGO_FALLBACK_SCRIPT did not define window.jcLF');
  }
  return sandbox.jcLF;
}

describe('LOGO_FALLBACK_SCRIPT — jcLF client/server parity', () => {
  const jcLF = loadJcLF();

  const names = [
    'Tecan',
    'Migros',
    'UBS',
    'Banca dello Stato',
    'Coop Società Cooperativa',
    'A',
    'Świętokrzyskie GmbH',
    'EY & Co.',
    'La Posta',
    'Helsana Versicherungen AG',
    'x',
    'Łódź Tech',
    '123 Logistics',
    'École Hôtelière',
  ];

  it.each(names)('rebuilds the same initials data URI as generateInitialsLogo for %j', (name) => {
    const img: FakeImg = { alt: `Logo ${name}`, dataset: {}, onerror: () => {}, src: '' };
    jcLF(img);
    expect(img.src).toBe(generateInitialsLogo(name));
  });

  it('guards against error loops (only swaps src once)', () => {
    const img: FakeImg = { alt: 'Logo Tecan', dataset: {}, onerror: () => {}, src: '' };
    jcLF(img);
    const first = img.src;
    img.src = 'SHOULD_NOT_CHANGE';
    jcLF(img); // second invocation must be a no-op (dataset.lf already set)
    expect(img.src).toBe('SHOULD_NOT_CHANGE');
    expect(first).toBe(generateInitialsLogo('Tecan'));
  });
});
