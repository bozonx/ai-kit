import type { AiErrorKind } from '../errors.js';
import type { RoutedBy } from '../ports.js';

/**
 * The vocabulary of speech-to-text.
 *
 * Everything here is about audio, models and providers, and nothing about
 * whose audio it is — the file it came from, who is paying for it and where the
 * result is stored are all the consumer's words.
 */

/** A stretch of speech with its place in time. Milliseconds throughout. */
export interface TranscriptSegment {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  /** Provider's speaker label when diarization was asked for and delivered. */
  speaker?: string;
  confidence?: number;
}

/** One word, for the callers that align text to a timeline. */
export interface WordTiming {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
}

/**
 * Where the audio is.
 *
 * A URL is the normal case and the cheap one: the provider fetches the bytes
 * itself, so a file already in object storage is never copied through us. Bytes
 * are for the audio that exists nowhere yet — a recording that has just been
 * made in a browser.
 */
export type AudioSource =
  | { url: string }
  | { data: Uint8Array | ReadableStream<Uint8Array>; mimeType: string };

/** What the caller wants done with the audio, beyond turning it into text. */
export interface TranscriptionOptions {
  /**
   * BCP-47 tag of the spoken language. Omitted asks the provider to detect it,
   * which every provider does worse than being told.
   */
  language?: string;
  punctuation?: boolean;
  diarization?: boolean;
  wordTimings?: boolean;
  /**
   * Terms to bias recognition towards: names, brands, jargon.
   *
   * Silently ignored by models that do not support it, because it is an
   * improvement rather than a requirement — refusing the call would trade a
   * slightly worse transcript for none at all.
   */
  keyterms?: string[];
}

/** One finished transcription, normalised across providers. */
export interface TranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  words?: WordTiming[];
  /** Detected, or echoed back from the request. */
  language?: string;
  /** Length of the audio as the provider measured it. This is what is billed. */
  audioSeconds: number;
  confidence?: number;
  /** The provider's own id for the job, for support requests. */
  providerRequestId?: string;
}

/** Audio arriving live, in the format every provider accepts without argument. */
export interface AudioChunk {
  /** PCM16 little-endian, mono, at `sampleRate`. */
  data: Uint8Array;
}

/** What a provider emits while a live session is open. */
export type SttStreamEvent =
  | { type: 'partial'; text: string; startMs: number }
  | { type: 'final'; segment: Omit<TranscriptSegment, 'index'> }
  /** The provider's own idea of the language, once it has one. */
  | { type: 'language'; language: string };

export interface ProviderTranscribeRequest {
  /** The provider's own model id, from the catalog. */
  modelId: string;
  source: AudioSource;
  options: TranscriptionOptions;
  signal: AbortSignal;
}

export interface ProviderStreamRequest {
  modelId: string;
  options: TranscriptionOptions;
  /** Sample rate of the PCM the caller is about to send, in hertz. */
  sampleRate: number;
  audio: AsyncIterable<AudioChunk>;
  signal: AbortSignal;
}

/**
 * The port every speech provider implements.
 *
 * `transcribeStream` is optional because most providers do not have it, and a
 * method that throws "not supported" is a worse contract than one that is
 * absent: the absence is visible to the type system and to the registry.
 *
 * It resolves when the session is open rather than returning the iterable
 * directly, so that "the provider would not connect" is a failure the retry
 * loop can act on, while "nobody has said anything yet" is not.
 */
export interface SttProvider {
  transcribe(request: ProviderTranscribeRequest): Promise<TranscriptionResult>;
  transcribeStream?(request: ProviderStreamRequest): Promise<AsyncIterable<SttStreamEvent>>;
}

/** How a provider adapter is built. Mirrors the language-model registry. */
export type SttProviderFactory = (init: {
  apiKey: string;
  /** Set when the catalog points the model at a non-default endpoint. */
  baseUrl?: string;
}) => SttProvider;

/**
 * The parts a live transcription is made of.
 *
 * The whole design rests on one rule: a `partial` may be rewritten in full, a
 * `final` never changes. Text shown as settled and then altered reads as a bug
 * to the person watching it appear, and no amount of accuracy makes up for it.
 */
export interface TranscriptModelPart {
  type: 'model';
  provider: string;
  model: string;
  routedBy: RoutedBy;
}

/** A draft of what is being said right now. Replaced wholesale, not appended. */
export interface TranscriptPartialPart {
  type: 'partial';
  text: string;
  startMs: number;
}

/** Settled speech. Safe to write into a document. */
export interface TranscriptFinalPart {
  type: 'final';
  segment: TranscriptSegment;
}

/** Final accounting. Arrives once, whether the session ended well or not. */
export interface TranscriptUsagePart {
  type: 'usage';
  audioSeconds: number;
  costMicros: number;
  priceVersion: string;
}

export interface TranscriptErrorPart {
  type: 'error';
  kind: AiErrorKind;
  message: string;
  recoverable: boolean;
}

export interface TranscriptFinishPart {
  type: 'finish';
  language?: string;
}

export type TranscriptPart =
  | TranscriptModelPart
  | TranscriptPartialPart
  | TranscriptFinalPart
  | TranscriptUsagePart
  | TranscriptErrorPart
  | TranscriptFinishPart;

export type TranscriptPartType = TranscriptPart['type'];
