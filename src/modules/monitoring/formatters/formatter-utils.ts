import { BaseEvent } from '../../../common/events/base.event.js';
import type { AlertSeverity } from '../event-severity.js';

export const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  critical: '\u{1F534}',
  warning: '\u{1F7E1}',
  info: '\u{1F7E2}',
};

export const MAX_MESSAGE_LENGTH = 4096;
export const HEADER_RESERVE = 500;
export const FOOTER_RESERVE = 200;
const TAG_CLOSE_RESERVE = 50;

/**
 * Escape HTML special characters in dynamic values.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Smart truncation preserving header and footer.
 * Ensures no unclosed HTML tags.
 */
export function smartTruncate(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;

  const header = text.slice(0, HEADER_RESERVE);
  const footer = text.slice(-FOOTER_RESERVE);
  const truncationMarker = '\n[...truncated...]\n';

  const available = MAX_MESSAGE_LENGTH - truncationMarker.length;
  const headerPart = header.slice(
    0,
    Math.min(header.length, available - FOOTER_RESERVE),
  );
  const footerPart = footer.slice(
    Math.max(0, footer.length - (available - headerPart.length)),
  );

  let result = headerPart + truncationMarker + footerPart;

  // Slice before closing tags to reserve space for closing tags
  result = result.slice(0, MAX_MESSAGE_LENGTH - TAG_CLOSE_RESERVE);
  result = closeUnclosedTags(result);

  return result.slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * Naive tag closer: finds opened tags without matching close tags and appends closers.
 */
export function closeUnclosedTags(html: string): string {
  const openTagRegex = /<(b|i|code|pre|u|s|a)\b[^>]*>/gi;
  const closeTagRegex = /<\/(b|i|code|pre|u|s|a)>/gi;

  const openTags: string[] = [];
  let match: RegExpExecArray | null;

  match = openTagRegex.exec(html);
  while (match) {
    openTags.push(match[1]!.toLowerCase());
    match = openTagRegex.exec(html);
  }

  match = closeTagRegex.exec(html);
  while (match) {
    const tag = match[1]!.toLowerCase();
    const idx = openTags.lastIndexOf(tag);
    if (idx !== -1) {
      openTags.splice(idx, 1);
    }
    match = closeTagRegex.exec(html);
  }

  // Append close tags in reverse order
  let result = html;
  for (let i = openTags.length - 1; i >= 0; i--) {
    result += `</${openTags[i]}>`;
  }

  return result;
}

export function formatTimestamp(date: Date): string {
  return date.toISOString();
}

export function formatCorrelationFooter(event: BaseEvent): string {
  const parts: string[] = [];
  if (event.correlationId) {
    parts.push(
      `\nCorrelation: <code>${escapeHtml(event.correlationId)}</code>`,
    );
  }
  parts.push(`\nTime: <code>${formatTimestamp(event.timestamp)}</code>`);
  return parts.join('');
}

export function paperModeTag(isPaper?: boolean, mixedMode?: boolean): string {
  const tags: string[] = [];
  if (isPaper) tags.push('[PAPER]');
  if (mixedMode) tags.push('[MIXED]');
  return tags.length > 0 ? ' ' + tags.join(' ') : '';
}
