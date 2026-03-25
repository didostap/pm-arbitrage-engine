import Decimal from 'decimal.js';
import { BaseEvent } from '../../../common/events/base.event.js';
import {
  escapeHtml,
  smartTruncate,
  formatCorrelationFooter,
  paperModeTag,
  SEVERITY_EMOJI,
} from './formatter-utils.js';

export function formatOrderFilled(event: {
  orderId: string;
  platform: string;
  side: string;
  price: number;
  size: number;
  fillPrice: number;
  fillSize: number;
  positionId: string;
  timestamp: Date;
  correlationId?: string;
  isPaper?: boolean;
  mixedMode?: boolean;
}): string {
  const tag = paperModeTag(event.isPaper, event.mixedMode);
  const header = `${SEVERITY_EMOJI.info} <b>Order Filled</b>${tag}`;
  const slippage = new Decimal(event.fillPrice).minus(event.price).abs();
  const body = [
    `Order: <code>${escapeHtml(event.orderId)}</code>`,
    `Platform: <code>${escapeHtml(String(event.platform))}</code>`,
    `Side: <code>${escapeHtml(event.side)}</code>`,
    `Price: <code>${event.price.toFixed(4)}</code> → Fill: <code>${event.fillPrice.toFixed(4)}</code>`,
    `Size: <code>${event.size}</code> → Fill: <code>${event.fillSize}</code>`,
    `Slippage: <code>${slippage.toFixed(4).toString()}</code>`,
    `Position: <code>${escapeHtml(event.positionId)}</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatExecutionFailed(event: {
  reasonCode: number;
  reason: string;
  opportunityId: string;
  context: Record<string, unknown>;
  timestamp: Date;
  correlationId?: string;
  isPaper?: boolean;
  mixedMode?: boolean;
}): string {
  const tag = paperModeTag(event.isPaper, event.mixedMode);
  const header = `${SEVERITY_EMOJI.warning} <b>Execution Failed</b>${tag}`;
  const lines = [
    `Error Code: <code>${event.reasonCode}</code>`,
    `Reason: ${escapeHtml(event.reason)}`,
    `Opportunity: <code>${escapeHtml(event.opportunityId)}</code>`,
  ];
  const contextEntries = Object.entries(event.context).slice(0, 5);
  if (contextEntries.length > 0) {
    lines.push('', '<b>Context:</b>');
    for (const [key, value] of contextEntries) {
      lines.push(
        `  ${escapeHtml(key)}: <code>${escapeHtml(value != null ? `${value as string | number | boolean}` : 'N/A')}</code>`,
      );
    }
  }
  const body = lines.join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatSingleLegExposure(event: {
  positionId: string;
  pairId: string;
  expectedEdge: number;
  filledLeg: {
    platform: string;
    orderId: string;
    side: string;
    price: number;
    size: number;
    fillPrice: number;
    fillSize: number;
  };
  failedLeg: {
    platform: string;
    reason: string;
    reasonCode: number;
    attemptedPrice: number;
    attemptedSize: number;
  };
  pnlScenarios: {
    closeNowEstimate: string;
    retryAtCurrentPrice: string;
    holdRiskAssessment: string;
  };
  recommendedActions: string[];
  timestamp: Date;
  correlationId?: string;
  isPaper?: boolean;
  mixedMode?: boolean;
}): string {
  const tag = paperModeTag(event.isPaper, event.mixedMode);
  const header = `${SEVERITY_EMOJI.critical} <b>🚨 SINGLE LEG EXPOSURE</b>${tag}`;
  const body = [
    `Position: <code>${escapeHtml(event.positionId)}</code>`,
    `Pair: <code>${escapeHtml(event.pairId)}</code>`,
    `Expected Edge: <code>${event.expectedEdge.toFixed(4)}</code>`,
    '',
    '<b>Filled Leg:</b>',
    `  Platform: <code>${escapeHtml(String(event.filledLeg.platform))}</code>`,
    `  Order: <code>${escapeHtml(event.filledLeg.orderId)}</code>`,
    `  Fill: <code>${event.filledLeg.fillPrice.toFixed(4)}</code> × <code>${event.filledLeg.fillSize}</code>`,
    '',
    '<b>Failed Leg:</b>',
    `  Platform: <code>${escapeHtml(String(event.failedLeg.platform))}</code>`,
    `  Reason: ${escapeHtml(event.failedLeg.reason)} (<code>${event.failedLeg.reasonCode}</code>)`,
    `  Attempted: <code>${event.failedLeg.attemptedPrice.toFixed(4)}</code> × <code>${event.failedLeg.attemptedSize}</code>`,
    '',
    '<b>P&amp;L Scenarios:</b>',
    `  Close now: <code>${escapeHtml(event.pnlScenarios.closeNowEstimate)}</code>`,
    `  Retry: <code>${escapeHtml(event.pnlScenarios.retryAtCurrentPrice)}</code>`,
    `  Hold risk: <code>${escapeHtml(event.pnlScenarios.holdRiskAssessment)}</code>`,
    '',
    '<b>Recommended:</b>',
    ...event.recommendedActions.map((a) => `• ${escapeHtml(a)}`),
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatSingleLegResolved(event: {
  positionId: string;
  pairId: string;
  resolutionType: string;
  resolvedOrder: {
    orderId: string;
    platform: string;
    status: string;
    filledPrice: number;
    filledQuantity: number;
  };
  originalEdge: number;
  newEdge: number | null;
  realizedPnl: string | null;
  timestamp: Date;
  correlationId?: string;
  isPaper?: boolean;
  mixedMode?: boolean;
}): string {
  const tag = paperModeTag(event.isPaper, event.mixedMode);
  const header = `${SEVERITY_EMOJI.info} <b>Single Leg Resolved</b>${tag}`;
  const body = [
    `Position: <code>${escapeHtml(event.positionId)}</code>`,
    `Pair: <code>${escapeHtml(event.pairId)}</code>`,
    `Resolution: <code>${escapeHtml(event.resolutionType)}</code>`,
    `Order: <code>${escapeHtml(event.resolvedOrder.orderId)}</code> on <code>${escapeHtml(String(event.resolvedOrder.platform))}</code>`,
    `Fill: <code>${event.resolvedOrder.filledPrice.toFixed(4)}</code> × <code>${event.resolvedOrder.filledQuantity}</code>`,
    `Original Edge: <code>${event.originalEdge.toFixed(4)}</code>`,
    event.newEdge !== null
      ? `New Edge: <code>${event.newEdge.toFixed(4)}</code>`
      : '',
    event.realizedPnl !== null
      ? `Realized P&L: <code>${escapeHtml(event.realizedPnl)}</code>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}
