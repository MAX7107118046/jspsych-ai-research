import type { JsPsych } from 'jspsych';
import { initializeFeature } from './features';
import { parameters, type AITrialInput, type AITrialOptions } from './parameters';
import { TrialRuntime } from './runtime';
import { DATA_VERSION, JSPSYCH_VERSION, PLUGIN_VERSION, type ResearchMode } from './core/types';
import { simulateResearchTrial } from './simulation';

function definition(mode: ResearchMode, starts = false) {
  return { name: `ai-${mode}`, version: PLUGIN_VERSION, parameters: { ...parameters, start_with_ai: { ...parameters.start_with_ai, default: starts } } };
}

class ResearchPlugin {
  static mode: ResearchMode = 'chat';
  constructor(readonly jsPsych: JsPsych) {}
  simulate(trial: AITrialOptions, mode: string, options: { data?: Record<string, unknown> }, loadCallback: () => void): void {
    const Constructor = this.constructor as typeof ResearchPlugin;
    simulateResearchTrial(this.jsPsych, Constructor.mode, trial, mode, options, loadCallback);
  }
  trial(display: HTMLElement, options: AITrialOptions): void {
    try {
      const Constructor = this.constructor as typeof ResearchPlugin;
      const runtime = new TrialRuntime(this.jsPsych, display, Constructor.mode, options);
      void runtime.run(() => initializeFeature(runtime));
    } catch (error) {
      this.jsPsych.finishTrial({ ai_data_version: DATA_VERSION, ai_plugin_version: PLUGIN_VERSION,
        jspsych_runtime_version: JSPSYCH_VERSION, ai_status: 'error', error: String(error) });
    }
  }
}

export class AIChatPlugin extends ResearchPlugin { static mode = 'chat' as const; static info = definition('chat'); }
export class AIInterviewPlugin extends ResearchPlugin { static mode = 'interview' as const; static info = definition('interview', true); }
export class AISurveyPlugin extends ResearchPlugin { static mode = 'survey' as const; static info = definition('survey'); }
export class AIFeedbackPlugin extends ResearchPlugin { static mode = 'feedback' as const; static info = definition('feedback', true); }
export class AIAdvicePlugin extends ResearchPlugin { static mode = 'advice' as const; static info = definition('advice'); }
export class AIGeneratePlugin extends ResearchPlugin { static mode = 'generate' as const; static info = definition('generate', true); }
export class AICoeditPlugin extends ResearchPlugin { static mode = 'coedit' as const; static info = definition('coedit', true); }
export class AILearningPlugin extends ResearchPlugin { static mode = 'learning' as const; static info = definition('learning'); }
export class AIMultiAgentPlugin extends ResearchPlugin { static mode = 'multiagent' as const; static info = definition('multiagent', true); }

export const PLUGINS = {
  chat: AIChatPlugin, interview: AIInterviewPlugin, survey: AISurveyPlugin, feedback: AIFeedbackPlugin,
  advice: AIAdvicePlugin, generate: AIGeneratePlugin, coedit: AICoeditPlugin, learning: AILearningPlugin, multiagent: AIMultiAgentPlugin
};

export function createAITrial(mode: ResearchMode, options: AITrialInput = {}) {
  if (!PLUGINS[mode]) throw new Error(`未知研究功能：${mode}`);
  return { type: PLUGINS[mode], ...options };
}
