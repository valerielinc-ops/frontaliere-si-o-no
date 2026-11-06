// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdminConfirmProvider, useAdminConfirm } from '@/components/admin/ui/AdminConfirmDialog';
import { AdminShell, type AdminPaletteItem } from '@/components/admin/ui/AdminShell';
import { WorkflowCard } from '@/components/admin/sections/workflow/WorkflowCard';
import { getVisibleAdminSections } from '@/components/admin/adminSections';
import { resolveAdminShellVariant, shouldHideSiteNavigation } from '@/components/admin/lib/adminShellVariant';
import { getConfigValue } from '@/services/firebase';

const adminNavigationMocks = vi.hoisted(() => ({
  navigateAdminSection: vi.fn(),
  replaceAdminQuery: vi.fn(),
}));

vi.mock('@/components/admin/AdminWorkflowProvider', () => ({
  useAdminWorkflow: () => ({
    getSummary: () => ({ ok: 2, error: 1, pending: 3 }),
  }),
}));

vi.mock('@/components/admin/lib/adminNavigation', () => ({
  adminSectionPath: (section: string) => `/gestione-contenuti-xk9mp2q/${section ? `${section}/` : ''}`,
  navigateAdminSection: adminNavigationMocks.navigateAdminSection,
  replaceAdminQuery: adminNavigationMocks.replaceAdminQuery,
}));

const ADMIN_ROOT = resolve(__dirname, '..', 'components', 'admin');
const ADMIN_LEGACY_SURFACE = [
  resolve(__dirname, '..', 'components', 'pages', 'AssistedApplicationAdmin.tsx'),
  resolve(__dirname, '..', 'components', 'pages', 'ApplicationConciergeAdmin.tsx'),
  resolve(__dirname, '..', 'components', 'pages', 'AssistedApplicationAutomationPanel.tsx'),
];

function adminFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = join(root, entry.name);
    return entry.isDirectory() ? adminFiles(file) : file.endsWith('.tsx') ? [file] : [];
  });
}

function ConfirmationHarness() {
  const { requestConfirmation } = useAdminConfirm();
  const [result, setResult] = useState('nessun esito');
  return (
    <div>
      <button type="button" onClick={async () => { const confirmed = await requestConfirmation({ title: 'Lancia l’orchestratore dei crawler', what: 'Stai per lanciare l’orchestratore dei crawler.', workflowFile: 'orchestrate-crawlers.yml', impact: 'Modifica dati', input: 'group=all', expectedDuration: '30 min', confirmLabel: 'Lancia orchestratore' }); setResult(confirmed ? 'confermata' : 'annullata'); }}>Apri conferma</button>
      <output>{result}</output>
    </div>
  );
}

