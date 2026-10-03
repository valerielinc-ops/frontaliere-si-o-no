import { describe, expect, it } from 'vitest';
import { editorialModifiedDate } from '../../build-plugins/shared/editorialDates';
import { renderBorderDashboardLink } from '../../build-plugins/shared/borderDashboardLink';
import { buildRootHubPath, BORDER_WAIT_LOCALES } from '../../build-plugins/borderWaitData';
describe('editorial dates and border navigation', () => {
  it('uses the recorded revision, not the build clock or publication date', () => {
    const date = '2026-01-01T00:00:00+01:00';
    expect(editorialModifiedDate(JSON.stringify({'@type':'Article',datePublished:'2020-02-01',dateModified:date}), '</script>')).toBe(date);
    expect(editorialModifiedDate(JSON.stringify({'@type':'Article',datePublished:'2020-02-01'}), '</script>')).toBeUndefined();
    expect(editorialModifiedDate(undefined, '</script>')).toBeUndefined();
    expect(editorialModifiedDate('{invalid', '</script>')).toBeUndefined();
    expect(editorialModifiedDate(JSON.stringify({'@type':'Dataset',dateModified:date}), '</script>')).toBeUndefined();
    expect(editorialModifiedDate(JSON.stringify({'@graph':[{'@type':['Article'],dateModified:date}]}), '</script>')).toBe(date);
  });
  it.each(BORDER_WAIT_LOCALES)('links to the matching dashboard in %s', locale => {
    expect(renderBorderDashboardLink(locale)).toContain(`href="${buildRootHubPath(locale)}"`);
  });
});
