import { GET_ASSISTED_APPLICATION_CV_URL } from './functionsBase';

interface FirebaseAuthUser {
  getIdToken: () => Promise<string>;
}

export async function getAssistedApplicationCvUrl(
  orderId: string,
  user: FirebaseAuthUser,
): Promise<string> {
  const idToken = await user.getIdToken();
  const response = await fetch(GET_ASSISTED_APPLICATION_CV_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ orderId }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok || typeof data.url !== 'string') {
    throw new Error('assisted_application_cv_unavailable');
  }
  return data.url;
}
