/**
 * Stub for @google-cloud/recaptcha-enterprise — the real package is only
 * installed under functions/node_modules. Tests vi.mock() this module, but
 * Vite's import-analysis pass runs before mocks are applied. The vitest.config
 * alias points imports here so resolution succeeds. The exported class is
 * intentionally minimal — vi.mock() replaces it before any test code runs.
 */
export class RecaptchaEnterpriseServiceClient {
  projectPath(): string {
    return 'projects/stub';
  }
  async createAssessment(): Promise<unknown[]> {
    return [{ tokenProperties: { valid: false, invalidReason: 'STUB' } }];
  }
}
