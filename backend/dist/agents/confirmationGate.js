"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.confirmationGate = confirmationGate;
// Confirmation Gate: stops unless confirmed
// Confirmation Gate: stops unless all confirmations are present and no clarifications are unresolved
async function confirmationGate(input) {
    try {
        // Block if not confirmed
        if (!input.confirmed) {
            throw new Error('Confirmation required before proceeding.');
        }
        // Block if there are unresolved clarifications or questions
        if ((input.clarifications && input.clarifications.length > 0) || (input.questions && input.questions.length > 0)) {
            throw new Error('Unresolved clarifications or questions remain.');
        }
        return { confirmed: true };
    }
    catch (err) {
        throw err;
    }
}
