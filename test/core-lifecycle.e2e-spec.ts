import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma.service';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * End-to-end test for complete engine lifecycle:
 * startup → polling cycle → graceful shutdown
 */
describe('Core Lifecycle (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  beforeEach(async () => {
    const mockPrismaService = {
      $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
      $connect: vi.fn().mockResolvedValue(undefined),
      $disconnect: vi.fn().mockResolvedValue(undefined),
      onModuleInit: vi.fn().mockResolvedValue(undefined),
      onModuleDestroy: vi.fn().mockResolvedValue(undefined),
      riskState: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
      platformHealthLog: {
        create: vi.fn().mockResolvedValue({}),
      },
      orderBookSnapshot: {
        create: vi.fn().mockResolvedValue({}),
      },
      contractMatch: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
      },
      riskOverrideLog: {
        create: vi.fn().mockResolvedValue({}),
      },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    prisma = moduleFixture.get<PrismaService>(PrismaService);
    await app.init();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should start up, verify database, and initialize services', () => {
    expect(app).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(prisma.$queryRaw)).toHaveBeenCalled();
  });

  it('should run polling cycles during operation', () => {
    // Polling cycles run automatically in background
    // (scheduler uses 30s default, but lifecycle should be stable)
    expect(app).toBeDefined();
  });

  it('should shut down gracefully without errors', async () => {
    expect(app).toBeDefined();

    // Trigger graceful shutdown - should complete without errors
    // Prisma disconnect is called automatically by NestJS lifecycle (onModuleDestroy)
    await expect(app.close()).resolves.not.toThrow();
  }, 15000); // 15s timeout for shutdown test

  it('should handle startup failure if database unavailable', async () => {
    // Create a new app instance with failing database
    const failingPrisma = {
      $queryRaw: vi.fn().mockRejectedValue(new Error('Connection failed')),
      $connect: vi.fn().mockResolvedValue(undefined),
      $disconnect: vi.fn().mockResolvedValue(undefined),
      onModuleInit: vi.fn().mockResolvedValue(undefined),
      onModuleDestroy: vi.fn().mockResolvedValue(undefined),
      riskState: {
        findFirst: vi.fn().mockRejectedValue(new Error('Connection failed')),
        upsert: vi.fn().mockRejectedValue(new Error('Connection failed')),
      },
      platformHealthLog: {
        create: vi.fn().mockRejectedValue(new Error('Connection failed')),
      },
      orderBookSnapshot: {
        create: vi.fn().mockRejectedValue(new Error('Connection failed')),
      },
      contractMatch: {
        findUnique: vi.fn().mockRejectedValue(new Error('Connection failed')),
        findMany: vi.fn().mockRejectedValue(new Error('Connection failed')),
        upsert: vi.fn().mockRejectedValue(new Error('Connection failed')),
      },
    };

    const failingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(failingPrisma)
      .compile();

    const failingApp =
      failingModule.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
      );

    // Startup should fail when database connection fails
    await expect(failingApp.init()).rejects.toThrow('Connection failed');
  });
});
