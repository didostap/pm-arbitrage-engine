import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExternalPairEnrichmentService } from './external-pair-enrichment.service';
import { PlatformId } from '../../common/types/platform.type';
import type { ContractSummary } from '../../common/interfaces/contract-catalog-provider.interface';
import type { ExternalMatchedPair } from '../../common/types';

function makePair(
  overrides: Partial<ExternalMatchedPair> = {},
): ExternalMatchedPair {
  return {
    polymarketId: null,
    kalshiId: null,
    polymarketTitle: 'Will Bitcoin exceed $100k?',
    kalshiTitle: 'Bitcoin above $100,000',
    source: 'oddspipe',
    similarity: null,
    spreadData: null,
    ...overrides,
  };
}

function makeContract(
  platform: PlatformId,
  overrides: Partial<ContractSummary> = {},
): ContractSummary {
  return {
    contractId:
      platform === PlatformId.POLYMARKET ? '0xabc123' : 'KXBTC-24DEC31',
    title:
      platform === PlatformId.POLYMARKET
        ? 'Will Bitcoin exceed $100k?'
        : 'Bitcoin above $100,000',
    description:
      platform === PlatformId.POLYMARKET
        ? 'Will Bitcoin exceed $100k by end of year?'
        : 'Bitcoin above $100,000 by December',
    platform,
    settlementDate: new Date('2026-12-31'),
    category: 'Crypto',
    ...(platform === PlatformId.POLYMARKET
      ? { clobTokenId: 'clob-token-1', outcomeLabel: 'Yes' }
      : { outcomeLabel: 'Yes' }),
    ...overrides,
  };
}

