"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.confirmationGate = confirmationGate;
// Confirmation Gate: stops unless confirmed
async function confirmationGate(input) {
    try {
        if (!input.confirmed) {
            throw new Error('Confirmation required before proceeding.');
        }
        return { confirmed: true };
    }
    catch (err) {
        throw err;
    }
}
