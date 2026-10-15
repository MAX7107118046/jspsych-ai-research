import { AIError } from '../core/types';
import type { TrialRuntime } from '../runtime';
import { button, element } from '../view';
import { createSpeechClient } from './client';
import { encodeWave, PCMPlayer, resampleAudio } from './audio';
import type { MediaReference, SpeechClientLike, SynthesisConnection } from './types';

export class SpeechController {
  readonly area = element('section', 'ai-speech');
  readonly turns: Array<Record<string, unknown>> = [];
  readonly playback: Array<Record<string, unknown>> = [];
  private client: SpeechClientLike;
  private context?: AudioContext;
  private player?: PCMPlayer;
  private stream?: MediaStream;
  private processor?: ScriptProcessorNode;
  private source?: MediaStreamAudioSourceNode;
  private muted?: GainNode;
  private output?: SynthesisConnection;
  private outputAbort?: AbortController;
  private asrAbort?: AbortController;
  private outputRecord?: Record<string, unknown>;
  private outputFlushed = false;
  private rendered = '';
  private buffered = '';
  private epoch = 0;
  private frames: Float32Array[] = [];
  private preRoll: Float32Array[] = [];
  private speaking = false;
  private speechStarted = 0;
  private lastVoice = 0;
  private captureStarted = 0;
  private segmentId = '';
  private pending: Promise<void> = Promise.resolve();
  private active = true;
  private recording = false;
  private status = element('p', 'ai-speech-status');
  private captureStatus = element('p', 'ai-capture-status', '收音尚未开启');
  private meter = element('meter', 'ai-microphone-level');
  private device = element('select');
  private meterAt = 0;
  private captureAttempt = 0;
  private noise: number[] = [];
  private noiseFloor = 0;
  private playbackStatus = element('p', 'ai-playback-status');
  private outputFinished: Promise<void> = Promise.resolve();
  private resolveOutput: () => void = () => {};

  constructor(readonly runtime: TrialRuntime) {
    this.client = runtime.options.speech_client ?? createSpeechClient({ proxyURL: runtime.options.speech?.proxy_url });
    runtime.result.speech_turns = this.turns; runtime.result.speech_playback = this.playback; runtime.result.media = [];
    this.area.append(element('strong', '', '语音互动'), this.status);
    this.status.setAttribute('role', 'status');
    this.meter.min = 0; this.meter.max = 0.1; this.meter.value = 0; this.meter.setAttribute('aria-label', '麦克风输入音量');
    this.device.setAttribute('aria-label', '选择麦克风'); this.device.append(new Option('系统默认麦克风', ''));
    this.device.addEventListener('change', () => { this.runtime.options.speech!.device_id = this.device.value; if (this.recording) { this.stopCapture(); void this.startCapture().catch(error => this.error(error)); } });
    this.area.append(this.device, this.meter, this.captureStatus, this.playbackStatus);
    const mode = runtime.options.speech?.input_mode ?? 'automatic';
    const enable = button(mode === 'automatic' ? '开启连续收音' : '启用播报', () => { enable.disabled = true; void this.unlock().then(async () => {
      if (mode === 'automatic') { if (this.recording) { this.stopCapture(); enable.textContent = '开启连续收音'; } else { await this.startCapture(); enable.textContent = '停止收音'; } }
    }).catch(error => this.error(error)).finally(() => { enable.disabled = false; }); }, 'ai-secondary');
    this.area.append(enable, button('打断播报', () => this.interrupt('button'), 'ai-secondary'));
    if (mode === 'push-to-talk') {
      const talk = button('按住说话', () => {}, 'ai-secondary');
      const start = () => { void this.startCapture().catch(error => this.error(error)); };
      const stop = () => { this.segment(); this.stopCapture(); };
      talk.addEventListener('pointerdown', event => { talk.setPointerCapture(event.pointerId); start(); });
      talk.addEventListener('pointerup', stop); talk.addEventListener('pointercancel', stop);
      talk.addEventListener('keydown', event => { if (event.code === 'Space' && !event.repeat) { event.preventDefault(); start(); } });
      talk.addEventListener('keyup', event => { if (event.code === 'Space') { event.preventDefault(); stop(); } });
      this.area.append(talk);
    }
    if (mode !== 'off') {
      const file = element('input'); file.type = 'file'; file.accept = 'audio/*'; file.setAttribute('aria-label', '转录音频文件');
      file.addEventListener('change', () => { const blob = file.files?.[0]; if (blob) { this.interrupt('audio_file'); void this.unlock().catch(error => this.error(error)); this.enqueue(blob, 'file'); } });
      this.area.append(file);
    }
    runtime.view.root.insertBefore(this.area, runtime.view.status);
    runtime.onCleanup(() => this.dispose());
  }

