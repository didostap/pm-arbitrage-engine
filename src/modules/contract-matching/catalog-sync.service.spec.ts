import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CatalogSyncService } from './catalog-sync.service';
import { PlatformId } from '../../common/types/platform.type';
import type {
  IContractCatalogProvider,
  ContractSummary,
} from '../../common/interfaces/contract-catalog-provider.interface';

function makeSummary(platform: PlatformId, id: string): ContractSummary {
  return {
    contractId: id,
    title: `Title ${id}`,
    description: `Description ${id}`,
    platform,
  };
}

function makeMockProvider(
  platform: PlatformId,
  contracts: ContractSummary[] = [],
): IContractCatalogProvider {
  return {
    getPlatformId: () => platform,
    listActiveContracts: vi.fn().mockResolvedValue(contracts),
  };
}

describe('CatalogSyncService', () => {
  let service: CatalogSyncService;
  let kalshiProvider: IContractCatalogProvider;
  let polyProvider: IContractCatalogProvider;

  beforeEach(() => {
    const kalshiContracts = [makeSummary(PlatformId.KALSHI, 'K1')];
    const polyContracts = [
      makeSummary(PlatformId.POLYMARKET, 'P1'),
      makeSummary(PlatformId.POLYMARKET, 'P2'),
    ];

    kalshiProvider = makeMockProvider(PlatformId.KALSHI, kalshiContracts);
    polyProvider = makeMockProvider(PlatformId.POLYMARKET, polyContracts);

    service = new CatalogSyncService(kalshiProvider, polyProvider);
  });

  it('should aggregate catalogs from both providers', async () => {
    const results = await service.syncCatalogs();

    expect(results.size).toBe(2);
    expect(results.get(PlatformId.KALSHI)).toHaveLength(1);
    expect(results.get(PlatformId.POLYMARKET)).toHaveLength(2);
  });

  it('should continue when one provider fails', async () => {
    (
      kalshiProvider.listActiveContracts as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('Kalshi API down'));

    const results = await service.syncCatalogs();

    expect(results.size).toBe(1);
    expect(results.has(PlatformId.KALSHI)).toBe(false);
    expect(results.get(PlatformId.POLYMARKET)).toHaveLength(2);
  });

  it('should return empty map when both providers fail', async () => {
    (
      kalshiProvider.listActiveContracts as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('Kalshi down'));
    (
      polyProvider.listActiveContracts as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('Polymarket down'));

    const results = await service.syncCatalogs();
    expect(results.size).toBe(0);
  });
});
