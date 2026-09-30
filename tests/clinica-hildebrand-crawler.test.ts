import { describe, expect, it } from 'vitest';

import { parseClinicaHildebrandListing } from '../scripts/lib/clinica-hildebrand-job-parser.mjs';

describe('Clinica Hildebrand listing parser', () => {
  it('does not throw on malformed percent-encoding in a PDF href', () => {
    expect(() => parseClinicaHildebrandListing(
      '<a href="/uploads/%E0%A4.pdf">PDF</a>',
    )).not.toThrow();
  });
});
