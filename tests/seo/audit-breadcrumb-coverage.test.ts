import { describe, expect, it } from 'vitest';
import { REDIRECT_STUB_MARKER } from '../../build-plugins/shared/redirectStubMarker.mjs';
import * as auditorModule from '../../scripts/audit-breadcrumb-coverage.mjs';

interface AuditReport {
  passed: boolean;
  offendersTotal: number;
  offenders: Array<{ path: string; url: string; metric: number }>;
}

interface Auditor {
  collect: (file: string, html: string) => void;
  report: () => AuditReport;
}

const { createAuditor } = auditorModule as unknown as {
  createAuditor: () => Auditor;
};

describe('audit-breadcrumb-coverage', () => {
  it('exempts canonical redirect stubs by their shared structural marker', () => {
    const auditor = createAuditor();
    auditor.collect(
      '/dist/eventi/basilea/augst/legacy-event/index.html',
      `<!doctype html><html><head>${REDIRECT_STUB_MARKER}
        <meta name="robots" content="index, follow">
        <link rel="canonical" href="https://frontaliereticino.ch/eventi/basilea/augst/current-event/">
        <meta http-equiv="refresh" content="0; url=https://frontaliereticino.ch/eventi/basilea/augst/current-event/">
      </head><body><h1>Pagina evento aggiornata</h1></body></html>`,
    );

    expect(auditor.report()).toMatchObject({ passed: true, offendersTotal: 0 });
  });

  it('still rejects an indexable content page without BreadcrumbList', () => {
    const auditor = createAuditor();
    auditor.collect(
      '/dist/eventi/basilea/augst/current-event/index.html',
      '<!doctype html><html><head><meta name="robots" content="index, follow"></head><body><h1>Evento</h1></body></html>',
    );

    expect(auditor.report()).toMatchObject({ passed: false, offendersTotal: 1 });
  });
});
