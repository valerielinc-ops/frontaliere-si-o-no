import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserAlerts, type JobAlert } from '@/services/jobAlertService';
import { fetchUserAlertsCached, findCompanyAlertCached, invalidateUserAlertsCache } from '@/services/userAlertsCache';

vi.mock('@/services/jobAlertService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/jobAlertService')>(),
  getUserAlerts: vi.fn(),
}));

beforeEach(() => {
  invalidateUserAlertsCache();
  vi.mocked(getUserAlerts).mockReset();
});

describe('company follow shared eligibility read', () => {
  it('reuses the pending page read for button and popup, retaining the existing follow', async () => {
    let resolve!: (alerts: JobAlert[]) => void;
    vi.mocked(getUserAlerts).mockReturnValue(new Promise((done) => { resolve = done; }));
    const pageRead = fetchUserAlertsCached('user-a', getUserAlerts);
    const button = findCompanyAlertCached('user-a', { name: 'Acme', companyKey: 'acme' });
    const popup = findCompanyAlertCached('user-a', { name: 'Acme', companyKey: 'acme' });
    const alert = { id: 'existing-follow', specificCompanyKey: 'acme' } as JobAlert;
    resolve([alert]);
    await expect(pageRead).resolves.toEqual([alert]);
    await expect(button).resolves.toBe(alert);
    await expect(popup).resolves.toBe(alert);
    await expect(findCompanyAlertCached('user-a', { name: 'Other' })).resolves.toBeNull();
    expect(getUserAlerts).toHaveBeenCalledTimes(1);
  });

  it('reads again after a successful mutation invalidates the cache or the user changes', async () => {
    vi.mocked(getUserAlerts).mockResolvedValue([]);
    await findCompanyAlertCached('user-a', { name: 'Acme' });
    invalidateUserAlertsCache();
    await findCompanyAlertCached('user-a', { name: 'Acme' });
    await findCompanyAlertCached('user-b', { name: 'Acme' });
    expect(vi.mocked(getUserAlerts).mock.calls).toEqual([['user-a'], ['user-a'], ['user-b']]);
  });

  it('does not retain failed reads', async () => {
    vi.mocked(getUserAlerts).mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
    await expect(findCompanyAlertCached('user-a', { name: 'Acme' })).rejects.toThrow('offline');
    await expect(findCompanyAlertCached('user-a', { name: 'Acme' })).resolves.toBeNull();
    expect(getUserAlerts).toHaveBeenCalledTimes(2);
  });
});
