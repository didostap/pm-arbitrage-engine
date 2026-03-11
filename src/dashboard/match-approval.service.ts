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
import type { MatchSummaryDto } from './dto/match-approval.dto';
import type { ContractMatch } from '@prisma/client';

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
  ): Promise<{
    data: MatchSummaryDto[];
    count: number;
    page: number;
    limit: number;
  }> {
    const where = {
      ...this.buildWhereFilter(status),
      ...this.buildResolutionFilter(resolution),
    };
    const skip = (page - 1) * limit;

    const [matches, count] = await Promise.all([
      this.prisma.contractMatch.findMany({
        where,
        orderBy: [{ operatorApproved: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.contractMatch.count({ where }),
    ]);

    return {
      data: matches.map((m) => this.toSummaryDto(m)),
      count,
      page,
      limit,
    };
  }

  async getMatchById(matchId: string): Promise<MatchSummaryDto> {
    const match = await this.prisma.contractMatch.findUnique({
      where: { matchId },
    });

    if (!match) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
        `Contract match '${matchId}' not found`,
        'warning',
        'MatchApprovalService',
      );
    }

    return this.toSummaryDto(match);
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
        matchId,
        updated.polymarketContractId,
        updated.kalshiContractId,
        rationale,
      ),
    );

    this.logger.log({
      message: 'Contract match approved',
      data: { matchId, rationale },
    });

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
      data: {
        operatorApproved: false,
        operatorRationale: rationale,
        operatorApprovalTimestamp: new Date(),
      },
    });

    this.eventEmitter.emit(
      EVENT_NAMES.MATCH_REJECTED,
      new MatchRejectedEvent(
        matchId,
        updated.polymarketContractId,
        updated.kalshiContractId,
        rationale,
      ),
    );

    this.logger.log({
      message: 'Contract match rejected',
      data: { matchId, rationale },
    });

    return this.toSummaryDto(updated);
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

  private toSummaryDto(match: ContractMatch): MatchSummaryDto {
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
      createdAt: match.createdAt.toISOString(),
      updatedAt: match.updatedAt.toISOString(),
    };
  }
}
