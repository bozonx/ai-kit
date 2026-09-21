import { describe, expect, it } from '@jest/globals';

import { renderSubtitles } from '../src/stt/subtitles.js';
import { segmentWords } from '../src/stt/segment-words.js';

describe('renderSubtitles', () => {
  it('renders SRT cues with normalized timestamps and sequential indexes', () => {
    expect(
      renderSubtitles(
        [
          { startMs: 61_234, endMs: 63_456, text: '  First   cue  ' },
          { startMs: 3_661_000, endMs: 3_663_000, text: 'Second cue' },
        ],
        { format: 'srt' },
      ),
    ).toBe(
      '1\n00:01:01,234 --> 00:01:03,456\nFirst cue\n\n' +
        '2\n01:01:01,000 --> 01:01:03,000\nSecond cue\n',
    );
  });

  it('renders WebVTT with its header and timestamp separator', () => {
    expect(renderSubtitles([{ startMs: 0, endMs: 2_000, text: 'Hello' }], { format: 'vtt' })).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello\n',
    );
  });

  it('wraps text without exceeding the requested line length', () => {
    const output = renderSubtitles(
      [{ startMs: 0, endMs: 3_000, text: 'One two three four five six' }],
      { format: 'srt', maxCharsPerLine: 10 },
    );

    expect(output).toContain('One two');
    expect(output).toContain('three');
    expect(output).toContain('four five');
    expect(output).toContain('six');
    for (const line of output.split('\n').filter(line => /^[A-Za-z]/u.test(line))) {
      expect(Array.from(line).length).toBeLessThanOrEqual(10);
    }
  });

  it('merges short adjacent segments from the same speaker', () => {
    const output = renderSubtitles(
      [
        { startMs: 0, endMs: 400, text: 'Too short', speaker: 'A' },
        { startMs: 500, endMs: 1_500, text: 'continued', speaker: 'A' },
      ],
      { format: 'srt' },
    );

    expect(output).toContain('00:00:00,000 --> 00:00:01,500\nToo short continued');
    expect(output.match(/ --> /gu)).toHaveLength(1);
  });

  it('does not merge different speakers or segments separated by a long gap', () => {
    const output = renderSubtitles(
      [
        { startMs: 0, endMs: 400, text: 'Speaker A', speaker: 'A' },
        { startMs: 500, endMs: 1_000, text: 'Speaker B', speaker: 'B' },
        { startMs: 2_000, endMs: 2_400, text: 'Later', speaker: 'B' },
      ],
      { format: 'srt' },
    );

    expect(output.match(/ --> /gu)).toHaveLength(3);
  });

  it('extends a short cue to the minimum duration without overlapping the next cue', () => {
    const output = renderSubtitles(
      [
        { startMs: 0, endMs: 200, text: 'First', speaker: 'A' },
        { startMs: 700, endMs: 1_200, text: 'Second', speaker: 'B' },
      ],
      { format: 'srt', minCueDurationMs: 1_000 },
    );

    expect(output).toContain('00:00:00,000 --> 00:00:00,700');
    expect(output).toContain('00:00:00,700 --> 00:00:01,700');
  });

  it('splits cues that exceed the maximum duration', () => {
    const output = renderSubtitles([{ startMs: 0, endMs: 15_000, text: 'A long statement' }], {
      format: 'vtt',
      maxCueDurationMs: 7_000,
    });

    expect(output).toContain('00:00:00.000 --> 00:00:05.000');
    expect(output).toContain('00:00:10.000 --> 00:00:15.000');
    expect(output.match(/ --> /gu)).toHaveLength(3);
  });

  it('ignores empty and invalid segments and does not mutate its input', () => {
    const segments = [
      { startMs: 2_000, endMs: 3_000, text: 'Later' },
      { startMs: 0, endMs: 1_000, text: 'Earlier' },
      { startMs: 4_000, endMs: 4_000, text: 'Invalid' },
      { startMs: 5_000, endMs: 6_000, text: '   ' },
    ];
    const snapshot = structuredClone(segments);

    const output = renderSubtitles(segments, { format: 'srt' });

    expect(output.indexOf('Earlier')).toBeLessThan(output.indexOf('Later'));
    expect(output).not.toContain('Invalid');
    expect(segments).toEqual(snapshot);
  });
  it('cuts a long cue on the silence between words when word timings are known', () => {
    const output = renderSubtitles(
      [
        {
          startMs: 0,
          endMs: 12_000,
          text: 'one two three four',
          words: [
            { startMs: 0, endMs: 500, text: 'one' },
            { startMs: 600, endMs: 1_000, text: 'two' },
            { startMs: 9_000, endMs: 9_400, text: 'three' },
            { startMs: 9_500, endMs: 12_000, text: 'four' },
          ],
        },
      ],
      { format: 'srt', maxCueDurationMs: 7_000 },
    );

    // Proportional splitting would cut at 6s, in the middle of the pause but
    // with the words on the wrong sides of it.
    expect(output).toContain('00:00:00,000 --> 00:00:01,000\none two');
    expect(output).toContain('00:00:09,000 --> 00:00:12,000\nthree four');
  });

  it('falls back to proportional cuts when the word list does not match the text', () => {
    const output = renderSubtitles(
      [
        {
          startMs: 0,
          endMs: 12_000,
          text: 'one two three four',
          words: [{ startMs: 0, endMs: 500, text: 'one' }],
        },
      ],
      { format: 'srt', maxCueDurationMs: 7_000 },
    );

    expect(output).toContain('00:00:00,000 --> 00:00:06,000');
    expect(output).toContain('00:00:06,000 --> 00:00:12,000');
  });

  it('never emits overlapping or empty cues from overlapping speakers', () => {
    const output = renderSubtitles(
      [
        { startMs: 0, endMs: 4_000, text: 'Talking over', speaker: 'A' },
        { startMs: 1_000, endMs: 5_000, text: 'each other', speaker: 'B' },
        { startMs: 1_000, endMs: 1_010, text: 'Squeezed out', speaker: 'C' },
      ],
      { format: 'srt' },
    );

    const times = [
      ...output.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/gu),
    ].map(match => ({
      start: Number(match[3]) * 1_000 + Number(match[4]),
      end: Number(match[7]) * 1_000 + Number(match[8]),
    }));

    expect(times.length).toBeGreaterThan(0);
    for (const [index, cue] of times.entries()) {
      expect(cue.end).toBeGreaterThan(cue.start);
      const previous = times[index - 1];
      if (previous) expect(cue.start).toBeGreaterThanOrEqual(previous.end);
    }
    expect(output).not.toContain('Squeezed out');
  });
});

