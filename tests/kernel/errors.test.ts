import { describe, expect, it } from 'vitest';
import { KernelError, classify } from '../../src/kernel/errors.js';

describe('classify', () => {
  it('reads the code of a KernelError', () => {
    expect(classify(new KernelError('rate_limit', 'slow down'))).toBe('rate_limit');
  });

  it('maps AbortSignal.timeout rejections to timeout', async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(classify(signal.reason)).toBe('timeout');
  });

  it('treats anything else as unknown', () => {
    expect(classify(new Error('boom'))).toBe('unknown');
    expect(classify('string')).toBe('unknown');
  });
});
