import type { OrchestrationAdapter, OrchestrationEmitEvent } from '../ai/contracts/orchestration';

type Sender = { send: (data: string) => void };

export function createOrchestrationAdapter(ws: Sender): OrchestrationAdapter {
  return {
    emit: (event: OrchestrationEmitEvent) => {
      try {
        ws.send(JSON.stringify(event));
      } catch {
        // socket may be closed mid-pipeline; orchestrator continues and
        // persistence still records progress.
      }
    },
  };
}
