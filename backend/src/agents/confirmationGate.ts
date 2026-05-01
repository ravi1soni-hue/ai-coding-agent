// Confirmation Gate: stops unless confirmed
// Confirmation Gate: stops unless all confirmations are present and no clarifications are unresolved
import { debug } from '../utils/logger';

export async function confirmationGate(input: {
  confirmed: boolean;
  clarifications?: string[];
  questions?: string[];
}) {
  debug('confirmationGate', { input });
  try {
    // Block if not confirmed
    if (!input.confirmed) {
      throw new Error('Confirmation required before proceeding.');
    }
    // Block if there are unresolved clarifications or questions
    if ((input.clarifications && input.clarifications.length > 0) || (input.questions && input.questions.length > 0)) {
      throw new Error('Unresolved clarifications or questions remain.');
    }
    debug('confirmationGate:confirmed');
    return { confirmed: true };
  } catch (err) {
    throw err;
  }
}
