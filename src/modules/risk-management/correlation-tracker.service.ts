import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { PrismaService } from '../../common/prisma.service.js';
import {
  asClusterId,
  type ClusterId,
} from '../../common/types/branded.type.js';
import type { ClusterExposure } from '../../common/types/risk.type.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import { ClusterLimitApproachedEvent } from '../../common/events/risk.events.js';
import {
  sizesSchema,
  entryPricesSchema,
} from '../../common/schemas/prisma-json.schema.js';
import { parseJsonField } from '../../common/schemas/parse-json-field.js';

@Injectable()
export class CorrelationTrackerService {
  private readonly logger = new Logger(CorrelationTrackerService.name);
  private clusterExposures: ClusterExposure[] = [];
  private readonly bankrollUsd: Decimal;
  private readonly softLimitPct: Decimal;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {
    this.bankrollUsd = new Decimal(
      this.configService.get<string>('RISK_BANKROLL_USD', '10000'),
    );
    this.softLimitPct = new Decimal(
      this.configService.get<string>('RISK_CLUSTER_SOFT_LIMIT_PCT', '0.12'),
    );
  }

  /**
   * Recalculate cluster exposure for all clusters (or a specific one).
   * Queries all open positions joined to their ContractMatch → CorrelationCluster.
   */
  async recalculateClusterExposure(clusterId?: ClusterId): Promise<void> {
    const positions = await this.prisma.openPosition.findMany({
      where: {
        status: { in: ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'] },
        ...(clusterId ? { pair: { clusterId: clusterId as string } } : {}),
      },
      select: {
        positionId: true,
        sizes: true,
        entryPrices: true,
        pair: {
          select: {
            clusterId: true,
            cluster: { select: { id: true, name: true } },
          },
        },
      },
    });

    // Group by cluster
    const clusterMap = new Map<
      string,
      { clusterName: string; totalCapital: Decimal; pairCount: number }
    >();

    for (const pos of positions) {
      const cId = pos.pair.clusterId;
      if (!cId || !pos.pair.cluster) continue;

      try {
        const sizes = parseJsonField(sizesSchema, pos.sizes, {
          model: 'OpenPosition',
          field: 'sizes',
          recordId: pos.positionId,
        });
        const entryPrices = parseJsonField(entryPricesSchema, pos.entryPrices, {
          model: 'OpenPosition',
          field: 'entryPrices',
          recordId: pos.positionId,
        });

        // Capital deployed = sum of both legs: size * entryPrice per leg
        const polyCapital = new Decimal(sizes.polymarket).mul(
          new Decimal(entryPrices.polymarket),
        );
        const kalshiCapital = new Decimal(sizes.kalshi).mul(
          new Decimal(entryPrices.kalshi),
        );
        const positionCapital = polyCapital.plus(kalshiCapital);

        const existing = clusterMap.get(cId);
        if (existing) {
          existing.totalCapital = existing.totalCapital.plus(positionCapital);
          existing.pairCount += 1;
        } else {
          clusterMap.set(cId, {
            clusterName: pos.pair.cluster.name,
            totalCapital: positionCapital,
            pairCount: 1,
          });
        }
      } catch (error) {
        this.logger.warn({
          message: 'Skipping position with corrupted data in exposure calc',
          data: {
            positionId: pos.positionId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    // If recalculating a specific cluster, merge with existing data
    if (clusterId) {
      const updated = clusterMap.get(clusterId as string);
      this.clusterExposures = this.clusterExposures
        .filter((e) => e.clusterId !== clusterId)
        .concat(
          updated
            ? [
                {
                  clusterId,
                  clusterName: updated.clusterName,
                  exposureUsd: updated.totalCapital,
                  exposurePct: updated.totalCapital.div(this.bankrollUsd),
                  pairCount: updated.pairCount,
                },
              ]
            : [],
        );
    } else {
      // Full recalculation
      this.clusterExposures = Array.from(clusterMap.entries()).map(
        ([id, data]) => ({
          clusterId: asClusterId(id),
          clusterName: data.clusterName,
          exposureUsd: data.totalCapital,
          exposurePct: data.totalCapital.div(this.bankrollUsd),
          pairCount: data.pairCount,
        }),
      );
    }

    // Check soft limits
    for (const exposure of this.clusterExposures) {
      if (exposure.exposurePct.gte(this.softLimitPct)) {
        this.eventEmitter.emit(
          EVENT_NAMES.CLUSTER_LIMIT_APPROACHED,
          new ClusterLimitApproachedEvent(
            exposure.clusterName,
            exposure.clusterId,
            exposure.exposurePct.toNumber(),
            this.softLimitPct.toNumber(),
          ),
        );
      }
    }
  }

  getClusterExposures(): ClusterExposure[] {
    return [...this.clusterExposures];
  }

  getAggregateExposurePct(): Decimal {
    return this.clusterExposures.reduce(
      (sum, e) => sum.plus(e.exposurePct),
      new Decimal(0),
    );
  }

  // === Event listeners for recalculation triggers ===

  @OnEvent(EVENT_NAMES.BUDGET_COMMITTED)
  async onBudgetCommitted(): Promise<void> {
    await this.recalculateClusterExposure();
  }

  @OnEvent(EVENT_NAMES.EXIT_TRIGGERED)
  async onExitTriggered(): Promise<void> {
    await this.recalculateClusterExposure();
  }
}
