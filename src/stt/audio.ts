/**
 * Small facts about audio that every speech feature needs before a provider
 * has said anything: how long a file probably is, whether somebody has stopped
 * talking, and how to hand raw microphone samples to an endpoint that wants a
 * file.
 *
 * PCM here always means 16-bit signed little-endian mono, which is what every
 * live transcription provider takes and what a browser worklet produces.
 */

/**
 * Bytes per second of audio, by container, for sizing a hold.
 *
 * Only ever good enough to reserve, never to charge: the charge comes from the
 * length the provider measured. A guess that is wrong by a factor of two costs
 * a slightly wrong reservation for the length of one call, which is the right
 * price for not running a probe binary over every file first.
 */
const BYTES_PER_SECOND_BY_TYPE: readonly { match: RegExp; bytesPerSecond: number }[] = [
  { match: /wav|pcm|x-wav/iu, bytesPerSecond: 32_000 },
  { match: /flac|aiff/iu, bytesPerSecond: 20_000 },
  { match: /ogg|opus|webm/iu, bytesPerSecond: 4_000 },
  { match: /mp3|mpeg|m4a|mp4|aac/iu, bytesPerSecond: 16_000 },
];

const DEFAULT_BYTES_PER_SECOND = 16_000;

/** A rough duration from size and container, never less than one second. */
export function estimateAudioSeconds(byteLength: number, mimeType: string): number {
  const rate =
    BYTES_PER_SECOND_BY_TYPE.find(entry => entry.match.test(mimeType))?.bytesPerSecond ??
    DEFAULT_BYTES_PER_SECOND;
  return Math.max(1, Math.ceil(byteLength / rate));
}

/** Root mean square of a PCM16 buffer, in PCM16 units. */
export function pcm16Rms(chunk: Uint8Array): number {
  const samples = Math.floor(chunk.byteLength / 2);
  if (samples === 0) return 0;
  const view = new DataView(chunk.buffer, chunk.byteOffset, samples * 2);
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const sample = view.getInt16(index * 2, true);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

export interface SilenceDetectorOptions {
  /** Sample rate of the PCM being fed in, in hertz. Default 16 kHz. */
  sampleRate?: number;
  /** Continuous silence that counts as the speaker having stopped. Default 1200 ms. */
  silenceMs?: number;
  /**
   * Amplitude under which a chunk is silence, in PCM16 units. Default 300: a
   * quiet room on a laptop microphone sits around 50–300 RMS, ordinary speech
   * an order of magnitude above.
   */
  floorRms?: number;
  /** How far above the learned noise floor speech has to be. Default 2.5. */
  noiseMultiplier?: number;
}

/**
 * Whether the speaker has paused, measured on the samples.
 *
 * Not on the clock: a capture worklet posts frames at a steady rate for as long
 * as the microphone is open, whether anybody is speaking or not, so a gap
 * between chunks never appears. Reading the audio is the only way to know.
 *
 * The threshold follows the room upwards — a fan never goes near any fixed
 * number — but never below the floor, so a quiet speaker cannot be silenced
 * by their own quietness. Only quiet frames move it, and slowly, so a long
 * sentence cannot drag the threshold up to its own level and mute itself.
 */
export class SilenceDetector {
  private readonly bytesPerSecond: number;
  private readonly silenceMs: number;
  private readonly floorRms: number;
  private readonly noiseMultiplier: number;
  private noiseFloor: number;
  private silentMs = 0;

  constructor(options: SilenceDetectorOptions = {}) {
    this.bytesPerSecond = (options.sampleRate ?? 16_000) * 2;
    this.silenceMs = options.silenceMs ?? 1_200;
    this.floorRms = options.floorRms ?? 300;
    this.noiseMultiplier = options.noiseMultiplier ?? 2.5;
    this.noiseFloor = this.floorRms;
  }

  /** Feed one PCM16 chunk. Returns true once the speaker has clearly stopped. */
  public push(chunk: Uint8Array): boolean {
    const durationMs = (chunk.byteLength / this.bytesPerSecond) * 1000;
    const rms = pcm16Rms(chunk);
    const threshold = Math.max(this.floorRms, this.noiseFloor * this.noiseMultiplier);

    if (rms < threshold) {
      this.silentMs += durationMs;
      this.noiseFloor = this.noiseFloor * 0.9 + rms * 0.1;
    } else {
      this.silentMs = 0;
    }
    return this.silentMs >= this.silenceMs;
  }

  /** Forget the current pause, keeping what was learned about the room. */
  public reset(): void {
    this.silentMs = 0;
  }
}

/**
 * Raw PCM16 mono wrapped in a WAV header.
 *
 * What a batch endpoint needs when the audio came from a live capture: every
 * provider accepts WAV, and none of them accepts headerless samples as a file.
 */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}