describe('admin fase 2 shell contract', () => {
  it('mantiene visibile la navigazione del sito con il guscio v1 e la nasconde con v2', () => {
    expect(shouldHideSiteNavigation('admin', 'v1')).toBe(false);
    expect(shouldHideSiteNavigation('admin', 'v2')).toBe(true);
    expect(shouldHideSiteNavigation('calculator', 'v2')).toBe(false);
  });

  it('risolve il guscio da override URL prima di Remote Config e normalizza il flag', async () => {
    const getConfigValueMock = vi.mocked(getConfigValue);
    getConfigValueMock.mockResolvedValue('TRUE');

    await expect(resolveAdminShellVariant('?shell=v1')).resolves.toBe('v1');
    expect(getConfigValueMock).not.toHaveBeenCalled();

    await expect(resolveAdminShellVariant('')).resolves.toBe('v2');
    expect(getConfigValueMock).toHaveBeenCalledWith('admin_shell_v2');

    getConfigValueMock.mockResolvedValue('false');
    await expect(resolveAdminShellVariant('?section=oggi')).resolves.toBe('v1');
  });

  it('keeps the admin surface free of forbidden legacy styling and browser confirms', () => {
    const source = adminFiles(ADMIN_ROOT).map((file) => readFileSync(file, 'utf8')).join('\n');
    const legacyAdminSource = ADMIN_LEGACY_SURFACE.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(/window\.confirm|\bconfirm\(/);
    expect(legacyAdminSource).not.toMatch(/window\.confirm/);
    expect(source).not.toMatch(/text-\[(?:9|10|11)px\]/);
    expect(source).not.toMatch(/border-l(?:-[24])?(?:-[a-z0-9]+)?/);
    expect(source).not.toMatch(/\bdark:/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/[⏰⏱️📊🔗🏠🏚]/);
    expect(source).toContain('aria-current={active ? \'page\' : undefined}');
    expect(source).toContain('env(safe-area-inset-bottom)');
    expect(source).toContain('<dialog');
    expect(readFileSync(resolve(__dirname, '..', 'services', 'firebase.ts'), 'utf8')).toContain("admin_shell_v2: 'false'");
    expect(readFileSync(resolve(__dirname, '..', 'functions', 'src', 'publicConfigKeys.js'), 'utf8')).toContain("'admin_shell_v2'");
  });

  it('renders the active section in the desktop rail and mobile group navigation', () => {
    render(
      <AdminShell
        sections={getVisibleAdminSections()}
        activeSection="crawler"
        onNavigate={() => {}}
        onCopyLink={() => {}}
        copyFeedback={false}
      >
        <p>Contenuto crawler</p>
      </AdminShell>,
    );

    expect(screen.getAllByRole('link', { name: /Crawler/ }).length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[aria-current="page"]').length).toBe(3);
    expect(screen.getByRole('navigation', { name: 'Sezioni Lavoro' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Gruppi amministrazione' })).toBeInTheDocument();
    expect(screen.getByText('Contenuto crawler')).toBeInTheDocument();
  });

  it('espone una palette combobox navigabile con frecce e Invio', () => {
    adminNavigationMocks.navigateAdminSection.mockClear();
    render(
      <AdminShell
        sections={getVisibleAdminSections()}
        activeSection=""
        onNavigate={() => {}}
        onCopyLink={() => {}}
        copyFeedback={false}
      >
        <p>Contenuto oggi</p>
      </AdminShell>,
    );

    const input = screen.getAllByRole('combobox')[0];
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Crawler' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(adminNavigationMocks.navigateAdminSection).toHaveBeenCalledWith('crawler');
  });

  it('indicizza 5.000 aziende una volta e limita il rendering a 8 risultati', async () => {
    let labelReads = 0;
    const paletteItems: AdminPaletteItem[] = Array.from({ length: 5_000 }, (_, index) => {
      const label = `Azienda sintetica ${index}`;
      const item: AdminPaletteItem = { id: `company-${index}`, label, kind: 'company', group: 'aziende' };
      Object.defineProperty(item, 'label', { enumerable: true, get: () => { labelReads += 1; return label; } });
      return item;
    });
    render(
      <AdminShell
        sections={getVisibleAdminSections()}
        activeSection=""
        onNavigate={() => {}}
        onCopyLink={() => {}}
        copyFeedback={false}
        paletteItems={paletteItems}
      >
        <p>Contenuto oggi</p>
      </AdminShell>,
    );

    const input = screen.getAllByRole('combobox')[0];
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'azienda' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(16));
    const readsAfterFirstSearch = labelReads;
    fireEvent.change(input, { target: { value: 'sintetica 49' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(16));
    expect(labelReads - readsAfterFirstSearch).toBeLessThan(100);
  });
});

describe('admin confirmation dialog', () => {
  it('supports Escape/Annulla and Conferma with the native dialog', async () => {
    render(<AdminConfirmProvider><ConfirmationHarness /></AdminConfirmProvider>);

    const trigger = screen.getByRole('button', { name: 'Apri conferma' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Lancia l’orchestratore dei crawler');
    expect(dialog).toHaveTextContent('orchestrate-crawlers.yml');
    expect(screen.getByRole('button', { name: 'Lancia orchestratore' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Annulla' })).toHaveFocus());
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.getByText('annullata')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Apri conferma' })).toHaveFocus();
    });

    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Lancia orchestratore' }));
    await waitFor(() => expect(screen.getByText('confermata')).toBeInTheDocument());
  });

  it('uses a normal impact pill and an action-specific start label', () => {
    const state = {
      loading: false,
      runId: null,
      runNumber: null,
      status: 'idle',
      conclusion: null,
      htmlUrl: null,
      startedAt: null,
      updatedAt: null,
      completedAt: null,
      durationSeconds: null,
      message: null,
      error: null,
      jobs: [],
      logExcerpt: null,
      aiPrompt: null,
    };
    render(
      <WorkflowCard
        workflow={{ id: 'generate-article.yml', title: 'Genera nuovo articolo', context: 'content', impact: 'pubblicazione', description: 'Pipeline editoriale.', details: 'Dettagli.', expectedDuration: '8-30 min' }}
        state={state}
        onRun={() => {}}
        onCopy={() => {}}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText('Pubblica contenuti')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Avvia…' })).toBeInTheDocument();
    expect(screen.queryByText(/IMPATTO:/i)).not.toBeInTheDocument();
  });
});
