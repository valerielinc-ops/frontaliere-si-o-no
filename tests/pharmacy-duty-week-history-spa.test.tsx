// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PharmacyDutyWeek from '../components/pages/PharmacyDutyWeek';
import recovery from '../data/pharmacy-duty-week-recovery.json';

afterEach(() => { cleanup(); document.getElementById('pharmacy-duty-week-history')?.remove(); delete window.__CDN_DATA_BASE__; vi.unstubAllGlobals(); });

function seed(index = 0) {
  const script = document.createElement('script');
  script.type = 'application/json';
  script.id = 'pharmacy-duty-week-history';
  script.textContent = JSON.stringify(recovery.weeks[index]);
  document.body.appendChild(script);
}

describe('historical pharmacy week SPA handoff', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('keeps the SSR observations after startup, without current-feed substitution (%s)', (locale) => {
    seed();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { container } = render(<PharmacyDutyWeek page={{ kind: 'duty-week', locale, weekStart: '2026-09-14' }} />);
    expect(container.querySelector('[data-pharmacy-duty-archive]')).toHaveAttribute('data-pharmacy-duty-archive', '2026-09-14');
    expect(screen.getByRole('note')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-duty-id]')).toHaveLength(recovery.weeks[0].observations[0].entries.length);
    for (const entry of recovery.weeks[0].observations[0].entries) expect(container.textContent).toContain(entry.pharmacy.name);
    expect(container.querySelector('time[datetime="2026-09-15T09:40:29.571Z"]')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads the exact week on client navigation and never displays a seed for another week', async () => {
    seed();
    window.__CDN_DATA_BASE__ = 'https://cdn.example.test';
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => recovery.weeks[1] });
    vi.stubGlobal('fetch', fetch);
    const { container } = render(<PharmacyDutyWeek page={{ kind: 'duty-week', locale: 'fr', weekStart: '2026-09-28' }} />);
    expect(container.querySelector('[data-pharmacy-duty-archive]')).toBeNull();
    await waitFor(() => expect(container.querySelector('[data-pharmacy-duty-archive]')).toHaveAttribute('data-pharmacy-duty-archive', '2026-09-28'));
    expect(fetch.mock.calls[0][0]).toBe('https://cdn.example.test/data/pharmacy-duty-week-history/2026-09-28.json');
    expect(container.textContent).toContain('Farmacia Nuova');
    expect(container.textContent).not.toContain('Farmacia Bernasconi');
  });

  it('rejects a mismatched network response, explains the failure and permits retry', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => recovery.weeks[0] })
      .mockResolvedValueOnce({ ok: true, json: async () => recovery.weeks[1] });
    vi.stubGlobal('fetch', fetch);
    const { container } = render(<PharmacyDutyWeek page={{ kind: 'duty-week', locale: 'it', weekStart: '2026-09-28' }} />);
    await screen.findByRole('button', { name: 'Riprova a caricare l’archivio' });
    expect(container.querySelector('[data-pharmacy-duty-archive]')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Non usare questa pagina');
    fireEvent.click(screen.getByRole('button', { name: 'Riprova a caricare l’archivio' }));
    await waitFor(() => expect(container.querySelectorAll('[data-duty-id]')).toHaveLength(recovery.weeks[1].observations[0].entries.length));
  });

  it('cancels an obsolete request and does not let a late response replace the current week', async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    const fetch = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce({ ok: true, json: async () => recovery.weeks[1] });
    vi.stubGlobal('fetch', fetch);
    const { container, rerender } = render(<PharmacyDutyWeek page={{ kind: 'duty-week', locale: 'en', weekStart: '2026-09-14' }} />);
    rerender(<PharmacyDutyWeek page={{ kind: 'duty-week', locale: 'en', weekStart: '2026-09-28' }} />);
    await waitFor(() => expect(container.querySelector('[data-pharmacy-duty-archive]')).toHaveAttribute('data-pharmacy-duty-archive', '2026-09-28'));
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    resolveFirst({ ok: true, json: async () => recovery.weeks[0] });
    await waitFor(() => expect(container.querySelector('[data-pharmacy-duty-archive]')).toHaveAttribute('data-pharmacy-duty-archive', '2026-09-28'));
  });

  it.each([404, 500])('never falls back to today’s duties when the historical endpoint returns %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));
    const { container } = render(<PharmacyDutyWeek page={{ kind: 'duty-week', locale: 'de', weekStart: '2026-09-14' }} />);
    await screen.findByRole('button');
    expect(container.querySelectorAll('[data-duty-id]')).toHaveLength(0);
    expect(screen.getByRole('link', { name: /Aktuelle Notdienste/ })).toHaveAttribute('href', '/de/notdienst-apotheken/');
  });
});
