import { SilenceDetector, type SilenceDetectorOptions } from './audio.js';

/**
 * Live capture cut into phrases for a batch model.
 *
 * Dictation without a realtime provider is a sequence of short batch calls:
 * collect the microphone's PCM, send it when the speaker pauses, send it anyway
 * when nobody pauses for too long. Cutting on a pause rather than on the clock
 * is what keeps a word from being split between two calls, and the ceiling is
 * what keeps a speaker who never stops from producing one enormous call at the
 * end. Each phrase knows where it starts in the session, so its segments can be
 * placed on one timeline.
 */

export interface PhraseChunkerOptions extends SilenceDetectorOptions {
  /** A phrase is cut at this length whether or not anybody paused. Default 30. */
  maxSeconds?: number;
  /**
   * Speech needed before a pause may cut a phrase. Default 1. Below it a pause
   * is most likely the gap before somebody starts, and a call for half a
   * second of breath costs the same minimum as a sentence at most providers.
   */
  minSeconds?: number;
}

/** One stretch of speech, cut and ready to send. */
export interface Phrase {
  /** Raw PCM16 mono, in capture order. Wrap with `pcm16ToWav` for a file endpoint. */
  pcm: Uint8Array;
  /** Where it starts in the session, for shifting its segments. */
  offsetMs: number;
  seconds: number;
}

export class PhraseChunker {
  private readonly bytesPerSecond: number;
  private readonly maxSeconds: number;
  private readonly minSeconds: number;
  private readonly silence: SilenceDetector;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private cutBytes = 0;

  constructor(options: PhraseChunkerOptions = {}) {
    this.bytesPerSecond = (options.sampleRate ?? 16_000) * 2;
    this.maxSeconds = options.maxSeconds ?? 30;
    this.minSeconds = options.minSeconds ?? 1;
    this.silence = new SilenceDetector(options);
  }

  /**
   * Feed one captured chunk. It is copied, so a capture that reuses its buffer
   * cannot rewrite a phrase still being collected.
   *
   * @returns The phrase this chunk completed, or null while it is still going.
   */
  public push(chunk: Uint8Array): Phrase | null {
    this.pending.push(chunk.slice());
    this.pendingBytes += chunk.byteLength;
    const quiet = this.silence.push(chunk);

    const seconds = this.pendingSeconds;
    if (seconds >= this.maxSeconds || (quiet && seconds >= this.minSeconds)) return this.cut();
    return null;
  }

  /** Whatever is left when the capture ends, however short. Null when nothing is. */
  public flush(): Phrase | null {
    return this.pendingBytes === 0 ? null : this.cut();
  }

  /** Audio held for the phrase in progress. */
  public get pendingSeconds(): number {
    return this.pendingBytes / this.bytesPerSecond;
  }

  /** Everything captured so far, cut or not: the session's length. */
  public get totalSeconds(): number {
    return (this.cutBytes + this.pendingBytes) / this.bytesPerSecond;
  }

  private cut(): Phrase {
    const pcm = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const chunk of this.pending) {
      pcm.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const phrase: Phrase = {
      pcm,
      offsetMs: Math.round((this.cutBytes / this.bytesPerSecond) * 1000),
      seconds: this.pendingBytes / this.bytesPerSecond,
    };
    this.cutBytes += this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    this.silence.reset();
    return phrase;
  }
}
