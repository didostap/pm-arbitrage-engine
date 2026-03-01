import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { ContractPairLoaderService } from './contract-pair-loader.service';
import { ContractPairConfig } from './types/index.js';

@Injectable()
export class ContractMatchSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContractMatchSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pairLoader: ContractPairLoaderService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.syncPairsToDatabase();
  }

  async syncPairsToDatabase(): Promise<void> {
    const activePairs = this.pairLoader.getActivePairs();

    if (activePairs.length === 0) {
      this.logger.warn('No active pairs loaded — skipping database sync');
      return;
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;

    try {
      for (const pair of activePairs) {
        const timestamp = pair.operatorVerificationTimestamp ?? null;
        const description = pair.eventDescription;

        const existing = await this.prisma.contractMatch.findUnique({
          where: {
            polymarketContractId_kalshiContractId: {
              polymarketContractId: pair.polymarketContractId,
              kalshiContractId: pair.kalshiContractId,
            },
          },
        });

        if (
          existing &&
          existing.operatorApproved === true &&
          existing.polymarketDescription === description &&
          existing.kalshiDescription === description &&
          existing.operatorApprovalTimestamp?.getTime() === timestamp?.getTime()
        ) {
          unchanged++;
          continue;
        }

        await this.prisma.contractMatch.upsert({
          where: {
            polymarketContractId_kalshiContractId: {
              polymarketContractId: pair.polymarketContractId,
              kalshiContractId: pair.kalshiContractId,
            },
          },
          update: {
            operatorApproved: true,
            operatorApprovalTimestamp: timestamp,
            polymarketDescription: description,
            kalshiDescription: description,
          },
          create: {
            polymarketContractId: pair.polymarketContractId,
            kalshiContractId: pair.kalshiContractId,
            polymarketDescription: description,
            kalshiDescription: description,
            operatorApproved: true,
            operatorApprovalTimestamp: timestamp,
          },
        });

        if (existing) {
          updated++;
        } else {
          inserted++;
          this.logger.log({
            message: 'New contract pair added',
            data: {
              polymarketContractId: pair.polymarketContractId,
              kalshiContractId: pair.kalshiContractId,
              operatorVerificationTimestamp:
                pair.operatorVerificationTimestamp?.toISOString() ?? null,
            },
          });
        }
      }

      await this.detectInactivePairs(activePairs);

      this.logger.log({
        message: 'Contract matches seeded to database',
        data: { inserted, updated, unchanged },
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to sync contract matches to database',
        data: { error: (error as Error).message },
      });
    }
  }

  async detectInactivePairs(activePairs: ContractPairConfig[]): Promise<void> {
    const activePolyIds = new Set(
      activePairs.map((p) => p.polymarketContractId),
    );
    const activeKalshiIds = new Set(activePairs.map((p) => p.kalshiContractId));

    const allDbPairs = await this.prisma.contractMatch.findMany({
      where: { operatorApproved: true },
      select: {
        polymarketContractId: true,
        kalshiContractId: true,
      },
    });

    const inactivePairs = allDbPairs.filter(
      (dbPair) =>
        !activePolyIds.has(dbPair.polymarketContractId) ||
        !activeKalshiIds.has(dbPair.kalshiContractId),
    );

    if (inactivePairs.length > 0) {
      this.logger.warn({
        message:
          'Database contains approved pairs not in current config — may need manual review',
        data: {
          count: inactivePairs.length,
          pairs: inactivePairs.map((p) => ({
            polymarketContractId: p.polymarketContractId,
            kalshiContractId: p.kalshiContractId,
          })),
        },
      });
    }
  }
}
