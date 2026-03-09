import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma.service';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../common/errors/system-health-error';
import { EVENT_NAMES } from '../../common/events';
import { ResolutionDivergedEvent } from '../../common/events/resolution-diverged.event';

@Injectable()
export class KnowledgeBaseService {
  private readonly logger = new Logger(KnowledgeBaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async updateConfidenceScore(
    matchId: string,
    score: number,
    criteriaHash?: string,
  ): Promise<void> {
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.INVALID_CONFIGURATION,
        `Confidence score must be between 0 and 100, got ${score}`,
        'warning',
        'KnowledgeBaseService',
      );
    }

    const match = await this.prisma.contractMatch.findUnique({
      where: { matchId },
    });

    if (!match) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
        `Contract match '${matchId}' not found`,
        'warning',
        'KnowledgeBaseService',
      );
    }

    await this.prisma.contractMatch.update({
      where: { matchId },
      data: {
        confidenceScore: score,
        ...(criteriaHash !== undefined && {
          resolutionCriteriaHash: criteriaHash,
        }),
      },
    });

    this.logger.log({
      message: 'Confidence score updated',
      data: { matchId, score, criteriaHash: criteriaHash ?? null },
    });
  }

  async recordResolution(
    matchId: string,
    polyResolution: string,
    kalshiResolution: string,
    notes?: string,
  ): Promise<void> {
    if (!polyResolution.trim() || !kalshiResolution.trim()) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.INVALID_CONFIGURATION,
        'Resolution strings must not be empty or whitespace-only',
        'warning',
        'KnowledgeBaseService',
      );
    }

    const match = await this.prisma.contractMatch.findUnique({
      where: { matchId },
    });

    if (!match) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
        `Contract match '${matchId}' not found`,
        'warning',
        'KnowledgeBaseService',
      );
    }

    const polyNorm = polyResolution.toLowerCase().trim();
    const kalshiNorm = kalshiResolution.toLowerCase().trim();
    const diverged = polyNorm !== kalshiNorm;

    await this.prisma.contractMatch.update({
      where: { matchId },
      data: {
        polymarketResolution: polyNorm,
        kalshiResolution: kalshiNorm,
        resolutionTimestamp: new Date(),
        resolutionDiverged: diverged,
        divergenceNotes: notes ?? null,
      },
    });

    this.logger.log({
      message: 'Resolution recorded',
      data: {
        matchId,
        polyResolution: polyNorm,
        kalshiResolution: kalshiNorm,
        diverged,
      },
    });

    if (diverged) {
      try {
        this.eventEmitter.emit(
          EVENT_NAMES.RESOLUTION_DIVERGED,
          new ResolutionDivergedEvent(
            matchId,
            polyNorm,
            kalshiNorm,
            notes ?? null,
          ),
        );
      } catch (error) {
        this.logger.error({
          message:
            'Failed to emit ResolutionDivergedEvent — divergence recorded but notification lost',
          data: { matchId, error: (error as Error).message },
        });
      }

      this.logger.warn({
        message: 'Resolution divergence detected',
        data: {
          matchId,
          polyResolution: polyNorm,
          kalshiResolution: kalshiNorm,
          notes: notes ?? null,
        },
      });
    }
  }

  async findByResolutionStatus(
    status: 'resolved' | 'unresolved' | 'diverged',
  ): Promise<
    Array<{
      matchId: string;
      polymarketContractId: string;
      kalshiContractId: string;
      polymarketResolution: string | null;
      kalshiResolution: string | null;
      resolutionDiverged: boolean | null;
      resolutionTimestamp: Date | null;
      confidenceScore: number | null;
    }>
  > {
    const where = this.buildResolutionFilter(status);

    const matches = await this.prisma.contractMatch.findMany({
      where,
      select: {
        matchId: true,
        polymarketContractId: true,
        kalshiContractId: true,
        polymarketResolution: true,
        kalshiResolution: true,
        resolutionDiverged: true,
        resolutionTimestamp: true,
        confidenceScore: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    return matches;
  }

  async getResolutionStats(): Promise<{
    totalResolved: number;
    divergedCount: number;
    divergenceRate: number;
  }> {
    const [totalResolved, divergedCount] = await Promise.all([
      this.prisma.contractMatch.count({
        where: { resolutionTimestamp: { not: null } },
      }),
      this.prisma.contractMatch.count({
        where: { resolutionDiverged: true },
      }),
    ]);

    const divergenceRate =
      totalResolved > 0 ? divergedCount / totalResolved : 0;

    return { totalResolved, divergedCount, divergenceRate };
  }

  private buildResolutionFilter(
    status: 'resolved' | 'unresolved' | 'diverged',
  ): Record<string, unknown> {
    switch (status) {
      case 'resolved':
        return { resolutionTimestamp: { not: null } };
      case 'unresolved':
        return { resolutionTimestamp: null };
      case 'diverged':
        return { resolutionDiverged: true };
    }
  }
}
