import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthTokenGuard } from './auth-token.guard';

function createMockContext(authHeader?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: authHeader !== undefined ? { authorization: authHeader } : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('AuthTokenGuard', () => {
  let guard: AuthTokenGuard;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      get: (key: string) => {
        if (key === 'OPERATOR_API_TOKEN') return 'test-secret-token';
        return undefined;
      },
    } as unknown as ConfigService;
    guard = new AuthTokenGuard(configService);
  });

  it('should allow valid token', () => {
    const context = createMockContext('Bearer test-secret-token');
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should reject missing Authorization header', () => {
    const context = createMockContext();
    expect(guard.canActivate(context)).toBe(false);
  });

  it('should reject invalid token', () => {
    const context = createMockContext('Bearer wrong-token');
    expect(guard.canActivate(context)).toBe(false);
  });

  it('should reject non-Bearer scheme', () => {
    const context = createMockContext('Basic test-secret-token');
    expect(guard.canActivate(context)).toBe(false);
  });

  it('should reject empty Bearer token', () => {
    const context = createMockContext('Bearer ');
    expect(guard.canActivate(context)).toBe(false);
  });
});
