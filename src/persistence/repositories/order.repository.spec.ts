import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { OrderRepository } from './order.repository';
import { PrismaService } from '../../common/prisma.service';

describe('OrderRepository', () => {
  let repo: OrderRepository;
  const mockPrisma = {
    order: {
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
        OrderRepository,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    repo = module.get<OrderRepository>(OrderRepository);
  });

  it('should create an order', async () => {
    const data = {
      platform: 'KALSHI' as const,
      contractId: 'kalshi-1',
      pair: { connect: { matchId: 'pair-1' } },
      side: 'buy',
      price: 0.45,
      size: 100,
      status: 'FILLED' as const,
      fillPrice: 0.45,
      fillSize: 100,
    };
    mockPrisma.order.create.mockResolvedValue({ orderId: 'order-1', ...data });

    const result = await repo.create(data);

    expect(mockPrisma.order.create).toHaveBeenCalledWith({ data });
    expect(result.orderId).toBe('order-1');
  });

  it('should find order by ID', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ orderId: 'order-1' });

    const result = await repo.findById('order-1');

    expect(mockPrisma.order.findUnique).toHaveBeenCalledWith({
      where: { orderId: 'order-1' },
    });
    expect(result?.orderId).toBe('order-1');
  });

  it('should find orders by pair ID', async () => {
    mockPrisma.order.findMany.mockResolvedValue([{ orderId: 'order-1' }]);

    const result = await repo.findByPairId('pair-1');

    expect(mockPrisma.order.findMany).toHaveBeenCalledWith({
      where: { pairId: 'pair-1' },
    });
    expect(result).toHaveLength(1);
  });

  it('should update order status', async () => {
    mockPrisma.order.update.mockResolvedValue({
      orderId: 'order-1',
      status: 'CANCELLED',
    });

    const result = await repo.updateStatus('order-1', 'CANCELLED');

    expect(mockPrisma.order.update).toHaveBeenCalledWith({
      where: { orderId: 'order-1' },
      data: { status: 'CANCELLED' },
    });
    expect(result.status).toBe('CANCELLED');
  });

  describe('isPaper filtering', () => {
    it('findPendingOrders defaults to isPaper false', async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);

      await repo.findPendingOrders();

      expect(mockPrisma.order.findMany).toHaveBeenCalledWith({
        where: { status: 'PENDING', isPaper: false },
      });
    });

    it('findPendingOrders filters to isPaper true when requested', async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);

      await repo.findPendingOrders(true);

      expect(mockPrisma.order.findMany).toHaveBeenCalledWith({
        where: { status: 'PENDING', isPaper: true },
      });
    });
  });
});
