import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WhatsNewModal, { WhatsNewBell, RELEASES, STORAGE_KEY, releaseLinkToRoute } from '@/components/community/WhatsNewModal';
import { buildPath } from '@/services/router';
import itCore from '@/services/locales/it-core';

const findReleaseItem = (version: string, titleKey: string) => {
  const release = RELEASES.find((item) => item.version === version);
  return release?.items.find((item) => item.titleKey === titleKey);
};

// ─── WhatsNewBell ─────────────────────────────────────────────────────────

describe('WhatsNewBell', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders bell icon button', () => {
    const onClick = vi.fn();
    render(<WhatsNewBell onClick={onClick} />);
    const btn = screen.getByRole('button');
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows unread badge when releases are unseen', () => {
    render(<WhatsNewBell onClick={vi.fn()} />);
    // Should have a badge since no release was seen
    const badge = document.querySelector('[class*="bg-danger"]');
    expect(badge).toBeTruthy();
  });

  it('hides badge after user has seen latest release', () => {
    localStorage.setItem(STORAGE_KEY, RELEASES[0].version);
    render(<WhatsNewBell onClick={vi.fn()} />);
    const badge = document.querySelector('[class*="bg-danger"]');
    expect(badge).toBeNull();
  });
});

// ─── WhatsNewModal ────────────────────────────────────────────────────────

describe('WhatsNewModal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const getReleaseLink = (version: string, titleKey: string) => {
    const item = findReleaseItem(version, titleKey);
    expect(item?.link).toBeTruthy();

    const label = `${itCore[titleKey]} — ${itCore['whatsNew.goTo']}`;
    return screen.getByRole('link', { name: label });
  };

  it('renders nothing when open=false', () => {
    const { container } = render(<WhatsNewModal open={false} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders modal with release notes when open=true', () => {
    render(<WhatsNewModal open={true} onClose={vi.fn()} />);
    // Should show at least the first release version
    expect(screen.getByText(new RegExp(RELEASES[0].version))).toBeTruthy();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(<WhatsNewModal open={true} onClose={onClose} />);
    // Find the close button (X icon button)
    const closeButtons = screen.getAllByRole('button');
    const closeBtn = closeButtons.find(
      (b) => b.getAttribute('aria-label')?.toLowerCase().includes('close') ||
             b.getAttribute('aria-label')?.toLowerCase().includes('chiudi')
    );
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn!);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<WhatsNewModal open={true} onClose={onClose} />);
    // Backdrop is the absolute overlay with bg-black
    const backdrop = document.querySelector('[class*="absolute"][class*="inset-0"][class*="bg-black"]');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalled();
  });

  it('persists last-seen date to localStorage on open', () => {
    render(<WhatsNewModal open={true} onClose={vi.fn()} />);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(RELEASES[0].date);
  });

  it('renders all release sections', { timeout: 30000 }, () => {
    render(<WhatsNewModal open={true} onClose={vi.fn()} />);
    for (const release of RELEASES) {
      expect(screen.getByText(new RegExp(release.version))).toBeTruthy();
    }
  });

  it('renders statistics updates with a stats href instead of the job board', () => {
    render(<WhatsNewModal open={true} onClose={vi.fn()} />);
    const link = getReleaseLink('3.32.0', 'whatsNew.v3320.admin.title');

    expect(link.getAttribute('href')).toBe(buildPath({ activeTab: 'stats', statsSubTab: 'overview' }, 'it'));
  });

  it('builds hrefs with sub-tabs for deep links', () => {
    render(<WhatsNewModal open={true} onClose={vi.fn()} />);
    const link = getReleaseLink('3.13.0', 'whatsNew.v3130.salaryBreakdown.title');

    expect(link.getAttribute('href')).toBe(buildPath({ activeTab: 'calculator', calcolatoreSubTab: 'calculator' }, 'it'));
  });
});

// ─── RELEASES data integrity ─────────────────────────────────────────────

describe('RELEASES data integrity', () => {
  it('has at least one release', () => {
    expect(RELEASES.length).toBeGreaterThan(0);
  });

  it('all releases have a valid semver-like version', () => {
    for (const r of RELEASES) {
      expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('all releases have at least one item', () => {
    for (const r of RELEASES) {
      expect(r.items.length).toBeGreaterThan(0);
    }
  });

  it('all items have valid type', () => {
    const validTypes = ['feature', 'improvement', 'fix'];
    for (const r of RELEASES) {
      for (const item of r.items) {
        expect(validTypes).toContain(item.type);
      }
    }
  });

  it('releases are ordered newest first', () => {
    const semverCompare = (a: string, b: string) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] ?? 0;
        const nb = pb[i] ?? 0;
        if (na !== nb) return na - nb;
      }
      return 0;
    };
    for (let i = 1; i < RELEASES.length; i++) {
      const prev = RELEASES[i - 1].version;
      const curr = RELEASES[i].version;
      expect(semverCompare(prev, curr)).toBeGreaterThan(0);
    }
  });

  it('links the 3.11 stats item to the statistics overview', () => {
    const release = RELEASES.find((item) => item.version === '3.11.0');
    const statsItem = release?.items.find((item) => item.titleKey === 'whatsNew.v3110.use-service-account.title');

    expect(statsItem?.link).toEqual({ tab: 'stats' });
  });

  it('maps release links to router routes with the correct sub-tab key', () => {
    expect(releaseLinkToRoute({ tab: 'stats' })).toEqual({ activeTab: 'stats', statsSubTab: 'overview' });
    expect(releaseLinkToRoute({ tab: 'calculator', subTab: 'calculator' })).toEqual({ activeTab: 'calculator', calcolatoreSubTab: 'calculator' });
    expect(releaseLinkToRoute({ tab: 'guida', subTab: 'border' })).toEqual({ activeTab: 'guida', guidaSubTab: 'border' });
  });

  it('links the 3.31 statistics item to the statistics overview', () => {
    const statsItem = findReleaseItem('3.31.0', 'whatsNew.v3310.admin.title');

    expect(statsItem?.link).toEqual({ tab: 'stats' });
  });

  it('links the 3.32 statistics item to the statistics overview', () => {
    const statsItem = findReleaseItem('3.32.0', 'whatsNew.v3320.admin.title');

    expect(statsItem?.link).toEqual({ tab: 'stats' });
  });
});
