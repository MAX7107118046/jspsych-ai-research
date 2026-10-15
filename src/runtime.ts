import type { JsPsych } from 'jspsych';
import { AIClient, validateStructuredResult } from './core/client';
import { ResearchSession } from './core/session';
import { AIError, DATA_VERSION, JSPSYCH_VERSION, PLUGIN_VERSION, type Agent, type AIRequest, type Completion, type ContentPart, type Message, type ResearchEvent, type ResearchMode } from './core/types';
import { parameters, type AITrialOptions, type CallRecord } from './parameters';
import { button, element, TrialView } from './view';
import type { PhaseRecord } from './research/types';
import { SpeechController } from './speech/controller';

export class TrialRuntime {
  readonly started = performance.now();
  readonly controller = new AbortController();
  readonly options: AITrialOptions;
  readonly session: ResearchSession;
  readonly view: TrialView;
  readonly events: ResearchEvent[] = [];
  readonly calls: CallRecord[] = [];
  readonly history: Message[];
  readonly responseWindows: number[] = [];
  readonly result: Record<string, unknown> = {};
  readonly phases: PhaseRecord[] = [];
  readonly speech?: SpeechController;
  controlsGuard: () => void = () => {};
  speechInput: (text: string) => void | Promise<void>;
  private idleWaiters: Array<() => void> = [];
  private finalizers: Array<() => void> = [];
  userTurns = 0;
  done = false;
  busy = false;
  status = 'complete';
  readyAt = performance.now();
  finishBlocked = false;
  retrying = false;
  aiEnabled = true;
  activeSpeechTurnId: string | null = null;
  sendAction: () => Promise<void> = async () => {};
  finishAction: () => void = () => this.finish();
  private requestController: AbortController | null = null;
  private client: Pick<AIClient, 'complete'> | null;
  private replayIndex = 0;
  private lastRegeneration: (() => Promise<void>) | null = null;
  private regenerationButton: HTMLButtonElement;
  private retryCount = 0;
  private speed: number;
  private paused = false;
  private trialTimer: ReturnType<typeof setTimeout> | undefined;
  private attached: ContentPart[];
  private recording: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private lastInput: Message | null = null;
  private inputPhases = new Set<number>();

