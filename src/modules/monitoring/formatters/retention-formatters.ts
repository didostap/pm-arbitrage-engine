import type { BaseEvent } from '../../../common/events/base.event.js';
import {
  smartTruncate,
  formatCorrelationFooter,
  SEVERITY_EMOJI,
} from './formatter-utils.js';

export function formatTimescaleRetentionCompleted(event: {
  droppedChunks: Record<string, number>;
  durationMs: number;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.info} <b>TimescaleDB Retention Completed</b>`;
  const entries = Object.entries(event.droppedChunks);
  const lines =
    entries.length > 0
      ? entries
          .map(([table, count]) => `${table}: ${count} chunks dropped`)
          .join('\n')
      : 'No tables processed';
  const body = `${lines}\nDuration: ${(event.durationMs / 1000).toFixed(1)}s`;
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}
