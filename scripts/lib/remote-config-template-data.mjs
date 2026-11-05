/**
 * Firebase Admin exposes server templates as a ServerTemplate wrapper, while
 * the REST API returns the serialized template data directly. Normalize both
 * shapes before callers inspect parameter names or default values.
 */
export function normalizeServerTemplateData(template) {
  const data = typeof template?.toJSON === 'function' ? template.toJSON() : template;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Remote Config server template must be an object');
  }
  const parameters = data.parameters ?? {};
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new TypeError('Remote Config server template parameters must be an object');
  }
  return { ...data, parameters };
}
