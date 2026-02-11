import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './common/prisma.service';
import { PrismaClientInitializationError } from '@prisma/client/runtime/library';

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
      expect(result.data).toEqual({ status: 'ok' });
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

    it('should return error with code 4002 when database fails', async () => {
      const result = await appController.getHealth();

      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('timestamp');
      expect(result.error).toEqual({
        code: 4002,
        message: 'Database initialization failed',
        severity: 'critical',
      });
      expect(typeof result.timestamp).toBe('string');
    });
  });
});