describe('segmentWords', () => {
  const segments = [
    { startMs: 0, endMs: 1_000 },
    { startMs: 1_000, endMs: 2_000 },
  ];

  it('puts a word straddling a boundary in exactly one segment', () => {
    const buckets = segmentWords(segments, [
      { startMs: 900, endMs: 1_100, text: 'edge' },
      { startMs: 1_100, endMs: 1_500, text: 'after' },
    ]);

    // Its midpoint is exactly the boundary, so it belongs to the segment that
    // ends there — in one of them, never in both and never in neither.
    expect(buckets[0]?.map(word => word.text)).toEqual(['edge']);
    expect(buckets[1]?.map(word => word.text)).toEqual(['after']);
  });

  it('assigns every word by its midpoint, in order', () => {
    const buckets = segmentWords(segments, [
      { startMs: 1_200, endMs: 1_400, text: 'second' },
      { startMs: 100, endMs: 300, text: 'first' },
    ]);

    expect(buckets[0]?.map(word => word.text)).toEqual(['first']);
    expect(buckets[1]?.map(word => word.text)).toEqual(['second']);
  });

  it('gives every segment nothing at all when the provider returned no words', () => {
    expect(segmentWords(segments, undefined)).toEqual([undefined, undefined]);
  });

  it('drops a word that falls outside every segment rather than forcing it in', () => {
    expect(segmentWords(segments, [{ startMs: 9_000, endMs: 9_200, text: 'late' }])).toEqual([
      undefined,
      undefined,
    ]);
  });
});
