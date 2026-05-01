// Test & Fix Agent
export async function testFixAgent(input: {
  buildFn: () => Promise<{ success: boolean; logs: string }>;
  fixFn?: (logs: string) => Promise<void>;
}) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[testFixAgent] called with:', input);
  }
  let retries = 0;
  let result: { success: boolean; logs: string } | undefined;
  try {
    do {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[testFixAgent] Attempt ${retries + 1}`);
      }
      result = await input.buildFn();
      if (process.env.NODE_ENV !== 'production') {
        console.log('[testFixAgent] buildFn result:', result);
      }
      if (result.success) {
        if (process.env.NODE_ENV !== 'production') {
          console.log('[testFixAgent] Success:', { ...result, fixed: retries > 0 });
        }
        return { ...result, fixed: retries > 0 };
      }
      // Attempt LLM-based fix before retrying
      if (input.fixFn && retries < 2) {
        console.log(`[testFixAgent] Build failed, attempting fix (retry ${retries + 1})...`);
        try {
          await input.fixFn(result.logs);
        } catch (fixErr) {
          console.error('[testFixAgent] fixFn error:', fixErr);
        }
      }
      retries++;
    } while (retries < 3);
    const lastLogs = result?.logs || 'No build output captured.';
    throw new Error(`Build failed after 3 attempts. Last error:\n${lastLogs.slice(-2000)}`);
  } catch (err) {
    console.error('[testFixAgent] error:', err);
    throw err;
  }
}