  private async unlock(): Promise<void> {
    this.context ??= new AudioContext();
    this.area.dataset.audioState = this.context.state;
    if (this.context.state === 'suspended') {
      this.status.textContent = '正在启动浏览器音频引擎…';
      let timer: ReturnType<typeof setTimeout>;
      try { await Promise.race([this.context.resume(), new Promise<never>((resolve, reject) => { timer = setTimeout(() => reject(new AIError('audio_context_blocked', '当前浏览器没有启动音频引擎，请用桌面 Chrome 打开此页。')), 4000); })]); }
      finally { clearTimeout(timer!); }
    }
    this.area.dataset.audioState = this.context.state;
    this.player ??= new PCMPlayer(this.context, (type, detail) => this.playbackEvent(type, detail));
  }

  private playbackEvent(type: string, detail: unknown): void {
    if (this.outputRecord) {
      const time = performance.now() - this.runtime.started;
      this.outputRecord[type === 'playback_start' ? 'playback_started_ms' : 'playback_ended_ms'] = time;
      if (type === 'playback_start') this.outputRecord.playback_wait_ms = time - Number(this.outputRecord.started_ms);
    }
    this.playbackStatus.textContent = type === 'playback_start' ? '正在播报，可以说话或点击按钮打断' : '本轮播报结束';
    this.area.dataset.playbackState = type === 'playback_start' ? 'playing' : 'ended';
    if (type === 'playback_end') this.resolveOutput();
    this.runtime.emit(`speech_${type}`, { output_id: this.outputRecord?.id, ...detail as object });
  }

  private error(error: unknown): void {
    if (this.runtime.done) return;
    this.status.textContent = error instanceof Error ? error.message : String(error);
    this.runtime.emit('speech_error', { message: this.status.textContent });
  }

