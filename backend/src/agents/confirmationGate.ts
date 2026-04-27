// Confirmation Gate: stops unless confirmed
export async function confirmationGate(input: { confirmed: boolean }) {
  try {
    if (!input.confirmed) {
      throw new Error('Confirmation required before proceeding.');
    }
    return { confirmed: true };
  } catch (err) {
    return { confirmed: false, error: (err as any)?.message || String(err) };
  }
}
