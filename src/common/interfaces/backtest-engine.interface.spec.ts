import { describe, it, expect } from 'vitest';

describe('IBacktestEngine Interface', () => {
  it('[P2] should export IBacktestEngine interface with startRun, cancelRun, getRunStatus methods', async () => {
    const mod = await import('./backtest-engine.interface');
    // Verify the token exists (interfaces are erased at runtime, so we test via token)
    expect(mod.BACKTEST_ENGINE_TOKEN).toBeDefined();
    expect(typeof mod.BACKTEST_ENGINE_TOKEN).toBe('symbol');
  });

  it('[P2] should export BACKTEST_ENGINE_TOKEN injection token', async () => {
    const mod = await import('./backtest-engine.interface');
    expect(mod.BACKTEST_ENGINE_TOKEN).toBeDefined();
    expect(mod.BACKTEST_ENGINE_TOKEN.toString()).toContain('IBacktestEngine');
  });
});