  constructor(readonly jsPsych: JsPsych, display: HTMLElement, readonly mode: ResearchMode, raw: AITrialOptions) {
    const defaults = Object.fromEntries(Object.entries(parameters).map(([name, spec]) => [name, structuredClone(spec.default)]));
    this.options = { ...defaults, ...raw };
    this.session = this.options.session ?? new ResearchSession();
    this.history = this.options.memory_key ? this.session.history(this.options.memory_key) : [];
    this.client = this.options.client ?? (this.options.connection ? new AIClient({ connection: this.options.connection }) : null);
    this.speed = this.options.presentation?.characters_per_second ?? 0;
    this.attached = [...(this.options.initial_attachments ?? [])];
    this.view = new TrialView(display, {
      prompt: this.options.prompt ?? '', send: this.options.labels?.send ?? '发送', finish: this.options.labels?.finish ?? '完成'
    }, {
      send: () => { void this.run(this.sendAction); }, finish: () => this.finishAction(),
      cancel: () => this.requestController?.abort(new AIError('cancelled', '参与者取消请求'))
    });
    this.regenerationButton = button('重新生成', () => { if (this.lastRegeneration) void this.run(this.lastRegeneration); }, 'ai-secondary');
    this.regenerationButton.hidden = true;
    this.view.footer.prepend(this.regenerationButton);
    this.view.input.maxLength = this.options.max_input_characters ?? 10000;
    this.speechInput = async text => { this.view.input.value = text; await this.run(this.sendAction); };
    if (this.options.research) {
      this.result.research_group = this.options.research.group;
      this.result.research_config = structuredClone(this.options.research);
    }
    this.view.input.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); this.view.send.click(); }
    }, { signal: this.controller.signal });
    if (this.options.trial_duration != null) this.trialTimer = setTimeout(() => this.finish('timeout'), this.options.trial_duration);
    window.addEventListener('pagehide', () => this.finish('interrupted'), { once: true, signal: this.controller.signal });
    this.setupPresentation();
    this.setupAttachments();
    if (this.options.speech && this.options.speech.enabled !== false) this.speech = new SpeechController(this);
    this.emit('trial_start', { mode, delivery: this.options.delivery?.mode });
  }

  validate(): void {
    if (!Number.isInteger(this.options.max_turns) || this.options.max_turns! < 1) throw new AIError('configuration', 'max_turns 必须为正整数');
    if (!Number.isInteger(this.options.min_turns) || this.options.min_turns! < 0 || this.options.min_turns! > this.options.max_turns!) throw new AIError('configuration', 'min_turns 必须在 0 与 max_turns 之间');
    if (!Number.isInteger(this.options.history_window) || this.options.history_window! < 0) throw new AIError('configuration', 'history_window 必须为非负整数');
    if (this.options.trial_duration != null && this.options.trial_duration <= 0) throw new AIError('configuration', 'trial_duration 必须为正数');
    if (this.options.delivery?.mode === 'yoked' && !this.options.delivery.sourceParticipant) throw new AIError('configuration', '配对回放需要 sourceParticipant');
    if (!['live', 'pregenerated', 'replay', 'yoked'].includes(this.options.delivery?.mode ?? '')) throw new AIError('configuration', '未知材料呈现模式');
    for (const [name, value] of Object.entries(this.options.presentation ?? {})) {
      if (name !== 'allow_pause' && (!Number.isFinite(value) || Number(value) < 0)) throw new AIError('configuration', `presentation.${name} 必须为非负有限数值`);
    }
    if (!Number.isInteger(this.options.max_input_characters) || this.options.max_input_characters! < 1) throw new AIError('configuration', 'max_input_characters 必须为正整数');
  }

  emit(type: string, detail: unknown = null): void {
    if (this.done && type !== 'trial_finish') return;
    const event = { type, time: performance.now() - this.started, detail, ...(this.activeSpeechTurnId ? { speech_turn_id: this.activeSpeechTurnId } : {}), ...(this.phases.length ? { phase: this.phases.at(-1)!.name, phase_id: this.phases.at(-1)!.id } : {}) };
    this.events.push(event);
    try { this.options.on_event?.(event); }
    catch (error) { this.events.push({ type: 'callback_error', time: event.time, detail: String(error) }); }
  }

  async run(action: () => Promise<void>): Promise<void> {
    if (this.done || this.busy) return;
    this.busy = true;
    this.view.busy(true);
    this.regenerationButton.disabled = true;
    const previousControls = new Map([...this.view.content.querySelectorAll<HTMLButtonElement>('button')].map(control => [control, control.disabled]));
    for (const control of previousControls.keys()) control.disabled = true;
    try {
      await action();
      if (!this.done) {
        this.status = 'complete'; this.readyAt = performance.now();
        this.view.finish.textContent = this.options.labels?.finish ?? '完成';
        this.view.status.setAttribute('role', 'status');
      }
    } catch (caught) {
      if (!this.done) this.fail(caught, action);
    } finally {
      this.busy = false;
      if (!this.done) {
        const message = this.view.status.textContent;
        this.view.busy(false);
        this.view.status.textContent = message === '正在生成…' ? '' : message;
        this.regenerationButton.disabled = false;
        previousControls.forEach((disabled, control) => { if (control.isConnected) control.disabled = disabled; });
        this.updateControls();
      }
      this.idleWaiters.splice(0).forEach(resolve => resolve());
    }
  }

  private fail(caught: unknown, retry: () => Promise<void>): void {
    const error = caught instanceof AIError ? caught : new AIError('trial_error', caught instanceof Error ? caught.message : String(caught));
    if (['empty_input', 'input_too_long', 'invalid_media', 'media_too_large'].includes(error.code)) {
      this.emit('validation_error', { code: error.code, message: error.message });
      this.view.status.setAttribute('role', 'alert'); this.view.status.textContent = error.message; return;
    }
    this.emit('error', { code: error.code, message: error.message });
    this.status = error.code === 'cancelled' ? 'cancelled' : 'error';
    this.view.status.setAttribute('role', 'alert');
    this.view.status.textContent = error.message;
    if (this.options.error_policy === 'retry' && this.retryCount < (this.options.max_retries ?? 1)) {
      const retryButton = button('重试', () => {
        retryButton.remove(); this.retryCount++; this.retrying = true; this.emit('retry', { attempt: this.retryCount });
        void this.run(retry).finally(() => { this.retrying = false; });
      }, 'ai-secondary');
      this.view.footer.prepend(retryButton);
    }
    this.view.finish.textContent = '结束试次';
  }

  updateControls(): void {
    const exhausted = this.userTurns >= (this.options.max_turns ?? 3);
    this.view.send.disabled = exhausted || (this.status === 'error' && this.options.error_policy === 'stop');
    this.view.input.disabled = this.view.send.disabled;
    this.view.finish.disabled = this.status === 'complete' && (this.finishBlocked || this.userTurns < (this.options.min_turns ?? 0));
    this.controlsGuard();
  }

  whenIdle(): Promise<void> { return this.busy ? new Promise(resolve => this.idleWaiters.push(resolve)) : Promise.resolve(); }

  cancelRequest(reason = '参与者打断'): void { this.requestController?.abort(new AIError('cancelled', reason)); }

  onCleanup(action: () => void): void { this.finalizers.push(action); }

  beginPhase(name: string, participant = false): PhaseRecord {
    this.endPhase();
    const phase = { id: this.phases.length + 1, name, started_ms: performance.now() - this.started, participant };
    this.phases.push(phase);
    this.view.root.dataset.phase = name;
    this.emit('phase_start', { name, participant });
    this.readyAt = performance.now();
    return phase;
  }

  endPhase(response?: unknown): void {
    const phase = this.phases.at(-1);
    if (!phase || phase.ended_ms != null) return;
    phase.ended_ms = performance.now() - this.started;
    if (response !== undefined) phase.response = structuredClone(response);
    if (phase.participant && !this.inputPhases.has(phase.id)) this.responseWindows.push(phase.ended_ms - phase.started_ms);
    this.emit('phase_end', { name: phase.name, response, duration_ms: phase.ended_ms - phase.started_ms });
  }

  async showText(text: string, label = this.options.labels?.assistant ?? 'AI'): Promise<HTMLElement> {
    const body = this.view.message(label, '', 'assistant');
    await this.present(body, { text, model: 'fixed', requestMs: 0, firstTokenMs: null, attempts: 0, requestedModel: 'fixed' });
    await this.speech?.waitForOutput();
    return body;
  }

  observeImage(image: HTMLImageElement, detail: Record<string, unknown> = {}): void {
    const started = performance.now();
    let settled = false;
    const loaded = () => {
      if (settled || this.done) return;
      settled = true;
      requestAnimationFrame(() => { if (!this.done) this.emit('image_presented', { ...detail, load_ms: performance.now() - started, width: image.naturalWidth, height: image.naturalHeight }); });
    };
    image.addEventListener('load', loaded, { once: true, signal: this.controller.signal });
    image.addEventListener('error', () => { settled = true; this.emit('image_error', detail); }, { once: true, signal: this.controller.signal });
    if (image.complete && image.naturalWidth) loaded();
  }

  takeInput(): Message {
    if (this.retrying && this.lastInput) return this.lastInput;
    const text = this.view.input.value.trim();
    if (!text && !this.attached.length) throw new AIError('empty_input', '请填写回答或添加材料');
    if (text.length > this.options.max_input_characters!) throw new AIError('input_too_long', '输入超过当前试次的字符上限');
    const content: Message['content'] = this.attached.length ? [{ type: 'text', text }, ...this.attached] : text;
    const message: Message = { role: 'user', content };
    this.lastInput = message;
    this.history.push(message);
    this.userTurns++;
    this.responseWindows.push(performance.now() - this.readyAt);
    if (this.phases.length) this.inputPhases.add(this.phases.at(-1)!.id);
    this.result.response = text;
    this.emit('participant_response', { text, attachments: this.attached.map(part => part.type), turn: this.userTurns, rt: this.responseWindows.at(-1) });
    const body = this.view.message(this.options.labels?.participant ?? '参与者', text, 'user');
    this.renderInputMedia(body, this.attached);
    this.attached = [];
    this.view.root.querySelectorAll<HTMLInputElement>('.ai-attachments input[type=file]').forEach(input => { input.value = ''; });
    this.view.input.value = '';
    return message;
  }

  private requestMessages(history: Message[], agent?: Agent): Message[] {
    const prompt = element('div'); prompt.innerHTML = this.options.prompt ?? '';
    const context = [this.options.system_prompt, agent?.system_prompt, prompt.textContent].filter(Boolean).join('\n');
    const limit = this.options.history_window ?? 30;
    const windowed = limit === 0 ? history.slice(-1) : history.slice(-Math.max(1, limit));
    const attributed = agent ? windowed.map(message => message.agentId && message.agentId !== agent.id
      ? { role: 'user' as const, content: `[${message.agentId}] ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}` }
      : message) : windowed;
    return [{ role: 'system', content: context }, ...attributed];
  }

  async request(history: Message[], target?: HTMLElement, agent?: Agent, schema?: Record<string, unknown> | null): Promise<Completion> {
    if (!this.aiEnabled) throw new AIError('ai_disabled', '当前阶段采用独立作答');
    const request: AIRequest = {
      messages: this.requestMessages(history, agent), stream: this.options.stream,
      ...this.options.generation,
      ...(schema ?? this.options.response_schema ? { schema: schema ?? this.options.response_schema! } : {}),
      metadata: { mode: this.mode, phase: this.phases.at(-1)?.name, speech_turn_id: this.activeSpeechTurnId, condition: this.options.condition, agentId: agent?.id, sessionId: this.session.id,
        requestId: this.retrying ? this.calls.at(-1)?.request.metadata?.requestId ?? crypto.randomUUID() : crypto.randomUUID() }
    };
    const call: CallRecord = { id: this.calls.length + 1, agent_id: agent?.id, request: structuredClone(request),
      source: this.options.delivery!.mode, status: 'pending', started_ms: performance.now() - this.started };
    this.calls.push(call);
    this.emit('ai_request', { call_id: call.id, source: call.source, agent_id: agent?.id });
    const requestController = new AbortController();
    this.requestController = requestController;
    const abort = () => requestController.abort(this.controller.signal.reason);
    this.controller.signal.addEventListener('abort', abort, { once: true });
    const controlled = Boolean(this.speed || this.options.presentation?.delay_ms);
    if (target && !controlled && !request.schema) this.speech?.beginOutput();
    let streamed = '';
    try {
      let result: Completion;
      if (call.source !== 'live') {
        const material = this.options.delivery?.materials?.[this.replayIndex];
        if (!material) throw new AIError('material_exhausted', `回放材料不足，缺少第 ${this.replayIndex + 1} 条`);
        if (material.agentId && material.agentId !== agent?.id) throw new AIError('material_mismatch', '回放材料的代理与当前发言者不匹配');
        if (call.source === 'yoked' && material.sourceParticipant && material.sourceParticipant !== this.options.delivery?.sourceParticipant) throw new AIError('material_mismatch', '配对回放的来源参与者不匹配');
        this.replayIndex++;
        result = { ...material, model: material.model ?? call.source, requestMs: 0, firstTokenMs: null, attempts: 0, requestedModel: material.model ?? call.source };
      } else {
        const client = agent?.client ?? this.client;
        if (!client) throw new AIError('configuration', '实时生成需要 client 或 connection');
        const cancellation = new Promise<never>((_, reject) => requestController.signal.addEventListener('abort', () => reject(requestController.signal.reason), { once: true }));
        result = await Promise.race([client.complete(request, { signal: requestController.signal, onDelta: delta => {
          if (this.done || requestController.signal.aborted) return;
          streamed += delta;
          if (target && !controlled) target.textContent = this.visibleText(streamed);
          if (target && !controlled && !request.schema) this.speech?.streamText(this.visibleText(streamed));
        } }), cancellation]);
      }
      requestController.signal.throwIfAborted();
      if (this.done) throw new AIError('cancelled', '试次已结束');
      if (request.schema) validateStructuredResult(result, request.schema);
      call.result = result;
      call.status = 'complete';
      call.ended_ms = performance.now() - this.started;
      this.emit('ai_complete', { call_id: call.id, model: result.model, request_ms: result.requestMs });
      if (target) await this.present(target, result);
      return result;
    } catch (caught) {
      const error = caught instanceof AIError ? caught : new AIError('request_failed', caught instanceof Error ? caught.message : String(caught));
      call.status = requestController.signal.aborted ? 'cancelled' : 'error';
      call.error = { code: error.code, message: error.message, details: { ...error.details, partialText: error.details.partialText ?? streamed } };
      call.ended_ms = performance.now() - this.started;
      if (!this.done) this.emit('ai_error', { call_id: call.id, ...call.error });
      throw error;
    } finally {
      this.controller.signal.removeEventListener('abort', abort);
      requestController.abort(new AIError('cancelled', '调用已结束'));
      if (this.requestController === requestController) this.requestController = null;
    }
  }

  async reply(agent?: Agent, prompt?: string, after?: (result: Completion) => void): Promise<Completion> {
    const history = prompt ? [...this.history, { role: 'user' as const, content: prompt }] : [...this.history];
    const body = this.view.message(agent?.label ?? this.options.labels?.assistant ?? 'AI', '', 'assistant');
    const result = await this.request(history, body, agent);
    const historyIndex = this.history.length;
    if (prompt) this.history.push({ role: 'user', content: prompt });
    const assistantIndex = prompt ? historyIndex + 1 : historyIndex;
    this.history.push({ role: 'assistant', content: result.text, ...(agent ? { agentId: agent.id } : {}) });
    this.result.ai_output = result.data ?? result.text;
    after?.(result);
    this.lastRegeneration = async () => {
      body.textContent = '';
      this.emit('regenerate', { previous_call_id: this.calls.at(-1)?.id, agent_id: agent?.id });
      const replacement = await this.request(history, body, agent);
      this.history[assistantIndex] = { role: 'assistant', content: replacement.text, ...(agent ? { agentId: agent.id } : {}) };
      this.result.ai_output = replacement.data ?? replacement.text;
      after?.(replacement);
    };
    this.regenerationButton.hidden = !this.options.allow_regenerate;
    return result;
  }

  private visibleText(text: string): string {
    const maximum = this.options.presentation?.max_characters;
    return maximum == null ? text : Array.from(text).slice(0, maximum).join('');
  }

  disableAI(): void {
    this.speech?.disable();
    this.aiEnabled = false;
    this.lastRegeneration = null;
    this.regenerationButton.hidden = true;
    this.view.controls.hidden = true;
    this.view.cancel.hidden = true;
    this.view.transcript.hidden = true;
    this.emit('ai_disabled');
  }

  private async present(target: HTMLElement, result: Completion): Promise<void> {
    const started = performance.now();
    await this.wait(this.options.presentation?.delay_ms ?? 0);
    this.emit('presentation_start', { call_id: this.calls.at(-1)?.id });
    const text = this.visibleText(result.text);
    if (this.speed > 0) {
      target.textContent = '';
      for (const character of text) {
        while (this.paused && !this.done) await this.wait(40);
        this.controller.signal.throwIfAborted();
        target.textContent += character;
        await this.wait(1000 / Math.max(1, this.speed));
      }
    } else target.textContent = text;
    this.speech?.completeOutput(text);
    for (const media of result.media ?? []) {
      if (media.type === 'image') { const image = element('img'); image.src = media.url; image.alt = 'AI 生成图像'; target.append(image); this.observeImage(image, { source: 'model' }); }
      else { const audio = element('audio'); audio.src = media.url; audio.controls = true; target.append(audio); }
    }
    this.emit('presentation_end', { call_id: this.calls.at(-1)?.id, presentation_ms: performance.now() - started, displayed_characters: Array.from(text).length });
  }

  private wait(milliseconds: number): Promise<void> {
    this.controller.signal.throwIfAborted();
    if (!milliseconds) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(this.controller.signal.reason); };
      const timer = setTimeout(() => { this.controller.signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
      this.controller.signal.addEventListener('abort', abort, { once: true });
    });
  }

  private setupPresentation(): void {
    if (this.speed > 0) {
      const label = element('label', 'ai-question');
      const speed = element('input'); speed.type = 'range'; speed.min = '1'; speed.max = '200'; speed.value = String(this.speed);
      speed.setAttribute('aria-label', '每秒呈现字符数');
      speed.addEventListener('input', () => { this.speed = Number(speed.value); this.emit('presentation_speed', { characters_per_second: this.speed }); });
      label.append(element('span', '', '呈现速度'), speed);
      this.view.content.append(label);
    }
    if (this.options.presentation?.allow_pause) {
      const pause = button('暂停呈现', () => {
        this.paused = !this.paused; pause.textContent = this.paused ? '继续呈现' : '暂停呈现'; this.emit('presentation_pause', { paused: this.paused });
      }, 'ai-secondary');
      this.view.footer.prepend(pause);
    }
  }

  private renderInputMedia(body: HTMLElement, parts: ContentPart[]): void {
    for (const part of parts) {
      if (part.type === 'image') { const image = element('img'); image.src = part.url; image.alt = '参与者提供的图像'; body.append(image); this.observeImage(image, { source: 'participant' }); }
      if (part.type === 'audio') { const audio = element('audio'); audio.src = `data:${part.mimeType};base64,${part.data}`; audio.controls = true; body.append(audio); }
    }
  }

  private setupAttachments(): void {
    const options = this.options.attachments;
    if (!options || (!options.image && !options.audio && !options.record_audio)) return;
    const area = element('div', 'ai-attachments');
    for (const kind of ['image', 'audio'] as const) {
      if (!options[kind]) continue;
      const label = element('label', 'ai-question'); label.textContent = kind === 'image' ? '添加图像' : '添加音频';
      const input = element('input'); input.type = 'file'; input.accept = `${kind}/*`;
      input.addEventListener('change', () => { void this.run(async () => {
        const file = input.files?.[0]; if (!file) return;
        if (!file.type.startsWith(`${kind}/`)) throw new AIError('invalid_media', '文件类型与材料类型不符');
        await this.attachBlob(file, kind);
      }); });
      label.append(input); area.append(label);
    }
    if (options.record_audio) {
      const record = button('录音', () => { void this.toggleRecording(record); }, 'ai-secondary');
      area.append(record);
    }
    this.view.content.append(area);
  }

  private async attachBlob(blob: Blob, kind: 'image' | 'audio'): Promise<void> {
    if (blob.size > (this.options.attachments?.max_bytes ?? 10 * 1024 * 1024)) throw new AIError('media_too_large', '文件超过当前材料大小上限');
    const encoded = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
    });
    if (this.done) return;
    if (kind === 'image') this.attached.push({ type: 'image', url: encoded, mimeType: blob.type });
    else this.attached.push({ type: 'audio', data: encoded.slice(encoded.indexOf(',') + 1), mimeType: blob.type });
    this.emit('attachment_added', { type: kind, bytes: blob.size, mime_type: blob.type });
    this.view.status.textContent = '材料已添加';
  }

  private async toggleRecording(control: HTMLButtonElement): Promise<void> {
    if (this.done || this.busy) return;
    if (this.recording?.state === 'recording') { this.recording.stop(); control.textContent = '录音'; return; }
    try {
      if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) throw new AIError('recording_unavailable', '当前浏览器无法录音，请使用音频文件');
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.done) { this.mediaStream.getTracks().forEach(track => track.stop()); return; }
      const recorder = new MediaRecorder(this.mediaStream);
      this.recording = recorder;
      const chunks: Blob[] = [];
      recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener('stop', () => {
        this.mediaStream?.getTracks().forEach(track => track.stop());
        this.emit('recording_end', null);
        if (!this.done) void this.run(() => this.attachBlob(new Blob(chunks, { type: recorder.mimeType }), 'audio'));
      });
      recorder.start(); control.textContent = '停止录音'; this.emit('recording_start');
    } catch (error) { if (!this.done) this.fail(error, async () => this.toggleRecording(control)); }
  }

  finish(status = this.status): void {
    if (this.done || this.busy && status === 'complete') return;
    this.endPhase();
    this.finalizers.splice(0).forEach(action => action());
    this.done = true;
    if (this.trialTimer) clearTimeout(this.trialTimer);
    this.controller.abort(new AIError('cancelled', '试次已结束'));
    if (this.recording?.state === 'recording') this.recording.stop();
    this.mediaStream?.getTracks().forEach(track => track.stop());
    for (const call of this.calls) if (call.status === 'pending') {
      call.status = 'cancelled'; call.ended_ms = performance.now() - this.started;
      call.error = { code: status, message: '试次结束时请求仍在运行' };
    }
    if (this.options.memory_key) {
      this.session.clear(this.options.memory_key);
      this.session.append(this.options.memory_key, this.history);
    }
    this.emit('trial_finish', { status });
    const data: Record<string, unknown> = {
      ai_data_version: DATA_VERSION, ai_plugin_version: PLUGIN_VERSION, jspsych_runtime_version: JSPSYCH_VERSION,
      research_mode: this.mode, ai_status: status, ai_session_id: this.session.id, ai_seed: this.session.seed,
      condition: structuredClone(this.options.condition), delivery_mode: this.options.delivery!.mode,
      research_condition: structuredClone(this.options.condition),
      source_participant: this.options.delivery?.sourceParticipant ?? null,
      rt: performance.now() - this.started, participant_rt: this.responseWindows.reduce((total, value) => total + value, 0),
      response_windows: [...this.responseWindows], participant_turns: this.userTurns,
      messages: structuredClone(this.history), ai_calls: structuredClone(this.calls), events: structuredClone(this.events),
      ...(this.phases.length ? { phases: structuredClone(this.phases) } : {}), ...structuredClone(this.result)
    };
    const finish = () => this.jsPsych.finishTrial(data);
    if (!this.options.persist) { finish(); return; }
    let settled = false;
    const complete = () => { if (!settled) { settled = true; clearTimeout(timer); finish(); } };
    const timer = setTimeout(() => { data.persistence_status = 'timeout'; complete(); }, 2000);
    try {
      Promise.resolve(this.options.persist(data)).then(() => { if (settled) return; data.persistence_status = 'complete'; complete(); }, error => {
        if (settled) return;
        data.persistence_status = 'error'; data.persistence_error = String(error); complete();
      });
    } catch (error) { data.persistence_status = 'error'; data.persistence_error = String(error); complete(); }
  }
}
