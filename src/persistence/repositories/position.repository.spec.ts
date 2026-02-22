import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { PositionRepository } from './position.repository';
import { PrismaService } from '../../common/prisma.service';

describe('PositionRepository', () => {
  let repo: PositionRepository;
  const mockPrisma = {
    openPosition: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
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

    const result = await repo.findById('pos-1');

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

    const result = await repo.updateStatus('pos-1', 'CLOSED');

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
});
