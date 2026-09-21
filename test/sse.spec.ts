import { describe, it, expect } from '@jest/globals';

import { encodeSse, SseDecoder } from '../src/stream/sse.js';

describe('the SSE codec', () => {
  it('round-trips parts and named events', () => {
    const wire = encodeSse({ type: 'text-delta', text: 'a\nb' }) + encodeSse({ id: 'm1' }, 'saved');
    const decoder = new SseDecoder();

    expect(decoder.push(wire)).toEqual([
      { event: 'message', data: { type: 'text-delta', text: 'a\nb' } },
      { event: 'saved', data: { id: 'm1' } },
    ]);
  });

  it('holds an event split across chunks until it is complete', () => {
    const wire = encodeSse({ n: 1 });
    const decoder = new SseDecoder();

    expect(decoder.push(wire.slice(0, 7))).toEqual([]);
    expect(decoder.push(wire.slice(7))).toEqual([{ event: 'message', data: { n: 1 } }]);
  });

  it('accepts CRLF, including a CRLF split between chunks', () => {
    const decoder = new SseDecoder();

    expect(decoder.push('data: {"n":1}\r\n\r')).toEqual([]);
    expect(decoder.push('\ndata: {"n":2}\r\n\r\n')).toEqual([
      { event: 'message', data: { n: 1 } },
      { event: 'message', data: { n: 2 } },
    ]);
  });

  it('skips comments and data that is not JSON', () => {
    const decoder = new SseDecoder();

    expect(decoder.push(': keep-alive\n\ndata: not json\n\ndata: 3\n\n')).toEqual([
      { event: 'message', data: 3 },
    ]);
  });

  it('flushes an event the stream ended without terminating', () => {
    const decoder = new SseDecoder();
    decoder.push('data: {"last":true}');

    expect(decoder.flush()).toEqual([{ event: 'message', data: { last: true } }]);
  });
});
