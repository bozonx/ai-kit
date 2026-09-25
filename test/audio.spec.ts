import { describe, it, expect } from '@jest/globals';

import {
  estimateAudioSeconds,
  pcm16Rms,
  pcm16ToWav,
  SilenceDetector,
  wavAudioSeconds,
} from '../src/stt/audio.js';

function pcm(seconds: number, amplitude: number): Uint8Array {
  const bytes = new Uint8Array(seconds * 32_000);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < bytes.byteLength / 2; index += 1) {
    view.setInt16(index * 2, index % 2 === 0 ? amplitude : -amplitude, true);
  }
  return bytes;
}

const speech = (seconds: number) => pcm(seconds, 8_000);
const quiet = (seconds: number) => pcm(seconds, 0);

describe('estimateAudioSeconds', () => {
  it('reads the container off the mime type', () => {
    expect(estimateAudioSeconds(5 * 32_000, 'audio/wav')).toBe(5);
    expect(estimateAudioSeconds(5 * 4_000, 'audio/ogg; codecs=opus')).toBe(5);
  });

  it('never says less than a second', () => {
    expect(estimateAudioSeconds(1, 'audio/unknown')).toBe(1);
  });
});

describe('wavAudioSeconds', () => {
  it('measures the encoded sample rate and refuses an inconsistent byte rate', () => {
    const wav = pcm16ToWav(new Uint8Array(96_000), 48_000);
    expect(wavAudioSeconds(wav)).toBe(1);
    new DataView(wav.buffer).setUint32(28, 32_000, true);
    expect(wavAudioSeconds(wav)).toBeUndefined();
  });
});

describe('pcm16Rms', () => {
  it('measures a square wave at its amplitude', () => {
    expect(pcm16Rms(pcm(1, 1_000))).toBe(1_000);
  });

  it('reads a view into a larger buffer at its own offset', () => {
    const backing = new Uint8Array(8);
    new DataView(backing.buffer).setInt16(4, 500, true);
    new DataView(backing.buffer).setInt16(6, -500, true);
    expect(pcm16Rms(backing.subarray(4))).toBe(500);
  });
});

describe('SilenceDetector', () => {
  it('does not call a pause while somebody is talking', () => {
    const detector = new SilenceDetector();
    expect(detector.push(speech(1))).toBe(false);
    expect(detector.push(speech(1))).toBe(false);
  });

  it('calls a pause after enough continuous silence', () => {
    const detector = new SilenceDetector();
    detector.push(speech(1));
    expect(detector.push(quiet(2))).toBe(true);
  });

  it('needs the silence to be continuous', () => {
    const detector = new SilenceDetector();
    expect(detector.push(quiet(1))).toBe(false);
    expect(detector.push(speech(1))).toBe(false);
    expect(detector.push(quiet(1))).toBe(false);
  });

  it('learns a noisy room without muting speech over it', () => {
    const detector = new SilenceDetector();
    for (let second = 0; second < 30; second += 1) detector.push(pcm(1, 200));
    detector.reset();
    expect(detector.push(speech(1))).toBe(false);
  });

  it('takes its thresholds from options', () => {
    const detector = new SilenceDetector({ silenceMs: 500 });
    expect(detector.push(quiet(1))).toBe(true);
  });
});

describe('pcm16ToWav', () => {
  it('prepends a 44-byte header describing mono PCM16', () => {
    const wav = pcm16ToWav(new Uint8Array([1, 2, 3, 4]), 16_000);
    const view = new DataView(wav.buffer);

    expect(wav.byteLength).toBe(48);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
  });

  it('rejects invalid sample rates and incomplete samples', () => {
    expect(() => pcm16ToWav(new Uint8Array(2), 0)).toThrow(RangeError);
    expect(() => pcm16ToWav(new Uint8Array(2), 16_000.5)).toThrow(RangeError);
    expect(() => pcm16ToWav(new Uint8Array(1), 16_000)).toThrow('complete 2-byte samples');
  });
});
