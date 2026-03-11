import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { PositionRepository } from './position.repository';
import { PrismaService } from '../../common/prisma.service';
import { asPositionId } from '../../common/types/branded.type';

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

    const result = await repo.findByStatus('OPEN');

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

  describe('isPaper filtering', () => {
    it('findByStatus defaults to isPaper false', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await repo.findByStatus('OPEN');

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

    it('findByStatusWithPair defaults to isPaper false', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await repo.findByStatusWithPair('OPEN');

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

    it('findByStatusWithOrders defaults to isPaper false', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await repo.findByStatusWithOrders('OPEN');

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

    it('findActivePositions defaults to isPaper false', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await repo.findActivePositions();

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
  });
});
