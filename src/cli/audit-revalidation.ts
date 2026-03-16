/**
 * CLI: Revalidate existing contract matches for outcome direction correctness.
 *
 * Fetches live catalog data from both platforms, runs direction validation
 * on each approved match, swaps incorrect clobTokenIds, flags mismatches,
 * and backfills outcome labels.
 *
 * Usage:
 *   pnpm audit:revalidate
 *   NODE_ENV=production pnpm audit:revalidate
 *
 * Environment variables:
 *   AUDIT_LLM_BATCH_SIZE   — matches per batch (default 10)
 *   AUDIT_LLM_DELAY_MS     — delay between batches in ms (default 1000)
 */
import { NestFactory } from '@nestjs/core';
import { Module, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PersistenceModule } from '../common/persistence.module.js';
import { SCORING_STRATEGY_TOKEN } from '../common/interfaces/scoring-strategy.interface.js';
import {
  KALSHI_CATALOG_TOKEN,
  POLYMARKET_CATALOG_TOKEN,
} from '../common/interfaces/contract-catalog-provider.interface.js';
import { LlmScoringStrategy } from '../modules/contract-matching/llm-scoring.strategy.js';
import { CatalogSyncService } from '../modules/contract-matching/catalog-sync.service.js';
import { OutcomeDirectionValidator } from '../modules/contract-matching/outcome-direction-validator.js';
import { AuditRevalidationService } from '../modules/contract-matching/audit-revalidation.command.js';
import { ClusterClassifierService } from '../modules/contract-matching/cluster-classifier.service.js';
import { KalshiCatalogProvider } from '../connectors/kalshi/kalshi-catalog-provider.js';
import { PolymarketCatalogProvider } from '../connectors/polymarket/polymarket-catalog-provider.js';
import { AuditLogService } from '../modules/monitoring/audit-log.service.js';
import { AuditLogRepository } from '../persistence/repositories/audit-log.repository.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `.env.${process.env.NODE_ENV || 'development'}`,
    }),
    EventEmitterModule.forRoot(),
    PersistenceModule,
  ],
  providers: [
    KalshiCatalogProvider,
    PolymarketCatalogProvider,
    { provide: KALSHI_CATALOG_TOKEN, useExisting: KalshiCatalogProvider },
    {
      provide: POLYMARKET_CATALOG_TOKEN,
      useExisting: PolymarketCatalogProvider,
    },
    LlmScoringStrategy,
    { provide: SCORING_STRATEGY_TOKEN, useExisting: LlmScoringStrategy },
    CatalogSyncService,
    OutcomeDirectionValidator,
    AuditLogRepository,
    AuditLogService,
    ClusterClassifierService,
    AuditRevalidationService,
  ],
})
class AuditModule {}

async function main(): Promise<void> {
  const logger = new Logger('AuditCLI');

  logger.log('Bootstrapping audit context...');
  const app = await NestFactory.createApplicationContext(AuditModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const audit = app.get(AuditRevalidationService);

    logger.log('Starting audit revalidation...');
    const report = await audit.runAudit();

    console.log('\n========== AUDIT REPORT ==========');
    console.log(`Total matches audited:    ${report.total}`);
    console.log(`UFC mis-matches rejected: ${report.ufcRejected}`);
    console.log(`Tokens corrected:         ${report.tokensCorrected}`);
    console.log(`Flagged (misaligned):     ${report.flagged}`);
    console.log(`Labels backfilled:        ${report.backfilled}`);
    console.log(`Skipped (no data/LLM):    ${report.skipped}`);
    console.log(`Clusters reclassified:    ${report.clustersReclassified}`);
    console.log('==================================\n');

    if (report.flagged > 0) {
      logger.warn(
        `${report.flagged} matches flagged — review in dashboard under Rejected tab`,
      );
    }
    if (report.tokensCorrected > 0) {
      logger.log(
        `${report.tokensCorrected} tokens corrected — verify in match detail pages`,
      );
    }
  } catch (error) {
    logger.error(
      `Audit failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
