import { z } from 'zod';

// OpenPosition.entryPrices — { kalshi: string; polymarket: string }
export const entryPricesSchema = z.object({
  kalshi: z.string(),
  polymarket: z.string(),
});

// OpenPosition.sizes — { kalshi: string; polymarket: string }
export const sizesSchema = z.object({
  kalshi: z.string(),
  polymarket: z.string(),
});

// CalibrationRun.tiers — three calibration bands
const calibrationBandSchema = z.object({
  range: z.string(),
  matchCount: z.number(),
  divergedCount: z.number(),
  divergenceRate: z.number(),
});
export const calibrationTiersSchema = z.object({
  autoApprove: calibrationBandSchema,
  pendingReview: calibrationBandSchema,
  autoReject: calibrationBandSchema,
});

// CalibrationRun.boundaryAnalysis — BoundaryAnalysisEntry[]
export const boundaryAnalysisSchema = z.array(
  z.object({
    threshold: z.number(),
    matchesAbove: z.number(),
    divergedAbove: z.number(),
    divergenceRateAbove: z.number(),
    recommendation: z.string().nullable(),
  }),
);

// CalibrationRun.recommendations — string[]
export const recommendationsSchema = z.array(z.string());

// RiskState.haltReason — serialized Set<HaltReason> as string array
// Values must match HALT_REASONS in risk-manager.service.ts
export const KNOWN_HALT_REASONS = [
  'daily_loss_limit',
  'reconciliation_discrepancy',
] as const;
export const haltReasonSchema = z.array(z.enum(KNOWN_HALT_REASONS));

// OpenPosition.reconciliationContext — flexible JSON
export const reconciliationContextSchema = z.record(z.unknown()).nullable();

// OrderBookSnapshot.bids/asks — PriceLevel[]
// Values are already-normalized decimals stored as JSON snapshots.
// Financial calculations convert to Decimal before arithmetic.
export const orderBookLevelsSchema = z.array(
  z.object({
    price: z.number(),
    quantity: z.number(),
  }),
);

// AuditLog.details — flexible JSON object
export const auditLogDetailsSchema = z.record(z.unknown());