describe('ExternalPairEnrichmentService', () => {
  let service: ExternalPairEnrichmentService;
  let catalogSync: { syncCatalogs: ReturnType<typeof vi.fn> };
  let configService: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    catalogSync = {
      syncCatalogs: vi.fn().mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, [makeContract(PlatformId.POLYMARKET)]],
          [PlatformId.KALSHI, [makeContract(PlatformId.KALSHI)]],
        ]),
      ),
    };

    configService = {
      get: vi.fn().mockImplementation((key: string, defaultValue?: unknown) => {
        if (key === 'EXTERNAL_PAIR_CATALOG_MATCH_THRESHOLD') return 0.5;
        return defaultValue;
      }),
    };

    service = new ExternalPairEnrichmentService(
      catalogSync as any,
      configService as any,
    );
  });

  it('[P0] pair with null IDs + matching catalog entries should have IDs and metadata populated', async () => {
    const pairs = [makePair()];

    const result = await service.enrichPairs(pairs);

    expect(result[0]!.polymarketId).toBe('0xabc123');
    expect(result[0]!.kalshiId).toBe('KXBTC-24DEC31');
    expect(result[0]!.settlementDate).toEqual(new Date('2026-12-31'));
    expect(result[0]!.category).toBe('Crypto');
    expect(result[0]!.polymarketClobTokenId).toBe('clob-token-1');
    expect(result[0]!.polymarketOutcomeLabel).toBe('Yes');
    expect(result[0]!.kalshiOutcomeLabel).toBe('Yes');
  });

  it('[P0] pair with null IDs + no catalog match should remain with null IDs', async () => {
    const pairs = [
      makePair({
        polymarketTitle: 'Completely unrelated event XYZ',
        kalshiTitle: 'Totally different topic ABC',
      }),
    ];

    const result = await service.enrichPairs(pairs);

    expect(result[0]!.polymarketId).toBeNull();
    expect(result[0]!.kalshiId).toBeNull();
  });

  it('[P0] pair with existing IDs AND clobTokenId should pass through unchanged', async () => {
    const pairs = [
      makePair({
        polymarketId: '0xexisting',
        kalshiId: 'KXEXIST',
        polymarketClobTokenId: 'clob-existing',
        source: 'predexon',
      }),
    ];

    const result = await service.enrichPairs(pairs);

    expect(result[0]!.polymarketId).toBe('0xexisting');
    expect(result[0]!.kalshiId).toBe('KXEXIST');
    expect(result[0]!.polymarketClobTokenId).toBe('clob-existing');
    expect(catalogSync.syncCatalogs).not.toHaveBeenCalled();
  });

  it('[P0] Predexon pair with IDs but no clobTokenId should resolve clobTokenId from catalog', async () => {
    catalogSync.syncCatalogs.mockResolvedValue(
      new Map([
        [
          PlatformId.POLYMARKET,
          [
            makeContract(PlatformId.POLYMARKET, {
              contractId: '0xabc123',
              clobTokenId: 'resolved-clob-token',
              outcomeLabel: 'Yes',
              settlementDate: new Date('2026-12-31'),
              category: 'Crypto',
            }),
          ],
        ],
        [
          PlatformId.KALSHI,
          [makeContract(PlatformId.KALSHI, { contractId: 'KXBTC-24DEC31' })],
        ],
      ]),
    );

    const pairs = [
      makePair({
        polymarketId: '0xabc123',
        kalshiId: 'KXBTC-24DEC31',
        source: 'predexon',
      }),
    ];

    const result = await service.enrichPairs(pairs);

    expect(result[0]!.polymarketClobTokenId).toBe('resolved-clob-token');
    expect(result[0]!.polymarketOutcomeLabel).toBe('Yes');
    expect(result[0]!.category).toBe('Crypto');
    expect(catalogSync.syncCatalogs).toHaveBeenCalledOnce();
  });

  it('[P0] Predexon pair with IDs, catalog match found but clobTokenId is null, should pass through unchanged', async () => {
    catalogSync.syncCatalogs.mockResolvedValue(
      new Map([
        [
          PlatformId.POLYMARKET,
          [
            makeContract(PlatformId.POLYMARKET, {
              contractId: '0xabc123',
              clobTokenId: undefined,
              outcomeLabel: 'Yes',
            }),
          ],
        ],
        [PlatformId.KALSHI, [makeContract(PlatformId.KALSHI)]],
      ]),
    );

    const pairs = [
      makePair({
        polymarketId: '0xabc123',
        kalshiId: 'KXBTC-24DEC31',
        source: 'predexon',
      }),
    ];

    const result = await service.enrichPairs(pairs);

    expect(result[0]!.polymarketClobTokenId).toBeUndefined();
    expect(result[0]!.polymarketId).toBe('0xabc123');
  });

  it('[P0] Predexon pair with IDs but no catalog match should pass through with null clobTokenId', async () => {
    catalogSync.syncCatalogs.mockResolvedValue(
      new Map([
        [
          PlatformId.POLYMARKET,
          [makeContract(PlatformId.POLYMARKET, { contractId: '0xdifferent' })],
        ],
        [PlatformId.KALSHI, [makeContract(PlatformId.KALSHI)]],
      ]),
    );

    const pairs = [
      makePair({
        polymarketId: '0xnotincatalog',
        kalshiId: 'KXNOTFOUND',
        source: 'predexon',
      }),
    ];

    const result = await service.enrichPairs(pairs);

    expect(result[0]!.polymarketClobTokenId).toBeUndefined();
  });

  it('[P1] when multiple catalog entries match, should select highest similarity', async () => {
    catalogSync.syncCatalogs.mockResolvedValue(
      new Map([
        [
          PlatformId.POLYMARKET,
          [
            makeContract(PlatformId.POLYMARKET, {
              contractId: '0xweak',
              title: 'Something vaguely related',
            }),
            makeContract(PlatformId.POLYMARKET, {
              contractId: '0xbest',
              title: 'Will Bitcoin exceed $100k?',
            }),
          ],
        ],
        [PlatformId.KALSHI, [makeContract(PlatformId.KALSHI)]],
      ]),
    );

    const result = await service.enrichPairs([makePair()]);

    expect(result[0]!.polymarketId).toBe('0xbest');
  });

  it('[P1] below-threshold matches should be ignored', async () => {
    catalogSync.syncCatalogs.mockResolvedValue(
      new Map([
        [
          PlatformId.POLYMARKET,
          [
            makeContract(PlatformId.POLYMARKET, {
              title: 'Completely different market about weather',
              description: 'Will it rain tomorrow in New York City?',
            }),
          ],
        ],
        [PlatformId.KALSHI, [makeContract(PlatformId.KALSHI)]],
      ]),
    );

    const result = await service.enrichPairs([makePair()]);

    // Polymarket match too weak → pair stays unresolvable
    expect(result[0]!.polymarketId).toBeNull();
  });

  it('[P2] empty catalog should leave all pairs unresolvable without crash', async () => {
    catalogSync.syncCatalogs.mockResolvedValue(new Map());

    const result = await service.enrichPairs([makePair()]);

    expect(result).toHaveLength(1);
    expect(result[0]!.polymarketId).toBeNull();
  });

  it('[P2] CatalogSyncService throws should return pairs unchanged', async () => {
    catalogSync.syncCatalogs.mockRejectedValue(new Error('API failure'));

    const result = await service.enrichPairs([makePair()]);

    expect(result).toHaveLength(1);
    expect(result[0]!.polymarketId).toBeNull();
    expect(result[0]!.kalshiId).toBeNull();
  });
});
