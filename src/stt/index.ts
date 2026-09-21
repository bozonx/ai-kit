/**
 * `@bozonx/ai-kit/stt` — speech extras.
 *
 * Transcribing itself is `AiKit.transcribe` and `AiKit.transcribeStream` from
 * the main entry point. What is here is everything around it: the adapters, for
 * a consumer that wraps or replaces one, the interfaces a new adapter
 * implements, subtitles, and the audio helpers a live capture needs.
 */

export { assemblyAiSttProvider } from './providers/assemblyai.js';
export { deepgramSttProvider } from './providers/deepgram.js';
export { groqSttProvider } from './providers/groq.js';

export type {
  SttProvider,
  SttProviderFactory,
  SttStreamEvent,
  ProviderTranscribeRequest,
  ProviderStreamRequest,
} from './types.js';

export { assertSttCapabilities } from './policy.js';

export { segmentWords } from './segment-words.js';
export type { SegmentWord } from './segment-words.js';

export { renderSubtitles } from './subtitles.js';
export type {
  SubtitleFormat,
  SubtitleSegment,
  SubtitleWord,
  RenderSubtitlesOptions,
} from './subtitles.js';

export { estimateAudioSeconds, pcm16Rms, pcm16ToWav, SilenceDetector } from './audio.js';
export type { SilenceDetectorOptions } from './audio.js';

export { PhraseChunker } from './phrases.js';
export type { Phrase, PhraseChunkerOptions } from './phrases.js';
