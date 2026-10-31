/** Existing backend qualification provider/tier; no new account, key or fallback rung. */
import { generateServerText } from '../geminiGenerate.js';
export async function generateQualificationJson(systemPrompt, userPrompt, schema, options = {}) {
  const response = await generateServerText({ systemPrompt: `${systemPrompt}\nReturn ONLY valid JSON matching this schema:\n${JSON.stringify(schema)}`,
    userPrompt, maxTokens: 8192, temperature: 0, maxProviderAttempts: 3, allowCodexFallback: false, ...options });
  options.signal?.throwIfAborted();
  if (!response.body?.ok) throw new Error('eligibility_provider_unavailable');
  const text = response.body.text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const result = JSON.parse(text);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('eligibility_invalid_json');
  return result;
}
