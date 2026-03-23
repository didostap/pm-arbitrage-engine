/**
 * Story 10-5.1 AC8 — Seed script for populating EngineConfig defaults.
 *
 * Reads env vars and upserts the EngineConfig singleton row,
 * setting only NULL columns (idempotent). Existing operator-set values
 * are never overwritten.
 *
 * Can be run standalone via `pnpm prisma:seed-config` or auto-called
 * during persistence module onModuleInit.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { CONFIG_DEFAULTS } from '../src/common/config/config-defaults.js';

/** Fields that use Prisma Decimal — values stay as strings for Prisma */
export const DECIMAL_FIELDS = new Set([
  'bankrollUsd',
  'detectionMinEdgeThreshold',
  'detectionGasEstimateUsd',
  'detectionPositionSizeUsd',
  'minAnnualizedReturn',
  'gasPolPriceFallbackUsd',
  'executionMinFillRatio',
  'riskMaxPositionPct',
  'riskDailyLossPct',
  'riskClusterHardLimitPct',
  'riskClusterSoftLimitPct',
  'riskAggregateClusterLimitPct',
  'discoveryPrefilterThreshold',
  'stressTestDefaultDailyVol',
]);

/** Fields that are Prisma Boolean — env strings must be converted */
export const BOOLEAN_FIELDS = new Set([
  'csvEnabled',
  'discoveryEnabled',
  'discoveryRunOnStartup',
  'resolutionPollerEnabled',
  'calibrationEnabled',
  'autoUnwindEnabled',
  'adaptiveSequencingEnabled',
]);

/** Fields that are Prisma Float — parse as float */
export const FLOAT_FIELDS = new Set([
  'autoUnwindMaxLossPct',
  'exitEdgeEvapMultiplier',
  'exitTimeDecaySteepness',
  'exitTimeDecayTrigger',
  'exitDepthSlippageTolerance',
  'exitProfitCaptureRatio',
]);

/**
 * Convert a raw env var string to the correct DB type for a given field.
 */
function convertEnvValue(
  field: string,
  rawValue: string,
): string | number | boolean {
  if (BOOLEAN_FIELDS.has(field)) {
    return rawValue === 'true';
  }
  if (DECIMAL_FIELDS.has(field)) {
    // Decimal fields stay as strings — Prisma handles the conversion
    return rawValue;
  }
  if (FLOAT_FIELDS.has(field)) {
    return parseFloat(rawValue);
  }
  // Integer or string — try parsing as integer
  const asInt = parseInt(rawValue, 10);
  if (!isNaN(asInt) && String(asInt) === rawValue) {
    return asInt;
  }
  // String field (cron expressions, model names, providers, modes)
  return rawValue;
}

/**
 * Build seed payloads from CONFIG_DEFAULTS and env vars.
 * Returns { update, create } where update only contains NULL fields
 * and create contains all defaults for a fresh install.
 */
export function buildSeedPayloads(
  existing: Record<string, unknown> | null,
  envValues: Record<string, string>,
  log?: (msg: string) => void,
): {
  update: Prisma.EngineConfigUncheckedUpdateInput;
  create: Prisma.EngineConfigUncheckedCreateInput;
} {
  const info = log ?? (() => {});
  const updatePayload: Prisma.EngineConfigUncheckedUpdateInput = {};
  const createPayload: Prisma.EngineConfigUncheckedCreateInput = {
    bankrollUsd:
      envValues['RISK_BANKROLL_USD'] ??
      String(CONFIG_DEFAULTS.bankrollUsd.defaultValue),
  };

  for (const [field, entry] of Object.entries(CONFIG_DEFAULTS)) {
    const rawValue = envValues[entry.envKey];
    if (rawValue === undefined) continue;

    const converted = convertEnvValue(field, rawValue);
    // Use Prisma's field key type for indexing
    const key = field as keyof Prisma.EngineConfigUncheckedCreateInput;
    (createPayload[key] as string | number | boolean) = converted;

    // Only seed if existing row has NULL for this field
    if (existing) {
      const currentValue = existing[field];
      if (currentValue === null || currentValue === undefined) {
        const updateKey =
          field as keyof Prisma.EngineConfigUncheckedUpdateInput;
        (updatePayload[updateKey] as string | number | boolean) = converted;
        info(`seeded: ${field} = ${String(converted)}`);
      } else {
        info(`skipped: ${field} (already set)`);
      }
    }
  }

  // paperBankrollUsd is never seeded (AC8)
  delete (createPayload as Record<string, unknown>)['paperBankrollUsd'];
  delete (updatePayload as Record<string, unknown>)['paperBankrollUsd'];

  return { update: updatePayload, create: createPayload };
}

/**
 * Seed the EngineConfig table with defaults from env vars.
 * Only sets columns that are currently NULL (idempotent).
 * paperBankrollUsd is never seeded.
 *
 * Accepts PrismaClient or any object with the same engineConfig delegate shape
 * (e.g. PrismaService, which extends PrismaClient).
 */
export async function seedConfig(
  prisma: Pick<PrismaClient, 'engineConfig'>,
  envValues: Record<string, string>,
): Promise<void> {
  const existing = await prisma.engineConfig.findUnique({
    where: { singletonKey: 'default' },
  });

  const existingRecord = existing as Record<string, unknown> | null;
  const { update, create } = buildSeedPayloads(
    existingRecord,
    envValues,
    console.log,
  );

  // Skip upsert entirely when existing row has all columns populated (P8)
  if (existing && Object.keys(update).length === 0) {
    return;
  }

  await prisma.engineConfig.upsert({
    where: { singletonKey: 'default' },
    update,
    create,
  });
}

/**
 * Standalone entry point for `pnpm prisma:seed-config`.
 * Creates a PrismaClient, reads env vars, seeds, and disconnects.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const envValues: Record<string, string> = {};
    for (const [, entry] of Object.entries(CONFIG_DEFAULTS)) {
      const value = process.env[entry.envKey];
      if (value !== undefined) {
        envValues[entry.envKey] = value;
      }
    }
    await seedConfig(prisma, envValues);
    console.log('EngineConfig seed completed');
  } finally {
    await prisma.$disconnect();
  }
}

// Run main() when executed directly (not imported)
// Uses require.main check (CJS-compatible) instead of import.meta.url (ESM-only)
const isDirectRun = require.main === module;
if (isDirectRun) {
  main().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
