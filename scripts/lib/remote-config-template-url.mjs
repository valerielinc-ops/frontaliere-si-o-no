export const REMOTE_CONFIG_SCOPE = 'https://www.googleapis.com/auth/firebase.remoteconfig';

const REMOTE_CONFIG_API = 'https://firebaseremoteconfig.googleapis.com/v1';

export function remoteConfigTemplateUrl(projectId, namespace = 'firebase') {
  const normalizedNamespace = String(namespace || 'firebase').trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/iu.test(normalizedNamespace)) {
    throw new Error('Remote Config namespace is invalid');
  }
  const project = encodeURIComponent(projectId);
  if (normalizedNamespace === 'firebase') return `${REMOTE_CONFIG_API}/projects/${project}/remoteConfig`;
  return `${REMOTE_CONFIG_API}/projects/${project}/namespaces/${encodeURIComponent(normalizedNamespace)}/remoteConfig`;
}
