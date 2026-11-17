/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';

describe('Workday application surface extraction', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('records the native fieldless apply-flow mount before questions render', () => {
    document.body.innerHTML = '<main><div data-automation-id="applyFlowPage"></div></main>';

    expect(extractFieldsInPage().workdayApplicationSurface).toBe(true);

    document.body.innerHTML = '<main></main>';
    expect(extractFieldsInPage().workdayApplicationSurface).toBe(false);
  });
});
