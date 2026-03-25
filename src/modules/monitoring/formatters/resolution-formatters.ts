import { BaseEvent } from '../../../common/events/base.event.js';
import {
  escapeHtml,
  smartTruncate,
  formatCorrelationFooter,
  SEVERITY_EMOJI,
} from './formatter-utils.js';

export function formatResolutionDivergence(event: {
  matchId: string;
  polymarketResolution: string;
  kalshiResolution: string;
  divergenceNotes: string | null;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.critical} <b>🚨 RESOLUTION DIVERGED</b>`;
  const body = [
    `Match: <code>${escapeHtml(event.matchId)}</code>`,
    `Polymarket: <code>${escapeHtml(event.polymarketResolution)}</code>`,
    `Kalshi: <code>${escapeHtml(event.kalshiResolution)}</code>`,
    '',
    '<b>Action Required:</b> Add root cause analysis in divergenceNotes',
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatResolutionPollCompleted(event: {
  stats: {
    totalChecked: number;
    newlyResolved: number;
    diverged: number;
    skippedInvalid: number;
    pendingOnePlatform: number;
    errors: number;
  };
  timestamp: Date;
  correlationId?: string;
}): string {
  const s = event.stats;
  const severity = s.diverged > 0 ? 'warning' : 'info';
  const emoji = SEVERITY_EMOJI[severity];
  const header = `${emoji} <b>Resolution Poll ${s.diverged > 0 ? '⚠️' : '✓'}</b>`;
  const body = [
    `Checked: <code>${s.totalChecked}</code>`,
    `Resolved: <code>${s.newlyResolved}</code>`,
    s.diverged > 0
      ? `<b>Diverged: ${s.diverged}</b>`
      : `Diverged: <code>0</code>`,
    `Pending: <code>${s.pendingOnePlatform}</code>`,
    `Invalid: <code>${s.skippedInvalid}</code>`,
    `Errors: <code>${s.errors}</code>`,
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatCalibrationCompleted(event: {
  calibrationResult: {
    totalResolvedMatches: number;
    minimumDataMet: boolean;
    tiers: {
      autoApprove: { matchCount: number; divergenceRate: number };
      pendingReview: { matchCount: number; divergenceRate: number };
      autoReject: { matchCount: number; divergenceRate: number };
    };
    recommendations: string[];
  };
  timestamp: Date;
  correlationId?: string;
}): string {
  const r = event.calibrationResult;
  const hasRecs = r.recommendations.length > 0;
  const severity = hasRecs ? 'warning' : 'info';
  const emoji = SEVERITY_EMOJI[severity];
  const header = `${emoji} <b>Calibration Analysis</b>`;
  const lines = [
    `Total resolved: <code>${r.totalResolvedMatches}</code>`,
    `Data sufficient: <code>${r.minimumDataMet ? 'yes' : 'no'}</code>`,
  ];

  if (r.minimumDataMet) {
    lines.push(
      '',
      `Auto-approve: <code>${r.tiers.autoApprove.matchCount}</code> (${r.tiers.autoApprove.divergenceRate}% div.)`,
      `Pending review: <code>${r.tiers.pendingReview.matchCount}</code> (${r.tiers.pendingReview.divergenceRate}% div.)`,
      `Auto-reject: <code>${r.tiers.autoReject.matchCount}</code> (${r.tiers.autoReject.divergenceRate}% div.)`,
    );
  }

  if (hasRecs) {
    lines.push('', '<b>Recommendations:</b>');
    for (const rec of r.recommendations) {
      lines.push(`• ${escapeHtml(rec)}`);
    }
  }

  const body = lines.join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}

export function formatShadowDailySummary(event: {
  date: string;
  totalComparisons: number;
  fixedTriggerCount: number;
  modelTriggerCount: number;
  criterionTriggerCounts: Record<string, number>;
  cumulativePnlDelta: string;
  agreeCount: number;
  disagreeCount: number;
  timestamp: Date;
  correlationId?: string;
}): string {
  const header = `${SEVERITY_EMOJI.info} <b>Shadow Mode Daily Summary</b>`;
  const agreeRate =
    event.totalComparisons > 0
      ? ((event.agreeCount / event.totalComparisons) * 100).toFixed(1)
      : '0.0';
  const body = [
    `Date: <code>${escapeHtml(event.date)}</code>`,
    `Total Comparisons: <code>${event.totalComparisons}</code>`,
    `Fixed Triggers: <code>${event.fixedTriggerCount}</code>`,
    `Model Triggers: <code>${event.modelTriggerCount}</code>`,
    `Agreement: <code>${event.agreeCount}/${event.totalComparisons}</code> (${agreeRate}%)`,
    `Cumulative P&amp;L Delta: <code>${escapeHtml(event.cumulativePnlDelta)}</code>`,
    '',
    '<b>Criterion Triggers:</b>',
    ...Object.entries(event.criterionTriggerCounts).map(
      ([criterion, count]) =>
        `  ${escapeHtml(criterion)}: <code>${count}</code>`,
    ),
  ].join('\n');
  const footer = formatCorrelationFooter(event as BaseEvent);
  return smartTruncate(`${header}\n\n${body}${footer}`);
}
