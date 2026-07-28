// Setup del project `dom` (jsdom): matcher DOM di jest-dom + il corpo comune.
//
// Il corpo vive in setup-common.tsx ed è condiviso con setup-node.ts, che è
// identico MENO questo import. Motivo: `setupFiles` gira una volta per OGNI
// file di test, e `@testing-library/jest-dom/vitest` costa da solo ~48ms —
// misurato su un file di test vuoto: 93ms di setup con l'import, 45ms senza.
// Su ~1240 file `.test.ts` del project `node` erano ~60s di lavoro speso per
// registrare matcher (`toBeInTheDocument` & co.) che quei test non possono
// nemmeno usare, non avendo un DOM.
//
// Verificato prima di separare: dei 1240 file del project node solo 2 citano
// un matcher jest-dom (tests/e2e/calculator-no-runtime-errors.test.ts e
// tests/e2e/job-detail-navigation.test.ts) ed entrambi importano `expect` da
// `playwright/test`, quindi quei matcher vengono da Playwright, non da qui.
//
// I `vi.mock(...)` restano tutti nel corpo comune: sono registrazioni nel mock
// registry, valide anche in ambiente node, e i test node ne dipendono.
import '@testing-library/jest-dom/vitest';
import './setup-common';
