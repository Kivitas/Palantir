import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../src/utils/html';

describe('escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
  });

  it('neutralises a script injection in element content', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });

  it('keeps quoted attributes closed', () => {
    const out = escapeHtml(`" onmouseover="alert(1)`);
    expect(out).not.toContain('"');
    expect(out).toBe('&quot; onmouseover=&quot;alert(1)');
  });

  it('escapes ampersands once, so already-escaped text is double-escaped', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves plain text and unicode untouched', () => {
    expect(escapeHtml('Plain text, café, 世界 🚀')).toBe('Plain text, café, 世界 🚀');
  });

  it('coerces non-string values and maps null/undefined to empty', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(false)).toBe('false');
    expect(escapeHtml({ toString: () => '<b>' })).toBe('&lt;b&gt;');
  });
});
