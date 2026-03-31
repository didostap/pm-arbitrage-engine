import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MatchApprovalController } from './match-approval.controller';
import { MatchApprovalService } from './match-approval.service';
import { HttpException } from '@nestjs/common';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../common/errors/system-health-error';
import {
  MatchStatusFilter,
  MatchSortField,
  type MatchSummaryDto,
} from './dto/match-approval.dto';
import { SortOrder } from './dto/common-query.dto';

function buildMatchDto(
  overrides: Partial<MatchSummaryDto> = {},
): MatchSummaryDto {
  return {
    matchId: 'match-1',
    polymarketContractId: 'poly-123',
    polymarketClobTokenId: null,
    kalshiContractId: 'kalshi-456',
    polymarketDescription: 'Will X happen?',
    kalshiDescription: 'Will X happen by date?',
    operatorApproved: false,
    operatorApprovalTimestamp: null,
    operatorRationale: null,
    confidenceScore: null,
    polymarketResolution: null,
    kalshiResolution: null,
    resolutionTimestamp: null,
    resolutionDiverged: null,
    divergenceNotes: null,
    polymarketRawCategory: null,
    kalshiRawCategory: null,
    polymarketOutcomeLabel: null,
    kalshiOutcomeLabel: null,
    firstTradedTimestamp: null,
    totalCyclesTraded: 0,
    primaryLeg: null,
    resolutionDate: null,
    resolutionCriteriaHash: null,
    lastAnnualizedReturn: null,
    lastNetEdge: null,
    lastComputedAt: null,
    cluster: null,
    origin: 'DISCOVERY',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('MatchApprovalController', () => {
  let controller: MatchApprovalController;
  let service: {
    listMatches: ReturnType<typeof vi.fn>;
    getMatchById: ReturnType<typeof vi.fn>;
    approveMatch: ReturnType<typeof vi.fn>;
    rejectMatch: ReturnType<typeof vi.fn>;
    listClusters: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    service = {
      listMatches: vi.fn(),
      getMatchById: vi.fn(),
      approveMatch: vi.fn(),
      rejectMatch: vi.fn(),
      listClusters: vi.fn(),
    };

    controller = new MatchApprovalController(
      service as unknown as MatchApprovalService,
    );
  });

  describe('GET /api/matches', () => {
    it('should list all matches (default filter)', async () => {
      const listResult = {
        data: [buildMatchDto()],
        count: 1,
        page: 1,
        limit: 20,
      };
      service.listMatches.mockResolvedValue(listResult);

      const result = await controller.listMatches({});

      expect(service.listMatches).toHaveBeenCalledWith(
        'all',
        1,
        20,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      expect(result.data).toHaveLength(1);
      expect(result.count).toBe(1);
      expect(result.timestamp).toBeDefined();
    });

    it('should pass status filter to service', async () => {
      service.listMatches.mockResolvedValue({
        data: [],
        count: 0,
        page: 1,
        limit: 20,
      });

      await controller.listMatches({ status: MatchStatusFilter.PENDING });

      expect(service.listMatches).toHaveBeenCalledWith(
        'pending',
        1,
        20,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should pass pagination params', async () => {
      service.listMatches.mockResolvedValue({
        data: [],
        count: 0,
        page: 2,
        limit: 50,
      });

      await controller.listMatches({ page: 2, limit: 50 });

      expect(service.listMatches).toHaveBeenCalledWith(
        'all',
        2,
        50,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should pass sortBy and order to service', async () => {
      service.listMatches.mockResolvedValue({
        data: [],
        count: 0,
        page: 1,
        limit: 20,
      });

      await controller.listMatches({
        sortBy: MatchSortField.LAST_ANNUALIZED_RETURN,
        order: SortOrder.DESC,
      });

      expect(service.listMatches).toHaveBeenCalledWith(
        'all',
        1,
        20,
        undefined,
        undefined,
        MatchSortField.LAST_ANNUALIZED_RETURN,
        SortOrder.DESC,
        undefined,
      );
    });
  });

  describe('GET /api/matches/:id', () => {
    it('should return single match', async () => {
      service.getMatchById.mockResolvedValue(buildMatchDto());

      const result = await controller.getMatchById('match-1');

      expect(service.getMatchById).toHaveBeenCalledWith('match-1');
      expect(result.data.matchId).toBe('match-1');
      expect(result.timestamp).toBeDefined();
    });

    it('should propagate 404 from service', async () => {
      service.getMatchById.mockRejectedValue(
        new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
          'Not found',
          'warning',
        ),
      );

      await expect(controller.getMatchById('nonexistent')).rejects.toThrow(
        HttpException,
      );
    });
  });

  describe('POST /api/matches/:id/approve', () => {
    it('should approve match and return action response', async () => {
      const approved = buildMatchDto({
        operatorApproved: true,
        operatorRationale: 'Good match',
      });
      service.approveMatch.mockResolvedValue(approved);

      const result = await controller.approveMatch('match-1', {
        rationale: 'Good match',
      });

      expect(service.approveMatch).toHaveBeenCalledWith(
        'match-1',
        'Good match',
        undefined,
      );
      expect(result.data.matchId).toBe('match-1');
      expect(result.data.status).toBe('approved');
      expect(result.data.operatorRationale).toBe('Good match');
      expect(result.timestamp).toBeDefined();
    });

    it('should pass resolutionDate to service when provided', async () => {
      const approved = buildMatchDto({
        operatorApproved: true,
        operatorRationale: 'Good match',
        resolutionDate: '2026-06-30T00:00:00.000Z',
      });
      service.approveMatch.mockResolvedValue(approved);

      await controller.approveMatch('match-1', {
        rationale: 'Good match',
        resolutionDate: '2026-06-30T00:00:00Z',
      });

      expect(service.approveMatch).toHaveBeenCalledWith(
        'match-1',
        'Good match',
        '2026-06-30T00:00:00Z',
      );
    });

    it('should propagate 409 from service', async () => {
      service.approveMatch.mockRejectedValue(
        new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.MATCH_ALREADY_APPROVED,
          'Already approved',
          'warning',
        ),
      );

      await expect(
        controller.approveMatch('match-1', { rationale: 'retry' }),
      ).rejects.toThrow(HttpException);
    });
  });

  describe('GET /api/matches/clusters', () => {
    it('should return clusters with count and timestamp', async () => {
      const clusters = [
        { id: 'c1', name: 'Crypto', slug: 'crypto' },
        { id: 'c2', name: 'Politics', slug: 'politics' },
      ];
      service.listClusters.mockResolvedValue(clusters);

      const result = await controller.listClusters();

      expect(service.listClusters).toHaveBeenCalled();
      expect(result.data).toEqual(clusters);
      expect(result.count).toBe(2);
      expect(result.timestamp).toBeDefined();
    });
  });

  describe('POST /api/matches/:id/reject', () => {
    it('should reject match and return action response', async () => {
      const rejected = buildMatchDto({
        operatorRationale: 'Not matching',
      });
      service.rejectMatch.mockResolvedValue(rejected);

      const result = await controller.rejectMatch('match-1', {
        rationale: 'Not matching',
      });

      expect(service.rejectMatch).toHaveBeenCalledWith(
        'match-1',
        'Not matching',
      );
      expect(result.data.matchId).toBe('match-1');
      expect(result.data.status).toBe('rejected');
      expect(result.data.operatorRationale).toBe('Not matching');
    });

    it('should propagate 404 from service', async () => {
      service.rejectMatch.mockRejectedValue(
        new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
          'Not found',
          'warning',
        ),
      );

      await expect(
        controller.rejectMatch('nonexistent', { rationale: 'reason' }),
      ).rejects.toThrow(HttpException);
    });
  });
});
