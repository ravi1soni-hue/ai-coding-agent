// Test & Fix Agent: simulates build/test/fix loop
export async function testFixAgent(input: { buildFn: () => Promise<{ success: boolean; logs: string }> }) {
  let retries = 0;
  let result;
  try {
    do {
      result = await input.buildFn();
      if (result.success) return { ...result, fixed: retries > 0 };
      retries++;
    } while (retries < 3);
    throw new Error('Build/test failed after 3 retries.');
  } catch (err) {
    throw err;
  }
}
