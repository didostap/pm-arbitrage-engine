import { BaseEvent } from '../../../common/events/base.event.js';
import {
  escapeHtml,
  smartTruncate,
  formatCorrelationFooter,
  SEVERITY_EMOJI,
} from './formatter-utils.js';

export function formatOpportunityIdentified(event: {
  opportunity: Record<string, unknown>;
  timestamp: Date;
  correlationId?: string;
}): string {
  const opp = event.opportunity;
  const str = (v: unknown): string =>
    typeof v === 'string' || typeof v === 'number' ? String(v) : 'N/A';
  const header = `${SEVERITY_EMOJI.info} <b>Opportunity Identified</b>`;
  const body = [
    `Edge: <code>${escapeHtml(str(opp['netEdge'] ?? opp['edge']))}</code>`,
    `Pair: <code>${escapeHtml(str(opp['pairId']))}</code>`,
    `Size: <code>${escapeHtml(str(opp['positionSizeUsd']))}</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}
