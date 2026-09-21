import { describe, it, expect } from '@jest/globals';

import { callStatusFor } from '../src/errors.js';

describe('callStatusFor', () => {
  it('keeps aborts and content filters apart from ordinary errors', () => {
    expect(callStatusFor('aborted')).toBe('aborted');
    expect(callStatusFor('content_filter')).toBe('filtered');
    expect(callStatusFor('rate_limit')).toBe('error');
    expect(callStatusFor('stream_interrupted')).toBe('error');
  });
});
