import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma.service';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../common/errors/system-health-error';
import { EVENT_NAMES } from '../common/events';
import { MatchApprovedEvent } from '../common/events/match-approved.event';
import { MatchRejectedEvent } from '../common/events/match-rejected.event';
import type {
  ClusterSummaryDto,
  MatchSummaryDto,
  MatchSortField,
} from './dto/match-approval.dto';
import type { SortOrder } from './dto/common-query.dto';
import type {
  ContractMatch,
  CorrelationCluster,
  PositionStatus,
} from '@prisma/client';
import { asMatchId, asContractId } from '../common/types/branded.type';

type ContractMatchWithCluster = ContractMatch & {
  cluster: CorrelationCluster | null;
};

/** Statuses considered "active" for position count display (excludes CLOSED and RECONCILIATION_REQUIRED). */
const ACTIVE_POSITION_STATUSES: PositionStatus[] = [
  'OPEN',
  'SINGLE_LEG_EXPOSED',
  'EXIT_PARTIAL',
];

@Injectable()
export class MatchApprovalService {
  private readonly logger = new Logger(MatchApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async listMatches(
    status: 'pending' | 'approved' | 'rejected' | 'all',
    page: number,
    limit: number,
    resolution?: 'resolved' | 'unresolved' | 'diverged',
    clusterId?: string,
    sortBy?: MatchSortField,
    order?: SortOrder,
  ): Promise<{
    data: MatchSummaryDto[];
    count: number;
    page: number;
    limit: number;
  }> {
    const where = {
      ...this.buildWhereFilter(status),
      ...this.buildResolutionFilter(resolution),
      ...(clusterId ? { clusterId } : {}),
    };
    const skip = (page - 1) * limit;

    const orderBy = sortBy
      ? [{ [sortBy]: { sort: order ?? 'desc', nulls: 'last' } }]
      : [{ operatorApproved: 'asc' as const }, { createdAt: 'desc' as const }];

    const [matches, count] = await Promise.all([
      this.prisma.contractMatch.findMany({
        where,
        include: { cluster: true },
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.contractMatch.count({ where }),
    ]);

    // Batch position count queries to avoid N+1
    const matchIds = matches.map((m) => m.matchId);

    const [totalCounts, activeCounts] =
      matchIds.length > 0
        ? await Promise.all([
            this.prisma.openPosition.groupBy({
              by: ['pairId'],
              where: { pairId: { in: matchIds } },
              _count: true,
            }),
            this.prisma.openPosition.groupBy({
              by: ['pairId'],
              where: {
                pairId: { in: matchIds },
                status: { in: ACTIVE_POSITION_STATUSES },
              },
              _count: true,
            }),
          ])
        : [[], []];

    const totalCountMap = new Map(totalCounts.map((r) => [r.pairId, r._count]));
    const activeCountMap = new Map(
      activeCounts.map((r) => [r.pairId, r._count]),
    );

    return {
      data: matches.map((m) =>
        this.toSummaryDto(
          m,
          totalCountMap.get(m.matchId) ?? 0,
          activeCountMap.get(m.matchId) ?? 0,
        ),
      ),
      count,
      page,
      limit,
    };
  }

  async getMatchById(matchId: string): Promise<MatchSummaryDto> {
    const match = await this.prisma.contractMatch.findUnique({
      where: { matchId },
      include: { cluster: true },
    });

    if (!match) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
        `Contract match '${matchId}' not found`,
        'warning',
        'MatchApprovalService',
      );
    }

    const [positionCount, activePositionCount] = await Promise.all([
      this.prisma.openPosition.count({ where: { pairId: matchId } }),
      this.prisma.openPosition.count({
        where: { pairId: matchId, status: { in: ACTIVE_POSITION_STATUSES } },
      }),
    ]);

    return this.toSummaryDto(match, positionCount, activePositionCount);
  }

  async approveMatch(
    matchId: string,
    rationale: string,
  ): Promise<MatchSummaryDto> {
    const result = await this.prisma.contractMatch.updateMany({
      where: { matchId, operatorApproved: false },
      data: {
        operatorApproved: true,
        operatorRationale: rationale,
        operatorApprovalTimestamp: new Date(),
      },
    });

    if (result.count === 0) {
      const existing = await this.prisma.contractMatch.findUnique({
        where: { matchId },
      });

      if (!existing) {
        throw new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
          `Contract match '${matchId}' not found`,
          'warning',
          'MatchApprovalService',
        );
      }

      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.MATCH_ALREADY_APPROVED,
        `Contract match '${matchId}' is already approved`,
        'warning',
        'MatchApprovalService',
      );
    }

    const updated = await this.prisma.contractMatch.findUnique({
      where: { matchId },
      include: { cluster: true },
    });

