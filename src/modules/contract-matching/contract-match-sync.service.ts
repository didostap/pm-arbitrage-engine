import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { ContractPairLoaderService } from './contract-pair-loader.service';

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
    const activePairs = this.pairLoader.getYamlPairs();

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
          existing.operatorApprovalTimestamp?.getTime() ===
            timestamp?.getTime() &&
          existing.polymarketClobTokenId === pair.polymarketClobTokenId &&
          existing.resolutionDate?.getTime() === pair.resolutionDate?.getTime()
        ) {
          pair.matchId = existing.matchId;
          unchanged++;
          continue;
        }

        const result = await this.prisma.contractMatch.upsert({
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
            polymarketClobTokenId: pair.polymarketClobTokenId,
            origin: 'MANUAL',
            ...(pair.resolutionDate !== undefined
              ? { resolutionDate: pair.resolutionDate }
              : {}),
          },
          create: {
            polymarketContractId: pair.polymarketContractId,
            polymarketClobTokenId: pair.polymarketClobTokenId,
            kalshiContractId: pair.kalshiContractId,
            polymarketDescription: description,
            kalshiDescription: description,
            operatorApproved: true,
            operatorApprovalTimestamp: timestamp,
            resolutionDate: pair.resolutionDate ?? null,
            origin: 'MANUAL',
          },
        });

        pair.matchId = result.matchId;

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

      await this.detectUntradablePairs();

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

  async detectUntradablePairs(): Promise<void> {
    const untradable = await this.prisma.contractMatch.findMany({
      where: {
        operatorApproved: true,
        polymarketClobTokenId: null,
      },
      select: {
        matchId: true,
        polymarketContractId: true,
        kalshiContractId: true,
      },
    });

    if (untradable.length > 0) {
      this.logger.warn({
        message:
          'Approved pairs missing polymarketClobTokenId — cannot trade until resolved',
        data: {
          count: untradable.length,
          pairs: untradable.map((p) => ({
            matchId: p.matchId,
            polymarketContractId: p.polymarketContractId,
            kalshiContractId: p.kalshiContractId,
          })),
        },
      });
    }
  }
}
