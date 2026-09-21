import { describe, it, expect } from '@jest/globals';

import { PhraseChunker } from '../src/stt/phrases.js';

/** PCM16 at 16 kHz: `ms` of either a loud square wave or silence. */
function pcm(ms: number, loud: boolean): Uint8Array {
  const samples = (16_000 * ms) / 1000;
  const view = new DataView(new ArrayBuffer(samples * 2));
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, loud ? (index % 2 === 0 ? 8_000 : -8_000) : 0, true);
  }
  return new Uint8Array(view.buffer);
}

describe('cutting live capture into phrases', () => {
  it('cuts on a pause once enough speech has been heard', () => {
    const chunker = new PhraseChunker({ silenceMs: 300, minSeconds: 1 });

    for (let index = 0; index < 12; index += 1) expect(chunker.push(pcm(100, true))).toBeNull();
    expect(chunker.push(pcm(100, false))).toBeNull();
    expect(chunker.push(pcm(100, false))).toBeNull();
    const phrase = chunker.push(pcm(100, false));

    expect(phrase?.offsetMs).toBe(0);
    expect(phrase?.seconds).toBeCloseTo(1.5);
    expect(chunker.pendingSeconds).toBe(0);
  });

  it('does not cut on the pause before anybody has spoken', () => {
    const chunker = new PhraseChunker({ silenceMs: 300, minSeconds: 1 });

    for (let index = 0; index < 5; index += 1) expect(chunker.push(pcm(100, false))).toBeNull();
  });

  it('cuts at the ceiling when nobody pauses, and places the next phrase after it', () => {
    const chunker = new PhraseChunker({ maxSeconds: 1 });

    let first = null;
    for (let index = 0; index < 10 && !first; index += 1) first = chunker.push(pcm(100, true));
    chunker.push(pcm(200, true));
    const rest = chunker.flush();

    expect(first?.seconds).toBeCloseTo(1);
    expect(rest?.offsetMs).toBe(1000);
    expect(rest?.pcm.byteLength).toBe(pcm(200, true).byteLength);
    expect(chunker.totalSeconds).toBeCloseTo(1.2);
    expect(chunker.flush()).toBeNull();
  });
});
