export function resampleAudio(samples: Float32Array, sourceRate: number, targetRate = 16000): Float32Array {
  if (sourceRate === targetRate) return samples.slice();
  const ratio = sourceRate / targetRate;
  const result = new Float32Array(Math.round(samples.length / ratio));
  for (let index = 0; index < result.length; index++) {
    const start = Math.floor(index * ratio); const end = Math.min(samples.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let total = 0; for (let cursor = start; cursor < end; cursor++) total += samples[cursor];
    result[index] = total / (end - start);
  }
  return result;
}

export function encodeWave(samples: Float32Array, sampleRate = 16000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(buffer);
  const write = (offset: number, text: string) => { for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index)); };
  write(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, samples[index])) * 32767, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

export class PCMPlayer {
  private sources = new Map<AudioBufferSourceNode, { started: number; duration: number }>();
  private next = 0;
  private total = 0;
  private first = true;
  private pendingStart?: () => void;
  private flushed = false;
  private ended = false;
  constructor(readonly context: AudioContext, readonly event: (type: string, detail: unknown) => void) {}
  append(bytes: Uint8Array, sampleRate: number): void {
    const count = Math.floor(bytes.length / 2); if (!count) return;
    const buffer = this.context.createBuffer(1, count, sampleRate); const output = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
    for (let index = 0; index < count; index++) output[index] = view.getInt16(index * 2, true) / 32768;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    const started = Math.max(this.context.currentTime, this.next); this.next = started + buffer.duration; this.total += buffer.duration;
    this.sources.set(source, { started, duration: buffer.duration });
    source.onended = () => { this.sources.delete(source); source.disconnect(); this.checkEnd(); };
    source.start(started);
    if (this.first) {
      this.first = false;
      const announce = () => { if (this.context.state === 'running' && this.sources.size) { this.event('playback_start', { context_time: started, state: this.context.state }); this.context.removeEventListener('statechange', announce); this.pendingStart = undefined; } };
      if (this.context.state === 'running') announce();
      else { this.pendingStart = announce; this.context.addEventListener('statechange', announce); }
    }
  }
  stop(): { played_seconds: number; queued_seconds: number } {
    const now = this.context.currentTime;
    if (this.pendingStart) this.context.removeEventListener('statechange', this.pendingStart);
    this.pendingStart = undefined;
    const queued = [...this.sources.values()].reduce((total, source) => total + Math.max(0, source.started + source.duration - Math.max(now, source.started)), 0);
    for (const source of this.sources.keys()) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
    this.sources.clear(); this.next = now; this.first = true; this.flushed = false; this.ended = false;
    const result = { played_seconds: Math.max(0, this.total - queued), queued_seconds: queued }; this.total = 0;
    return result;
  }
  reset(): void { this.stop(); }
  finish(): void { this.flushed = true; this.checkEnd(); }
  private checkEnd(): void { if (this.flushed && !this.ended && !this.sources.size && this.total > 0) { this.ended = true; this.event('playback_end', { audio_seconds: this.total }); } }
}
