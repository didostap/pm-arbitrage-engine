import { describe, it, expect } from 'vitest';
import type { IExternalPairProvider } from './external-pair-provider.interface';
import type { ExternalMatchedPair } from '../../modules/backtesting/types/match-validation.types';
import {
  ODDSPIPE_PAIR_PROVIDER_TOKEN,
  PREDEXON_PAIR_PROVIDER_TOKEN,
} from './external-pair-provider.interface';

describe('IExternalPairProvider', () => {
  it('[P0] interface should define fetchPairs() and getSourceId() (type-level verification via mock implementation)', () => {
    const mockProvider: IExternalPairProvider = {
      fetchPairs: async (): Promise<ExternalMatchedPair[]> => [],
      getSourceId: (): string => 'test',
    };

    expect(mockProvider.fetchPairs).toBeDefined();
    expect(mockProvider.getSourceId).toBeDefined();
    expect(typeof mockProvider.fetchPairs).toBe('function');
    expect(typeof mockProvider.getSourceId).toBe('function');
  });

  it('[P0] ODDSPIPE_PAIR_PROVIDER_TOKEN and PREDEXON_PAIR_PROVIDER_TOKEN should be exported and unique', () => {
    expect(ODDSPIPE_PAIR_PROVIDER_TOKEN).toBeDefined();
    expect(PREDEXON_PAIR_PROVIDER_TOKEN).toBeDefined();
    expect(ODDSPIPE_PAIR_PROVIDER_TOKEN).not.toBe(PREDEXON_PAIR_PROVIDER_TOKEN);
  });

  it('[P1] DI tokens should follow IContractCatalogProvider multi-token pattern (string token format)', () => {
    expect(typeof ODDSPIPE_PAIR_PROVIDER_TOKEN).toBe('string');
    expect(typeof PREDEXON_PAIR_PROVIDER_TOKEN).toBe('string');
    expect(ODDSPIPE_PAIR_PROVIDER_TOKEN).toBe('ODDSPIPE_PAIR_PROVIDER');
    expect(PREDEXON_PAIR_PROVIDER_TOKEN).toBe('PREDEXON_PAIR_PROVIDER');
  });
});
