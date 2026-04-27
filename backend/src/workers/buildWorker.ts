// Build/test worker: simulate build/test process
export async function runBuildWorker(payload: any) {
  // Simulate build/test (replace with real logic)
  console.log('Running build/test for:', payload);
  await new Promise((res) => setTimeout(res, 500));
  // Simulate success/failure
  const success = Math.random() > 0.1;
  return { success, logs: success ? 'Build/test passed.' : 'Build/test failed.' };
}
