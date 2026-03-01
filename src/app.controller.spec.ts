import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './common/prisma.service';
import { PrismaClientInitializationError } from '@prisma/client/runtime/library';
import { SystemHealthError } from './common/errors/system-health-error';

describe('AppController', () => {
  let appController: AppController;

  describe('health - success case', () => {
    beforeEach(async () => {
      const mockPrismaService = {
        $queryRaw: () => Promise.resolve([{ '?column?': 1 }]),
      };

      const app: TestingModule = await Test.createTestingModule({
        controllers: [AppController],
        providers: [
          AppService,
          {
            provide: PrismaService,
            useValue: mockPrismaService,
          },
        ],
      }).compile();

      appController = app.get<AppController>(AppController);
    });

    it('should return health status with timestamp', async () => {
      const result = await appController.getHealth();

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('timestamp');
      expect(result.data).toEqual({
        status: 'ok',
        service: 'pm-arbitrage-engine',
      });
      expect(typeof result.timestamp).toBe('string');
    });
  });

  describe('health - database failure case', () => {
    beforeEach(async () => {
      const mockPrismaService = {
        $queryRaw: () =>
          Promise.reject(
            new PrismaClientInitializationError(
              'Database connection failed',
              '1.0.0',
            ),
          ),
      };

      const app: TestingModule = await Test.createTestingModule({
        controllers: [AppController],
        providers: [
          AppService,
          {
            provide: PrismaService,
            useValue: mockPrismaService,
          },
        ],
      }).compile();

      appController = app.get<AppController>(AppController);
    });

    it('should throw SystemHealthError when database fails', async () => {
      await expect(appController.getHealth()).rejects.toThrow(
        SystemHealthError,
      );
      await expect(appController.getHealth()).rejects.toThrow(
        'Database initialization failed',
      );
    });
  });
});
