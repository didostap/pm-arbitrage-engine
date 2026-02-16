import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { ContractPairLoaderService } from './contract-pair-loader.service';

@Injectable()
export class ContractMatchSyncService implements OnModuleInit {
  private readonly logger = new Logger(ContractMatchSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pairLoader: ContractPairLoaderService,
  ) {}

  async onModuleInit(): Promise<void> {
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

  private async detectInactivePairs(
    activePairs: ReturnType<ContractPairLoaderService['getActivePairs']>,
  ): Promise<void> {
    const dbPairs = await this.prisma.contractMatch.findMany({
      select: { polymarketContractId: true, kalshiContractId: true },
    });

    const configPairKeys = new Set(
      activePairs.map((p) => `${p.polymarketContractId}:${p.kalshiContractId}`),
    );

    const inactivePairs = dbPairs.filter(
      (db) =>
        !configPairKeys.has(
          `${db.polymarketContractId}:${db.kalshiContractId}`,
        ),
    );

    if (inactivePairs.length > 0) {
      this.logger.log({
        message: 'Inactive contract matches detected',
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
