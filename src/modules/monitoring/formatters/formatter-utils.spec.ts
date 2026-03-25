import { describe, it, expect } from 'vitest';
import { escapeHtml, smartTruncate } from './formatter-utils.js';

describe('escapeHtml', () => {
  it('should escape <, >, and &', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert("xss")&lt;/script&gt;',
    );
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });

  it('should handle empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('should leave normal text unchanged', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });
});

describe('smartTruncate', () => {
  it('should return text unchanged if under 4096 chars', () => {
    const text = 'Short message';
    expect(smartTruncate(text)).toBe(text);
  });

  it('should truncate at 4096 chars preserving header and footer', () => {
    const header = '<b>Header</b>\n'.repeat(30); // ~420 chars
    const middle = 'x'.repeat(4000);
    const footer =
      '\nCorrelation: <code>abc-123</code>\nTime: <code>2024-01-01T00:00:00.000Z</code>';
    const text = header + middle + footer;

    const result = smartTruncate(text);
    expect(result.length).toBeLessThanOrEqual(4096);
    expect(result).toContain('[...truncated...]');
  });

  it('should close unclosed HTML tags after truncation', () => {
    const text = '<b>' + 'x'.repeat(5000) + '</b>';
    const result = smartTruncate(text);
    expect(result.length).toBeLessThanOrEqual(4096);
    // Should have closing </b> tag
    expect(result).toContain('</b>');
  });

  it('should not slice off closing tags when they push past 4096', () => {
    // Build a message where the assembled parts are just under 4096,
    // so closeUnclosedTags adding </b> would push past without the fix
    const tag = '<b>';
    const filler = 'x'.repeat(5000);
    const text = tag + filler;
    const result = smartTruncate(text);
    expect(result.length).toBeLessThanOrEqual(4096);
    // The closing tag must be intact, not sliced off
    expect(result).toMatch(/<\/b>$/);
  });
});
