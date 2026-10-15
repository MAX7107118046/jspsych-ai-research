import type { TrialRuntime } from '../runtime';
import { validateResearch } from './helpers';
import { judgment } from './judgment';
import { learningResearch } from './learning';
import { interviewResearch } from './interview';
import { creationResearch } from './creation';
import { multiagentResearch } from './multiagent';
import { multimodalResearch } from './multimodal';

export function initializeResearch(runtime: TrialRuntime): void {
  const config = runtime.options.research!;
  validateResearch(runtime.mode, config);
  runtime.view.controls.hidden = true;
  runtime.finishBlocked = true;
  runtime.finishAction = () => { if (runtime.status !== 'complete') runtime.finish(); };
  const start = async () => {
    switch (config.group) {
      case 'judgment': return judgment(runtime, config);
      case 'learning': return learningResearch(runtime, config);
      case 'interview': return interviewResearch(runtime, config);
      case 'creation': return creationResearch(runtime, config);
      case 'multiagent': return multiagentResearch(runtime, config);
      case 'multimodal': return multimodalResearch(runtime, config);
    }
  };
  const timer = setTimeout(() => { void start().catch(async error => {
    if (runtime.done) return;
    runtime.emit('research_error', { message: String(error) });
    if (runtime.status === 'complete') await runtime.run(async () => { throw error; });
    runtime.finishAction = () => runtime.finish(runtime.status);
    runtime.updateControls();
  }); }, 0);
  runtime.onCleanup(() => clearTimeout(timer));
}
