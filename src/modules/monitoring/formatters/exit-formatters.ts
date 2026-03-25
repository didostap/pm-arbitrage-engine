import { BaseEvent } from '../../../common/events/base.event.js';
import {
  escapeHtml,
  smartTruncate,
  formatCorrelationFooter,
  paperModeTag,
  SEVERITY_EMOJI,
} from './formatter-utils.js';

export function formatExitTriggered(event: {
  positionId: string;
  pairId: string;
  exitType: string;
  initialEdge: string;
  finalEdge: string;
  realizedPnl: string;
  kalshiCloseOrderId: string;
  polymarketCloseOrderId: string;
  timestamp: Date;
  correlationId?: string;
  isPaper?: boolean;
  mixedMode?: boolean;
}): string {
  const tag = paperModeTag(event.isPaper, event.mixedMode);
  const EXIT_LABELS: Record<string, string> = {
    take_profit: 'Take Profit',
    stop_loss: 'Stop Loss',
    time_based: 'Time-Based',
  };
  const exitLabel =
    EXIT_LABELS[event.exitType] ??
    event.exitType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const header = `${SEVERITY_EMOJI.info} <b>Exit Triggered: ${escapeHtml(exitLabel)}</b>${tag}`;
  const body = [
    `Position: <code>${escapeHtml(event.positionId)}</code>`,
    `Pair: <code>${escapeHtml(event.pairId)}</code>`,
    `Edge: <code>${escapeHtml(event.initialEdge)}</code> → <code>${escapeHtml(event.finalEdge)}</code>`,
    `Realized P&L: <code>${escapeHtml(event.realizedPnl)}</code>`,
    `Kalshi Close: <code>${escapeHtml(event.kalshiCloseOrderId)}</code>`,
    `Polymarket Close: <code>${escapeHtml(event.polymarketCloseOrderId)}</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}
