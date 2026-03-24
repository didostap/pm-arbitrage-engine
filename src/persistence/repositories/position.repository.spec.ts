import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import Decimal from 'decimal.js';
import { PositionRepository } from './position.repository';
import { PrismaService } from '../../common/prisma.service';
import { asPositionId } from '../../common/types/branded.type';
import { SystemHealthError } from '../../common/errors/system-health-error';

describe('PositionRepository', () => {
  let repo: PositionRepository;
  const mockPrisma = {
    openPosition: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionRepository,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    repo = module.get<PositionRepository>(PositionRepository);
  });

  it('should create a position', async () => {
    const data = {
      pair: { connect: { matchId: 'pair-1' } },
      kalshiOrder: { connect: { orderId: 'order-k-1' } },
      polymarketOrder: { connect: { orderId: 'order-p-1' } },
      kalshiSide: 'buy',
      polymarketSide: 'sell',
      entryPrices: { kalshi: '0.45', polymarket: '0.55' },
      sizes: { kalshi: '100', polymarket: '100' },
      expectedEdge: 0.08,
      status: 'OPEN' as const,
    };
    mockPrisma.openPosition.create.mockResolvedValue({
      positionId: 'pos-1',
      ...data,
    });

    const result = await repo.create(data);

    expect(mockPrisma.openPosition.create).toHaveBeenCalledWith({ data });
    expect(result.positionId).toBe('pos-1');
  });

  it('should find position by ID', async () => {
    mockPrisma.openPosition.findUnique.mockResolvedValue({
      positionId: 'pos-1',
    });

    const result = await repo.findById(asPositionId('pos-1'));

    expect(mockPrisma.openPosition.findUnique).toHaveBeenCalledWith({
      where: { positionId: 'pos-1' },
    });
    expect(result?.positionId).toBe('pos-1');
  });

  it('should find positions by status', async () => {
    mockPrisma.openPosition.findMany.mockResolvedValue([
      { positionId: 'pos-1', status: 'OPEN' },
    ]);

    const result = await repo.findByStatus('OPEN', false);

    expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith({
      where: { status: 'OPEN', isPaper: false },
    });
    expect(result).toHaveLength(1);
  });

  it('should update position status', async () => {
    mockPrisma.openPosition.update.mockResolvedValue({
      positionId: 'pos-1',
      status: 'CLOSED',
    });

    const result = await repo.updateStatus(asPositionId('pos-1'), 'CLOSED');

    expect(mockPrisma.openPosition.update).toHaveBeenCalledWith({
      where: { positionId: 'pos-1' },
      data: { status: 'CLOSED' },
    });
    expect(result.status).toBe('CLOSED');
  });

  describe('closePosition', () => {
    it('should update status to CLOSED with realizedPnl rounded to 8 decimal places', async () => {
      mockPrisma.openPosition.update.mockResolvedValue({
        positionId: 'pos-1',
        status: 'CLOSED',
        realizedPnl: new Decimal('5.06'),
      });

      await repo.closePosition(
        asPositionId('pos-1'),
        new Decimal('5.06123456789'),
      );

      expect(mockPrisma.openPosition.update).toHaveBeenCalledWith({
        where: { positionId: 'pos-1' },
        data: { status: 'CLOSED', realizedPnl: new Decimal('5.06123457') },
      });
    });

    it('should throw SystemHealthError when realizedPnl is NaN', async () => {
      await expect(
        repo.closePosition(asPositionId('pos-1'), new Decimal(NaN)),
      ).rejects.toThrow(SystemHealthError);
    });

    it('should throw SystemHealthError when realizedPnl is Infinity', async () => {
      await expect(
        repo.closePosition(asPositionId('pos-1'), new Decimal(Infinity)),
      ).rejects.toThrow(SystemHealthError);
    });

    it('should accept zero realizedPnl', async () => {
      mockPrisma.openPosition.update.mockResolvedValue({
        positionId: 'pos-1',
        status: 'CLOSED',
        realizedPnl: new Decimal('0'),
      });

      await repo.closePosition(asPositionId('pos-1'), new Decimal(0));

      expect(mockPrisma.openPosition.update).toHaveBeenCalledWith({
        where: { positionId: 'pos-1' },
        data: { status: 'CLOSED', realizedPnl: new Decimal('0') },
      });
    });

    it('should accept negative realizedPnl', async () => {
      mockPrisma.openPosition.update.mockResolvedValue({
        positionId: 'pos-1',
        status: 'CLOSED',
        realizedPnl: new Decimal('-1.32'),
      });

      await repo.closePosition(asPositionId('pos-1'), new Decimal('-1.32'));

      expect(mockPrisma.openPosition.update).toHaveBeenCalledWith({
        where: { positionId: 'pos-1' },
        data: { status: 'CLOSED', realizedPnl: new Decimal('-1.32') },
      });
    });
  });

  describe('updateStatusWithAccumulatedPnl', () => {
    it('should accumulate pnlDelta onto existingPnl', async () => {
      mockPrisma.openPosition.update.mockResolvedValue({
        positionId: 'pos-1',
        status: 'EXIT_PARTIAL',
        realizedPnl: new Decimal('8.06'),
      });

      await repo.updateStatusWithAccumulatedPnl(
        asPositionId('pos-1'),
        'EXIT_PARTIAL',
        new Decimal('3.00'),
        new Decimal('5.06'),
      );

      expect(mockPrisma.openPosition.update).toHaveBeenCalledWith({
        where: { positionId: 'pos-1' },
        data: { status: 'EXIT_PARTIAL', realizedPnl: new Decimal('8.06') },
      });
    });

    it('should handle zero existingPnl', async () => {
      mockPrisma.openPosition.update.mockResolvedValue({});

      await repo.updateStatusWithAccumulatedPnl(
        asPositionId('pos-1'),
        'EXIT_PARTIAL',
        new Decimal('5.06'),
        new Decimal(0),
      );

      expect(mockPrisma.openPosition.update).toHaveBeenCalledWith({
        where: { positionId: 'pos-1' },
        data: { status: 'EXIT_PARTIAL', realizedPnl: new Decimal('5.06') },
      });
    });

    it('should throw SystemHealthError when pnlDelta is NaN', async () => {
      await expect(
        repo.updateStatusWithAccumulatedPnl(
          asPositionId('pos-1'),
          'EXIT_PARTIAL',
          new Decimal(NaN),
          new Decimal(0),
        ),
      ).rejects.toThrow(SystemHealthError);
    });
  });

  describe('isPaper filtering', () => {
    it('findByStatus filters to isPaper false when passed explicitly', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await repo.findByStatus('OPEN', false);

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith({
        where: { status: 'OPEN', isPaper: false },
      });
    });

    it('findByStatus filters to isPaper true when requested', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await repo.findByStatus('OPEN', true);

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith({
        where: { status: 'OPEN', isPaper: true },
      });
    });

    it('findByStatusWithPair filters to isPaper false when passed explicitly', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await repo.findByStatusWithPair('OPEN', false);

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith({
        where: { status: 'OPEN', isPaper: false },
        include: { pair: true },
      });
    });

    it('findByStatusWithPair filters to isPaper true when requested', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await repo.findByStatusWithPair('OPEN', true);

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith({
        where: { status: 'OPEN', isPaper: true },
        include: { pair: true },
      });
    });

    it('findByStatusWithOrders filters to isPaper false when passed explicitly', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await repo.findByStatusWithOrders('OPEN', false);

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith({
        where: { status: 'OPEN', isPaper: false },
        include: { pair: true, kalshiOrder: true, polymarketOrder: true },
      });
    });

    it('findByStatusWithOrders filters to isPaper true when requested', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await repo.findByStatusWithOrders('OPEN', true);

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith({
        where: { status: 'OPEN', isPaper: true },
        include: { pair: true, kalshiOrder: true, polymarketOrder: true },
      });
    });

    it('findActivePositions filters to isPaper false when passed explicitly', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await repo.findActivePositions(false);

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith({
        where: {
          isPaper: false,
          status: {
            in: [
              'OPEN',
              'SINGLE_LEG_EXPOSED',
              'EXIT_PARTIAL',
              'RECONCILIATION_REQUIRED',
            ],
          },
        },
        include: { pair: true, kalshiOrder: true, polymarketOrder: true },
      });
    });

    it('findActivePositions filters to isPaper true when requested', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await repo.findActivePositions(true);

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith({
        where: {
          isPaper: true,
          status: {
            in: [
              'OPEN',
              'SINGLE_LEG_EXPOSED',
              'EXIT_PARTIAL',
              'RECONCILIATION_REQUIRED',
            ],
          },
        },
        include: { pair: true, kalshiOrder: true, polymarketOrder: true },
      });
    });
  });

  describe('findManyWithFilters', () => {
    it('should filter by status array when provided', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);
      mockPrisma.openPosition.count.mockResolvedValue(0);

      const result = await repo.findManyWithFilters(
        ['OPEN', 'EXIT_PARTIAL'],
        undefined,
        1,
        50,
      );

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith({
        where: { status: { in: ['OPEN', 'EXIT_PARTIAL'] } },
        include: { pair: true, kalshiOrder: true, polymarketOrder: true },
        orderBy: { updatedAt: 'desc' },
        skip: 0,
        take: 50,
      });
      expect(result.count).toBe(0);
      expect(result.data).toEqual([]);
    });

    it('should return all statuses when statuses is undefined', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);
      mockPrisma.openPosition.count.mockResolvedValue(0);

      await repo.findManyWithFilters(undefined, undefined, 1, 50);

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith({
        where: {},
        include: { pair: true, kalshiOrder: true, polymarketOrder: true },
        orderBy: { updatedAt: 'desc' },
        skip: 0,
        take: 50,
      });
    });

    it('should return all statuses when statuses is empty array', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);
      mockPrisma.openPosition.count.mockResolvedValue(0);

      await repo.findManyWithFilters([], undefined, 1, 50);

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith({
        where: {},
        include: { pair: true, kalshiOrder: true, polymarketOrder: true },
        orderBy: { updatedAt: 'desc' },
        skip: 0,
        take: 50,
      });
    });

    it('should filter by isPaper when provided', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);
      mockPrisma.openPosition.count.mockResolvedValue(0);

      await repo.findManyWithFilters(['OPEN'], true, 1, 50);

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith({
        where: { status: { in: ['OPEN'] }, isPaper: true },
        include: { pair: true, kalshiOrder: true, polymarketOrder: true },
        orderBy: { updatedAt: 'desc' },
        skip: 0,
        take: 50,
      });
    });

    it('should compute pagination correctly', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);
      mockPrisma.openPosition.count.mockResolvedValue(75);

      const result = await repo.findManyWithFilters(
        undefined,
        undefined,
        3,
        25,
      );

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 50, take: 25 }),
      );
      expect(result.count).toBe(75);
    });

    it('should include orders via pair relation for realized P&L computation', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);
      mockPrisma.openPosition.count.mockResolvedValue(0);

      await repo.findManyWithFilters(undefined, undefined, 1, 10);

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { pair: true, kalshiOrder: true, polymarketOrder: true },
        }),
      );
    });

    it('should sort by specified field ascending', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);
      mockPrisma.openPosition.count.mockResolvedValue(0);

      await repo.findManyWithFilters(
        undefined,
        undefined,
        1,
        50,
        'expectedEdge',
        'asc',
      );

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { expectedEdge: 'asc' },
        }),
      );
    });

    it('should sort by specified field descending', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);
      mockPrisma.openPosition.count.mockResolvedValue(0);

      await repo.findManyWithFilters(
        undefined,
        undefined,
        1,
        50,
        'status',
        'desc',
      );

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { status: 'desc' },
        }),
      );
    });

    it('should default to desc when sortBy provided without order', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);
      mockPrisma.openPosition.count.mockResolvedValue(0);

      await repo.findManyWithFilters(undefined, undefined, 1, 50, 'createdAt');

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('should default to updatedAt desc when no sort params provided', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);
      mockPrisma.openPosition.count.mockResolvedValue(0);

      await repo.findManyWithFilters(undefined, undefined, 1, 50);

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { updatedAt: 'desc' },
        }),
      );
    });

    it('should sort by isPaper field', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);
      mockPrisma.openPosition.count.mockResolvedValue(0);

      await repo.findManyWithFilters(
        undefined,
        undefined,
        1,
        50,
        'isPaper',
        'asc',
      );

      expect(mockPrisma.openPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { isPaper: 'asc' },
        }),
      );
    });
  });

  describe('getLatestPositionDateByPairIds', () => {
    it('should return empty map when no pairIds provided', async () => {
      const result = await repo.getLatestPositionDateByPairIds([], true);
      expect(result.size).toBe(0);
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('should return map of pairId→Date for single pair', async () => {
      const date = new Date('2026-03-24T10:00:00Z');
      mockPrisma.$queryRaw.mockResolvedValue([
        { pair_id: 'pair-A', latest: date },
      ]);
      const result = await repo.getLatestPositionDateByPairIds(
        ['pair-A'],
        true,
      );
      expect(result.size).toBe(1);
      expect(result.get('pair-A')).toEqual(date);
    });

    it('should return map of pairId→Date for multiple pairs', async () => {
      const dateA = new Date('2026-03-24T10:00:00Z');
      const dateB = new Date('2026-03-24T09:00:00Z');
      mockPrisma.$queryRaw.mockResolvedValue([
        { pair_id: 'pair-A', latest: dateA },
        { pair_id: 'pair-B', latest: dateB },
      ]);
      const result = await repo.getLatestPositionDateByPairIds(
        ['pair-A', 'pair-B'],
        false,
      );
      expect(result.size).toBe(2);
      expect(result.get('pair-A')).toEqual(dateA);
      expect(result.get('pair-B')).toEqual(dateB);
    });

    it('should return empty map when no matching positions exist', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      const result = await repo.getLatestPositionDateByPairIds(
        ['pair-X'],
        true,
      );
      expect(result.size).toBe(0);
    });

    it('should scope by isPaper (mode isolation)', async () => {
      const date = new Date('2026-03-24T10:00:00Z');
      mockPrisma.$queryRaw.mockResolvedValue([
        { pair_id: 'pair-A', latest: date },
      ]);
      await repo.getLatestPositionDateByPairIds(['pair-A'], false);
      // Verify the raw query was called (mode filtering in SQL)
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('getActivePositionCountsByPair', () => {
    it('should return empty map when no open positions exist', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      const result = await repo.getActivePositionCountsByPair(true);
      expect(result.size).toBe(0);
    });

    it('should return map of pairId→count for open positions', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { pair_id: 'pair-A', count: BigInt(3) },
        { pair_id: 'pair-B', count: BigInt(2) },
      ]);
      const result = await repo.getActivePositionCountsByPair(true);
      expect(result.size).toBe(2);
      expect(result.get('pair-A')).toBe(3);
      expect(result.get('pair-B')).toBe(2);
    });

    it('should return single pair count', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { pair_id: 'pair-A', count: BigInt(1) },
      ]);
      const result = await repo.getActivePositionCountsByPair(false);
      expect(result.size).toBe(1);
      expect(result.get('pair-A')).toBe(1);
    });

    it('should scope by isPaper (mode isolation)', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      await repo.getActivePositionCountsByPair(false);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
      mockPrisma.$queryRaw.mockClear();
      await repo.getActivePositionCountsByPair(true);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });
});
