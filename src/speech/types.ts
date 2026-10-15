export interface SpeechConfiguration {
  enabled?: boolean; input_mode?: 'automatic' | 'push-to-talk' | 'file' | 'off'; output?: boolean;
  review_transcript?: boolean; save_audio?: boolean; voice_id?: string; language?: string;
  sample_rate?: number; silence_ms?: number; min_speech_ms?: number; pre_roll_ms?: number;
  max_segment_ms?: number; threshold?: number; proxy_url?: string;
  device_id?: string;
  auto_threshold?: boolean;
  microphone_timeout_ms?: number;
}
export interface MediaReference { id: string; filename?: string; url?: string; mime_type: string; bytes: number; kind: 'recording' | 'image' | 'audio'; turn_id?: string; status?: string }
export interface TranscriptionResult { text: string; model: string; duration?: number; requestMs: number; firstDeltaMs?: number | null; metadata?: Record<string, unknown> }
export interface SynthesisOptions { voice_id?: string; sample_rate?: number; language?: string; turn_id: string; signal?: AbortSignal; onAudio: (audio: Uint8Array, sampleRate: number) => void; onEvent?: (type: string, detail?: unknown) => void }
export interface SynthesisConnection { write(text: string): void; flush(): Promise<void>; cancel(): void; close(): void }
export interface SpeechTransport {
  transcribe(audio: Blob, options: { signal?: AbortSignal; language?: string; onDelta?: (text: string) => void }): Promise<TranscriptionResult>;
  synthesize(options: SynthesisOptions): SynthesisConnection;
}
export interface SpeechClientLike extends SpeechTransport {}
