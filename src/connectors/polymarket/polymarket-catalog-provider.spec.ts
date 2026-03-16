import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PolymarketCatalogProvider } from './polymarket-catalog-provider';
import { PlatformId } from '../../common/types/platform.type';
import { PlatformApiError } from '../../common/errors/platform-api-error';
import type { ConfigService } from '@nestjs/config';

function createMockConfig(
  overrides: Record<string, string> = {},
): ConfigService {
  const defaults: Record<string, string> = {
    POLYMARKET_GAMMA_API_URL: 'https://gamma-api.polymarket.com',
    ...overrides,
  };
  return {
    get: vi.fn(
      (key: string, defaultVal?: unknown) => defaults[key] ?? defaultVal,
    ),
  } as unknown as ConfigService;
}

function okResponse(data: unknown) {
  return { ok: true, json: () => Promise.resolve(data) };
}

describe('PolymarketCatalogProvider', () => {
  let provider: PolymarketCatalogProvider;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    provider = new PolymarketCatalogProvider(createMockConfig());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return PlatformId.POLYMARKET', () => {
    expect(provider.getPlatformId()).toBe(PlatformId.POLYMARKET);
  });

  it('should map events with markets to ContractSummary[]', async () => {
    fetchSpy.mockResolvedValueOnce(
      okResponse([
        {
          id: 'event-1',
          title: 'Bitcoin Price',
          tags: [{ label: 'Crypto' }],
          markets: [
            {
              conditionId: 'cond-abc',
              question: 'Will BTC hit $100k?',
              description: 'Resolves Yes if BTC reaches $100,000',
              endDate: '2026-12-31T00:00:00.000Z',
              clobTokenIds: '["clob-token-abc-yes","clob-token-abc-no"]',
            },
          ],
        },
      ]),
    );
    fetchSpy.mockResolvedValueOnce(okResponse([]));

    const result = await provider.listActiveContracts();
    expect(result).toHaveLength(1);

    const contract = result[0]!;
    expect(contract.contractId).toBe('cond-abc');
    expect(contract.title).toBe('Will BTC hit $100k?');
    expect(contract.description).toBe(
      'Will BTC hit $100k?: Resolves Yes if BTC reaches $100,000',
    );
    expect(contract.category).toBe('Crypto');
    expect(contract.settlementDate).toEqual(
      new Date('2026-12-31T00:00:00.000Z'),
    );
    expect(contract.platform).toBe(PlatformId.POLYMARKET);
    expect(contract.clobTokenId).toBe('clob-token-abc-yes');
  });

  it('should map clobTokenId from clobTokenIds[0]', async () => {
    fetchSpy.mockResolvedValueOnce(
      okResponse([
        {
          id: 'event-1',
          title: 'Test Event',
          markets: [
            {
              conditionId: 'cond-xyz',
              question: 'Will X happen?',
              clobTokenIds: '["first-token","second-token"]',
            },
          ],
        },
      ]),
    );
    fetchSpy.mockResolvedValueOnce(okResponse([]));

    const result = await provider.listActiveContracts();
    expect(result[0]!.clobTokenId).toBe('first-token');
  });

  it('should leave clobTokenId undefined when clobTokenIds is missing', async () => {
    fetchSpy.mockResolvedValueOnce(
      okResponse([
        {
          id: 'event-1',
          title: 'Test Event',
          markets: [
            {
              conditionId: 'cond-no-clob',
              question: 'Will Y happen?',
            },
          ],
        },
      ]),
    );
    fetchSpy.mockResolvedValueOnce(okResponse([]));

    const result = await provider.listActiveContracts();
    expect(result[0]!.clobTokenId).toBeUndefined();
  });

  it('should handle offset-based pagination', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: `event-${i}`,
      title: `Event ${i}`,
      markets: [
        {
          conditionId: `cond-${i}`,
          question: `Question ${i}`,
          endDate: '2026-06-01T00:00:00.000Z',
        },
      ],
    }));

    fetchSpy.mockResolvedValueOnce(okResponse(fullPage));
    fetchSpy.mockResolvedValueOnce(
      okResponse([
        {
          id: 'event-100',
          title: 'Event 100',
          markets: [{ conditionId: 'cond-100', question: 'Question 100' }],
        },
      ]),
    );

    const result = await provider.listActiveContracts();
    expect(result).toHaveLength(101);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]![0]).toContain('offset=0');
    expect(fetchSpy.mock.calls[1]![0]).toContain('offset=100');
  });

  it('should handle events with no markets', async () => {
    fetchSpy.mockResolvedValueOnce(
      okResponse([
        { id: 'event-1', title: 'No markets', markets: [] },
        { id: 'event-2', title: 'Null markets' },
      ]),
    );
    fetchSpy.mockResolvedValueOnce(okResponse([]));

    const result = await provider.listActiveContracts();
    expect(result).toHaveLength(0);
  });

  it('should handle missing description and tags', async () => {
    fetchSpy.mockResolvedValueOnce(
      okResponse([
        {
          id: 'event-1',
          title: 'Simple',
          markets: [{ conditionId: 'cond-1', question: 'Will X happen?' }],
        },
      ]),
    );
    fetchSpy.mockResolvedValueOnce(okResponse([]));

    const result = await provider.listActiveContracts();
    const contract = result[0]!;
    expect(contract.description).toBe('Will X happen?');
    expect(contract.category).toBeUndefined();
    expect(contract.settlementDate).toBeUndefined();
  });

  it('should return empty array when no events', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse([]));

    const result = await provider.listActiveContracts();
    expect(result).toHaveLength(0);
  });

  it('should wrap fetch errors in PlatformApiError', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Network error'));

    await expect(provider.listActiveContracts()).rejects.toThrow(
      PlatformApiError,
    );
  });

  it('should wrap non-OK responses in PlatformApiError', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(provider.listActiveContracts()).rejects.toThrow(
      PlatformApiError,
    );
    await expect(provider.listActiveContracts()).rejects.toThrow(
      /Polymarket Gamma API error/,
    );
  });

  describe('outcome parsing', () => {
    it('should parse outcomes into outcomeTokens and set outcomeLabel', async () => {
      fetchSpy.mockResolvedValueOnce(
        okResponse([
          {
            id: 'event-1',
            title: 'UFC Fight',
            markets: [
              {
                conditionId: 'cond-fight',
                question: 'Who will win?',
                outcomes: '["Fighter A wins","Fighter B wins"]',
                clobTokenIds: '["token-a","token-b"]',
              },
            ],
          },
        ]),
      );
      fetchSpy.mockResolvedValueOnce(okResponse([]));

      const result = await provider.listActiveContracts();
      const contract = result[0]!;
      expect(contract.outcomeLabel).toBe('Fighter A wins');
      expect(contract.outcomeTokens).toEqual([
        { tokenId: 'token-a', outcomeLabel: 'Fighter A wins' },
        { tokenId: 'token-b', outcomeLabel: 'Fighter B wins' },
      ]);
    });

    it('should handle missing outcomes field gracefully', async () => {
      fetchSpy.mockResolvedValueOnce(
        okResponse([
          {
            id: 'event-1',
            title: 'Simple Event',
            markets: [
              {
                conditionId: 'cond-1',
                question: 'Will X happen?',
                clobTokenIds: '["token-yes","token-no"]',
              },
            ],
          },
        ]),
      );
      fetchSpy.mockResolvedValueOnce(okResponse([]));

      const result = await provider.listActiveContracts();
      const contract = result[0]!;
      expect(contract.outcomeLabel).toBeUndefined();
      expect(contract.outcomeTokens).toBeUndefined();
    });

    it('should handle malformed JSON in outcomes field', async () => {
      fetchSpy.mockResolvedValueOnce(
        okResponse([
          {
            id: 'event-1',
            title: 'Bad Data',
            markets: [
              {
                conditionId: 'cond-bad',
                question: 'Will Y happen?',
                outcomes: 'not-valid-json',
                clobTokenIds: '["token-1"]',
              },
            ],
          },
        ]),
      );
      fetchSpy.mockResolvedValueOnce(okResponse([]));

      const result = await provider.listActiveContracts();
      const contract = result[0]!;
      expect(contract.outcomeLabel).toBeUndefined();
      expect(contract.outcomeTokens).toBeUndefined();
      expect(contract.clobTokenId).toBe('token-1');
    });

    it('should handle mismatched outcomes/clobTokenIds array lengths', async () => {
      fetchSpy.mockResolvedValueOnce(
        okResponse([
          {
            id: 'event-1',
            title: 'Mismatch',
            markets: [
              {
                conditionId: 'cond-mismatch',
                question: 'Will Z happen?',
                outcomes: '["A","B","C"]',
                clobTokenIds: '["token-1","token-2"]',
              },
            ],
          },
        ]),
      );
      fetchSpy.mockResolvedValueOnce(okResponse([]));

      const result = await provider.listActiveContracts();
      const contract = result[0]!;
      // Should fall back gracefully — no outcomeTokens when lengths mismatch
      expect(contract.outcomeTokens).toBeUndefined();
      expect(contract.outcomeLabel).toBeUndefined();
    });

    it('should handle standard Yes/No outcomes', async () => {
      fetchSpy.mockResolvedValueOnce(
        okResponse([
          {
            id: 'event-1',
            title: 'Binary Event',
            markets: [
              {
                conditionId: 'cond-binary',
                question: 'Will BTC hit $200k?',
                outcomes: '["Yes","No"]',
                clobTokenIds: '["token-yes","token-no"]',
              },
            ],
          },
        ]),
      );
      fetchSpy.mockResolvedValueOnce(okResponse([]));

      const result = await provider.listActiveContracts();
      const contract = result[0]!;
      expect(contract.outcomeLabel).toBe('Yes');
      expect(contract.outcomeTokens).toEqual([
        { tokenId: 'token-yes', outcomeLabel: 'Yes' },
        { tokenId: 'token-no', outcomeLabel: 'No' },
      ]);
    });

    it('should handle empty outcomes array', async () => {
      fetchSpy.mockResolvedValueOnce(
        okResponse([
          {
            id: 'event-1',
            title: 'Empty',
            markets: [
              {
                conditionId: 'cond-empty',
                question: 'Will Q happen?',
                outcomes: '[]',
                clobTokenIds: '["token-1"]',
              },
            ],
          },
        ]),
      );
      fetchSpy.mockResolvedValueOnce(okResponse([]));

      const result = await provider.listActiveContracts();
      const contract = result[0]!;
      expect(contract.outcomeLabel).toBeUndefined();
      expect(contract.outcomeTokens).toBeUndefined();
    });
  });

  describe('getContractResolution', () => {
    it('should return yes when YES token has winner=true', async () => {
      fetchSpy.mockResolvedValueOnce(
        okResponse([
          {
            conditionId: 'cond-abc',
            tokens: [
              { outcome: 'Yes', winner: true },
              { outcome: 'No', winner: false },
            ],
          },
        ]),
      );

      const result = await provider.getContractResolution('cond-abc');
      expect(result).toEqual({ outcome: 'yes', settled: true });
      expect(fetchSpy.mock.calls[0]![0]).toContain('condition_ids=cond-abc');
    });

    it('should return no when NO token has winner=true', async () => {
      fetchSpy.mockResolvedValueOnce(
        okResponse([
          {
            conditionId: 'cond-abc',
            tokens: [
              { outcome: 'Yes', winner: false },
              { outcome: 'No', winner: true },
            ],
          },
        ]),
      );

      const result = await provider.getContractResolution('cond-abc');
      expect(result).toEqual({ outcome: 'no', settled: true });
    });

    it('should return not settled when no winner set', async () => {
      fetchSpy.mockResolvedValueOnce(
        okResponse([
          {
            conditionId: 'cond-abc',
            tokens: [
              { outcome: 'Yes', winner: false },
              { outcome: 'No', winner: false },
            ],
          },
        ]),
      );

      const result = await provider.getContractResolution('cond-abc');
      expect(result).toEqual({ outcome: null, settled: false });
    });

    it('should return null when no markets returned', async () => {
      fetchSpy.mockResolvedValueOnce(okResponse([]));

      const result = await provider.getContractResolution('cond-abc');
      expect(result).toBeNull();
    });

    it('should throw PlatformApiError on non-OK response', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      await expect(provider.getContractResolution('cond-abc')).rejects.toThrow(
        PlatformApiError,
      );
    });

    it('should throw PlatformApiError on fetch error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));

      await expect(provider.getContractResolution('cond-abc')).rejects.toThrow(
        PlatformApiError,
      );
      await expect(provider.getContractResolution('cond-abc')).rejects.toThrow(
        /Polymarket resolution check failed/,
      );
    });

    it('should re-throw PlatformApiError as-is', async () => {
      const apiError = new PlatformApiError(
        1099,
        'Rate limited',
        PlatformId.POLYMARKET,
        'warning',
      );
      fetchSpy.mockRejectedValueOnce(apiError);

      await expect(provider.getContractResolution('cond-abc')).rejects.toBe(
        apiError,
      );
    });
  });
});
