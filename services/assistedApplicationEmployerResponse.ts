import { employerResponseView } from '../functions/src/assistedApplicationEmployerResponse.js';

export interface EmployerResponse {
  category: 'auto_acknowledgement' | 'interview_invite' | 'rejection' | 'documents_request' | 'question' | 'assessment' | 'offer';
  receivedAt: number;
  needsReply: boolean;
}

/** The same public projection validates API data and stored inbound metadata. */
export function parseEmployerResponse(value: unknown): EmployerResponse | null {
  return employerResponseView(value) as EmployerResponse | null;
}
