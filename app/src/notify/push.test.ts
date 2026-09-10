import { RESEND_LIMIT_HOURS, PREVIEW_CHARS, previewBody, backoffMs } from './push';

describe('resend limit', () => {
  it('caps automatic resend at 24 hours', () => {
    expect(RESEND_LIMIT_HOURS).toBe(24);
  });
});

describe('previewBody', () => {
  it('truncates bodies longer than 100 chars', () => {
    expect(PREVIEW_CHARS).toBe(100);
    const body = 'a'.repeat(150);
    const preview = previewBody(body);
    expect(preview).toHaveLength(100);
    expect(preview).toBe(body.slice(0, 100));
  });

  it('leaves short bodies unchanged', () => {
    expect(previewBody('hello')).toBe('hello');
    expect(previewBody('')).toBe('');
  });
});

describe('backoffMs', () => {
  it('grows exponentially from a 60s base', () => {
    expect(backoffMs(0)).toBe(60000);
    expect(backoffMs(1)).toBe(120000);
    expect(backoffMs(2)).toBe(240000);
    expect(backoffMs(3)).toBe(480000);
  });

  it('caps at one hour', () => {
    expect(backoffMs(6)).toBe(3600000);
    expect(backoffMs(10)).toBe(3600000);
    expect(backoffMs(100)).toBe(3600000);
  });
});