  async startCapture(): Promise<void> {
    if (this.recording || !this.active) return;
    const attempt = ++this.captureAttempt;
    await this.unlock();
    this.status.textContent = '正在请求麦克风，请留意浏览器的设备提示…'; this.area.dataset.captureState = 'requesting';
    let timer: ReturnType<typeof setTimeout>;
    const pending = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, ...(this.runtime.options.speech?.device_id ? { deviceId: { exact: this.runtime.options.speech.device_id } } : {}) } }).then(stream => {
      if (attempt !== this.captureAttempt || !this.active || this.runtime.done) { stream.getTracks().forEach(track => track.stop()); throw new AIError('cancelled', '麦克风请求已结束'); } return stream;
    });
    let stream: MediaStream;
    try { stream = await Promise.race([pending, new Promise<never>((resolve, reject) => { timer = setTimeout(() => { this.captureAttempt++; this.area.dataset.captureState = 'unavailable'; reject(new AIError('microphone_waiting', '浏览器尚未提供麦克风。请查看设备提示，或在桌面 Chrome / Edge 中打开此页。')); }, this.runtime.options.speech?.microphone_timeout_ms ?? 10000); })]); }
    finally { clearTimeout(timer!); }
    if (!this.active || this.runtime.done) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream; this.recording = true; this.captureStarted = performance.now();
    this.noise = []; this.noiseFloor = 0;
    this.area.dataset.captureState = 'recording';
    const devices = await navigator.mediaDevices.enumerateDevices(); this.device.replaceChildren(new Option('系统默认麦克风', ''));
    devices.filter(device => device.kind === 'audioinput').forEach((device, index) => this.device.append(new Option(device.label || `麦克风 ${index + 1}`, device.deviceId)));
    this.device.value = this.runtime.options.speech?.device_id ?? '';
    this.source = this.context!.createMediaStreamSource(stream); this.processor = this.context!.createScriptProcessor(2048, 1, 1);
    this.muted = this.context!.createGain(); this.muted.gain.value = 0;
    this.source.connect(this.processor); this.processor.connect(this.muted); this.muted.connect(this.context!.destination);
    this.processor.onaudioprocess = event => this.capture(event.inputBuffer.getChannelData(0).slice());
    this.status.textContent = ''; this.captureStatus.textContent = '正在收音，音量条会随声音变化'; this.runtime.emit('speech_capture_start', { mode: this.runtime.options.speech?.input_mode ?? 'automatic', sample_rate: this.context!.sampleRate });
  }

  private capture(frame: Float32Array): void {
    if (!this.recording) return;
    const config = this.runtime.options.speech!; const now = performance.now();
    const rms = Math.sqrt(frame.reduce((total, sample) => total + sample * sample, 0) / frame.length);
    const manual = config.input_mode === 'push-to-talk';
    const adaptive = config.auto_threshold ?? config.threshold == null;
    if (adaptive && !manual && now - this.captureStarted < 400) {
      this.noise.push(rms); this.noiseFloor = [...this.noise].sort((first, second) => first - second)[Math.floor(this.noise.length * 0.2)] ?? 0;
      this.meter.value = rms; this.captureStatus.textContent = '正在测量环境音，请稍等'; return;
    }
    const threshold = adaptive ? Math.max(config.threshold ?? 0.008, this.noiseFloor * 2.2 + 0.002) : config.threshold ?? 0.008;
    this.area.dataset.inputThreshold = String(threshold);
    const voiced = manual || rms >= threshold;
    if (now - this.meterAt > 100) {
      this.meterAt = now; this.meter.value = rms; this.area.dataset.inputRms = String(rms);
      this.captureStatus.textContent = voiced ? '听到声音，停顿后开始转录' : now - this.captureStarted > 5000 && rms < 0.0001 ? '尚未收到声音，请检查麦克风选择和输入音量' : '正在听，等待说话';
    }
    if (voiced && !this.speaking) {
      this.interrupt('voice_activity'); this.speaking = true; this.speechStarted = now; this.segmentId = crypto.randomUUID(); this.frames = this.preRoll.splice(0);
      this.runtime.emit('speech_segment_start', { turn_id: this.segmentId, rms, threshold, pre_roll_ms: config.pre_roll_ms ?? 200 });
    }
    if (voiced) this.lastVoice = now;
    if (this.speaking) this.frames.push(frame);
    else {
      this.preRoll.push(frame);
      const maximum = Math.ceil((config.pre_roll_ms ?? 200) / 1000 * this.context!.sampleRate / frame.length);
      while (this.preRoll.length > maximum) this.preRoll.shift();
    }
    if (this.speaking && (now - this.speechStarted >= (config.max_segment_ms ?? 20000) || !manual && now - this.lastVoice >= (config.silence_ms ?? 600))) this.segment();
  }

  private segment(): void {
    if (!this.frames.length) return;
    const duration = performance.now() - this.speechStarted;
    const frames = this.frames.splice(0); this.speaking = false; this.preRoll = [];
    if (duration < (this.runtime.options.speech?.min_speech_ms ?? 300)) { this.runtime.emit('speech_segment_discarded', { duration_ms: duration }); return; }
    const samples = new Float32Array(frames.reduce((total, frame) => total + frame.length, 0)); let offset = 0;
    frames.forEach(frame => { samples.set(frame, offset); offset += frame.length; });
    const blob = encodeWave(resampleAudio(samples, this.context!.sampleRate, 16000), 16000);
    this.runtime.emit('speech_segment_end', { turn_id: this.segmentId, duration_ms: duration, bytes: blob.size }); this.enqueue(blob, 'microphone', { id: this.segmentId, capture_started_ms: this.speechStarted - this.runtime.started, capture_ended_ms: performance.now() - this.runtime.started });
  }

  private stopCapture(): void {
    this.captureAttempt++;
    if (!this.recording && !this.stream) return;
    this.segment(); this.recording = false; this.processor?.disconnect(); this.source?.disconnect(); this.muted?.disconnect();
    if (this.processor) this.processor.onaudioprocess = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
    this.area.dataset.captureState = 'stopped'; this.meter.value = 0;
    this.captureStatus.textContent = '收音已停止'; this.runtime.emit('speech_capture_end', { duration_ms: performance.now() - this.captureStarted });
  }

  enqueue(blob: Blob, source: string, timing: Record<string, unknown> = {}): void {
    const queuedAt = performance.now();
    this.pending = this.pending.then(() => this.transcribe(blob, source, { ...timing, queued_at: queuedAt })).catch(error => this.error(error));
  }

  async transcribe(blob: Blob, source = 'file', timing: Record<string, unknown> = {}): Promise<void> {
    if (!this.active || this.runtime.done || !this.runtime.aiEnabled && this.runtime.mode === 'learning') return;
    const id = String(timing.id ?? crypto.randomUUID()); const started = performance.now(); const abort = new AbortController(); this.asrAbort = abort;
    const turn: Record<string, unknown> = { id, source, status: 'transcribing', recorded_ms: started - this.runtime.started, queued_ms: started - Number(timing.queued_at ?? started), capture_started_ms: timing.capture_started_ms ?? null, capture_ended_ms: timing.capture_ended_ms ?? null, bytes: blob.size, mime_type: blob.type };
    this.turns.push(turn); this.status.textContent = '正在转录'; this.runtime.emit('speech_asr_start', { turn_id: id });
    const progress = setInterval(() => { if (!this.runtime.done && turn.status === 'transcribing') this.status.textContent = `正在转录，已等待 ${Math.floor((performance.now() - started) / 1000)} 秒`; }, 250);
    this.runtime.onCleanup(() => clearInterval(progress));
    if (this.runtime.options.speech?.save_audio) {
      const reference: MediaReference = { id: crypto.randomUUID(), kind: 'recording', mime_type: blob.type, bytes: blob.size, turn_id: id, status: 'callback_missing' };
      if (this.runtime.options.persist_media) Object.assign(reference, await this.runtime.options.persist_media(blob, { ...reference, status: 'pending' }), { status: 'saved' });
      (this.runtime.result.media as MediaReference[]).push(reference); turn.media_id = reference.id;
    }
    try {
      const result = await this.client.transcribe(blob, { signal: abort.signal, language: this.runtime.options.speech?.language ?? 'zh' });
      if (this.runtime.done || abort.signal.aborted) return;
      Object.assign(turn, { original_transcript: result.text, asr_model: result.model, asr_ms: result.requestMs, asr_first_delta_ms: result.firstDeltaMs ?? null, audio_duration: result.duration, transcribed_ms: performance.now() - this.runtime.started });
      this.runtime.emit('speech_transcript', { turn_id: id, text: result.text, request_ms: result.requestMs });
      let text = result.text;
      if (!text.trim()) { turn.status = 'no_speech'; turn.corrected_transcript = ''; this.status.textContent = '没有识别到清晰语音，可以换一个麦克风或上传音频测试'; return; }
      if (this.runtime.options.speech?.review_transcript !== false) {
        turn.status = 'reviewing';
        this.status.textContent = '转录完成，请确认或修正文字';
        const reviewStarted = performance.now(); const form = element('div', 'ai-transcript-review'); const input = element('textarea'); input.value = text; input.setAttribute('aria-label', '确认转录');
        text = await new Promise<string>((resolve, reject) => {
          form.append(input, button('确认并发送', () => { if (input.value.trim()) { form.remove(); resolve(input.value.trim()); } }), button('丢弃转录', () => { form.remove(); resolve(''); }, 'ai-secondary'));
          this.area.append(form); this.runtime.onCleanup(() => reject(new AIError('cancelled', '试次已结束')));
        });
        turn.review_ms = performance.now() - reviewStarted;
      }
      turn.corrected_transcript = text; turn.corrected = text !== result.text; turn.discarded = !text;
      if (!text) this.status.textContent = '已丢弃转录';
      this.runtime.emit('speech_transcript_confirmed', { turn_id: id, original: result.text, text, corrected: turn.corrected, discarded: !text });
      if (text && !this.runtime.done) {
        await this.runtime.whenIdle(); if (this.runtime.done) return;
        turn.committed_ms = performance.now() - this.runtime.started; this.status.textContent = '';
        this.runtime.activeSpeechTurnId = id;
        await this.runtime.speechInput(text);
        turn.response_ready_ms = performance.now() - this.runtime.started; turn.total_wait_ms = performance.now() - started;
      }
      turn.status = text ? 'complete' : 'discarded';
    } catch (error) { turn.error = String(error); if (!abort.signal.aborted) throw error; }
    finally { clearInterval(progress); if (this.asrAbort === abort) this.asrAbort = undefined; if (this.runtime.activeSpeechTurnId === id) this.runtime.activeSpeechTurnId = null; }
  }

  beginOutput(): void {
    if (!this.active || this.runtime.options.speech?.output === false) return;
    this.stopOutput('next_output');
    this.outputFinished = new Promise(resolve => { this.resolveOutput = resolve; });
    this.context ??= new AudioContext();
    this.player ??= new PCMPlayer(this.context, (type, detail) => this.playbackEvent(type, detail));
    this.playbackStatus.textContent = '正在准备播报'; this.area.dataset.playbackState = 'synthesizing';
    const epoch = ++this.epoch; const config = this.runtime.options.speech!; const abort = new AbortController(); this.outputAbort = abort;
    const record: Record<string, unknown> = { id: crypto.randomUUID(), input_turn_id: this.runtime.activeSpeechTurnId, started_ms: performance.now() - this.runtime.started, text: '', audio_bytes: 0, status: 'pending' };
    this.outputRecord = record; this.playback.push(record); this.rendered = ''; this.buffered = '';
    this.output = this.client.synthesize({ turn_id: String(record.id), voice_id: config.voice_id, sample_rate: config.sample_rate ?? 16000, language: config.language ?? 'zh', signal: abort.signal,
      onAudio: (bytes, rate) => {
        if (this.runtime.done || epoch !== this.epoch || abort.signal.aborted) return;
        if (!record.first_packet_ms) { record.first_packet_ms = performance.now() - this.runtime.started; record.first_packet_wait_ms = Number(record.first_packet_ms) - Number(record.started_ms); record.tts_first_packet_ms = Number(record.first_packet_ms) - Number(record.text_first_sent_ms ?? record.started_ms); }
        record.audio_bytes = Number(record.audio_bytes) + bytes.length;
        if (this.context!.state === 'suspended') { record.playback_blocked = true; this.status.textContent = '点击“启用播报”或收音按钮播放语音'; }
        this.player!.append(bytes, rate);
      }, onEvent: (type, detail) => this.runtime.emit('speech_synthesis_event', { output_id: record.id, type, detail }) });
  }

  streamText(text: string): void {
    if (!this.output) return;
    if (!text.startsWith(this.rendered)) this.beginOutput();
    const delta = text.slice(this.rendered.length); this.rendered = text; this.buffered += delta;
    if (this.outputRecord) this.outputRecord.text = text;
    const boundary = Math.max(this.buffered.lastIndexOf('。'), this.buffered.lastIndexOf('！'), this.buffered.lastIndexOf('？'), this.buffered.lastIndexOf('\n'), this.buffered.lastIndexOf('. '));
    if (boundary >= 0 || this.buffered.length >= 100) { const end = boundary >= 0 ? boundary + 1 : this.buffered.length; if (this.outputRecord) this.outputRecord.text_first_sent_ms ??= performance.now() - this.runtime.started; this.output.write(this.buffered.slice(0, end)); this.buffered = this.buffered.slice(end); }
  }

  completeOutput(text: string): void {
    if (!this.active || this.runtime.options.speech?.output === false) return;
    if (!this.output || this.outputFlushed) this.beginOutput();
    if (!this.output) return;
    this.streamText(text); if (this.buffered) { this.outputRecord!.text_first_sent_ms ??= performance.now() - this.runtime.started; this.output.write(this.buffered); } this.buffered = '';
    const output = this.output; const record = this.outputRecord!; record.text = text;
    this.outputFlushed = true;
    void output.flush().then(() => { if (record.status === 'interrupted') return; record.status = 'complete'; record.synthesis_ended_ms = performance.now() - this.runtime.started; this.player?.finish(); if (!record.audio_bytes) this.resolveOutput(); this.runtime.emit('speech_synthesis_complete', { output_id: record.id }); }).catch(error => {
      if (record.status === 'interrupted') return; record.status = 'error'; record.error = String(error); this.resolveOutput(); this.error(error);
    });
  }

  private stopOutput(reason: string): void {
    this.resolveOutput();
    this.epoch++; const position = this.player?.stop();
    if (this.outputRecord && !this.outputRecord.playback_ended_ms) {
      this.playbackStatus.textContent = '播报已打断'; this.area.dataset.playbackState = 'interrupted';
      Object.assign(this.outputRecord, { status: 'interrupted', interrupted_ms: performance.now() - this.runtime.started, interruption: reason, ...position });
      this.runtime.emit('speech_interrupted', { output_id: this.outputRecord.id, reason, ...position });
    }
    this.outputAbort?.abort(); this.output?.cancel(); this.output = undefined; this.outputRecord = undefined; this.outputFlushed = false;
  }

  interrupt(reason = 'participant'): void { this.stopOutput(reason); this.runtime.cancelRequest('语音插话'); }
  waitForOutput(): Promise<void> { return this.outputFinished; }
  disable(): void { this.active = false; this.stopCapture(); this.interrupt('ai_withdrawn'); this.asrAbort?.abort(); this.area.hidden = true; }
  dispose(): void {
    this.active = false; this.stopCapture(); this.interrupt('trial_end');
    this.asrAbort?.abort();
    for (const turn of this.turns) if (['transcribing', 'reviewing'].includes(String(turn.status))) { turn.status = 'interrupted'; turn.ended_ms = performance.now() - this.runtime.started; }
    void this.context?.close();
  }
}
