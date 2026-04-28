// Test & Fix Agent: simulates build/test/fix loop
export async function testFixAgent(input: { buildFn: () => Promise<{ success: boolean; logs: string }> }) {
  console.log('[testFixAgent] called with:', input);
  let retries = 0;
  let result;
  try {
    do {
      console.log(`[testFixAgent] Attempt ${retries + 1}`);
      result = await input.buildFn();
      console.log('[testFixAgent] buildFn result:', result);
      if (result.success) {
        console.log('[testFixAgent] Success:', { ...result, fixed: retries > 0 });
        return { ...result, fixed: retries > 0 };
      }
      retries++;
    } while (retries < 3);
    throw new Error('Build/test failed after 3 retries.');
  } catch (err) {
    console.error('[testFixAgent] error:', err);
    throw err;
  }
}