    if (!updated) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
        `Contract match '${matchId}' disappeared after approval — possible concurrent deletion`,
        'warning',
        'MatchApprovalService',
      );
    }

    this.eventEmitter.emit(
      EVENT_NAMES.MATCH_APPROVED,
      new MatchApprovedEvent(
        asMatchId(matchId),
        asContractId(updated.polymarketContractId),
        asContractId(updated.kalshiContractId),
        rationale,
      ),
    );

    this.logger.log({
      message: 'Contract match approved',
      data: { matchId, rationale },
    });

    // Position counts omitted (defaults to 0) — mutation responses are not used
    // for count display; the UI invalidates and refetches match data after mutations.
    return this.toSummaryDto(updated);
  }

  async rejectMatch(
    matchId: string,
    rationale: string,
  ): Promise<MatchSummaryDto> {
    const existing = await this.prisma.contractMatch.findUnique({
      where: { matchId },
    });

    if (!existing) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
        `Contract match '${matchId}' not found`,
        'warning',
        'MatchApprovalService',
      );
    }

    if (existing.operatorApproved) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.MATCH_ALREADY_APPROVED,
        `Contract match '${matchId}' is approved — reject not allowed without re-approval workflow`,
        'warning',
        'MatchApprovalService',
      );
    }

    const updated = await this.prisma.contractMatch.update({
      where: { matchId },
      include: { cluster: true },
      data: {
        operatorApproved: false,
        operatorRationale: rationale,
        operatorApprovalTimestamp: new Date(),
      },
    });

    this.eventEmitter.emit(
      EVENT_NAMES.MATCH_REJECTED,
      new MatchRejectedEvent(
        asMatchId(matchId),
        asContractId(updated.polymarketContractId),
        asContractId(updated.kalshiContractId),
        rationale,
      ),
    );

    this.logger.log({
      message: 'Contract match rejected',
      data: { matchId, rationale },
    });

    // Position counts omitted (defaults to 0) — see approveMatch comment.
    return this.toSummaryDto(updated);
  }

  async listClusters(): Promise<ClusterSummaryDto[]> {
    const clusters = await this.prisma.correlationCluster.findMany({
      orderBy: { name: 'asc' },
    });
    return clusters.map((c) => ({ id: c.id, name: c.name, slug: c.slug }));
  }

  private buildWhereFilter(status: string): Record<string, unknown> {
    switch (status) {
      case 'pending':
        return { operatorApproved: false, operatorRationale: null };
      case 'approved':
        return { operatorApproved: true };
      case 'rejected':
        return { operatorApproved: false, operatorRationale: { not: null } };
      default:
        return {};
    }
  }

  private buildResolutionFilter(resolution?: string): Record<string, unknown> {
    switch (resolution) {
      case 'resolved':
        return { resolutionTimestamp: { not: null } };
      case 'unresolved':
        return { resolutionTimestamp: null };
      case 'diverged':
        return { resolutionDiverged: true };
      default:
        return {};
    }
  }

  private toSummaryDto(
    match: ContractMatchWithCluster,
    positionCount: number = 0,
    activePositionCount: number = 0,
  ): MatchSummaryDto {
    return {
      matchId: match.matchId,
      polymarketContractId: match.polymarketContractId,
      polymarketClobTokenId: match.polymarketClobTokenId ?? null,
      kalshiContractId: match.kalshiContractId,
      polymarketDescription: match.polymarketDescription ?? '',
      kalshiDescription: match.kalshiDescription ?? '',
      operatorApproved: match.operatorApproved,
      operatorApprovalTimestamp:
        match.operatorApprovalTimestamp?.toISOString() ?? null,
      operatorRationale: match.operatorRationale,
      confidenceScore: match.confidenceScore ?? null,
      polymarketResolution: match.polymarketResolution ?? null,
      kalshiResolution: match.kalshiResolution ?? null,
      resolutionTimestamp: match.resolutionTimestamp?.toISOString() ?? null,
      resolutionDiverged: match.resolutionDiverged ?? null,
      divergenceNotes: match.divergenceNotes ?? null,
      polymarketRawCategory: match.polymarketRawCategory ?? null,
      kalshiRawCategory: match.kalshiRawCategory ?? null,
      firstTradedTimestamp: match.firstTradedTimestamp?.toISOString() ?? null,
      totalCyclesTraded: match.totalCyclesTraded,
      primaryLeg: match.primaryLeg ?? null,
      resolutionDate: match.resolutionDate?.toISOString() ?? null,
      resolutionCriteriaHash: match.resolutionCriteriaHash ?? null,
      lastAnnualizedReturn: match.lastAnnualizedReturn?.toNumber() ?? null,
      lastNetEdge: match.lastNetEdge?.toNumber() ?? null,
      lastComputedAt: match.lastComputedAt?.toISOString() ?? null,
      cluster: match.cluster
        ? {
            id: match.cluster.id,
            name: match.cluster.name,
            slug: match.cluster.slug,
          }
        : null,
      positionCount,
      activePositionCount,
      createdAt: match.createdAt.toISOString(),
      updatedAt: match.updatedAt.toISOString(),
    };
  }
}
