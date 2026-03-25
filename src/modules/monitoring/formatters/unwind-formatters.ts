import { BaseEvent } from '../../../common/events/base.event.js';
import {
  escapeHtml,
  smartTruncate,
  formatCorrelationFooter,
  paperModeTag,
  SEVERITY_EMOJI,
} from './formatter-utils.js';

export function formatAutoUnwind(event: {
  positionId: string;
  pairId: string;
  action: string;
  result: string;
  estimatedLossPct: number | null;
  realizedPnl: string | null;
  timeElapsedMs: number;
  simulated: boolean;
  timestamp: Date;
  correlationId?: string;
  isPaper?: boolean;
  mixedMode?: boolean;
}): string {
  const tag = paperModeTag(event.isPaper, event.mixedMode);
  const simTag = event.simulated ? ' [SIMULATED]' : '';
  const resultEmoji =
    event.result === 'success'
      ? '\u{2705}'
      : event.result === 'failed'
        ? '\u{274C}'
        : '\u{26A0}\u{FE0F}';
  const header = `${SEVERITY_EMOJI.warning} <b>AUTO-UNWIND ${escapeHtml(event.result.toUpperCase())}</b>${tag}${simTag}`;
  const lossDisplay =
    event.realizedPnl !== null
      ? event.realizedPnl
      : event.estimatedLossPct !== null
        ? `~${event.estimatedLossPct.toFixed(2)}%`
        : 'N/A';
  const body = [
    `${resultEmoji} Action: <code>${escapeHtml(event.action)}</code>`,
    `Position: <code>${escapeHtml(event.positionId)}</code>`,
    `Pair: <code>${escapeHtml(event.pairId)}</code>`,
    `Loss: <code>${escapeHtml(lossDisplay)}</code>`,
    `Elapsed: <code>${event.timeElapsedMs}ms</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}
