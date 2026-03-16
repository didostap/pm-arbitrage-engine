import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { KalshiCatalogProvider } from './kalshi-catalog-provider';
import { PlatformId } from '../../common/types/platform.type';
import { PlatformApiError } from '../../common/errors/platform-api-error';
import type { ConfigService } from '@nestjs/config';

// Mock kalshi-typescript SDK
const { mockGetEvents, mockGetMarket } = vi.hoisted(() => ({
  mockGetEvents: vi.fn(),
  mockGetMarket: vi.fn(),
}));
vi.mock('kalshi-typescript', () => {
  const MockEventsApi = vi.fn() as {
    new (): unknown;
    prototype: Record<string, unknown>;
  };
  MockEventsApi.prototype['getEvents'] = mockGetEvents;
  const MockMarketApi = vi.fn() as {
    new (): unknown;
    prototype: Record<string, unknown>;
  };
  MockMarketApi.prototype['getMarket'] = mockGetMarket;
  const MockConfiguration = vi.fn();
  return {
    EventsApi: MockEventsApi,
    MarketApi: MockMarketApi,
    Configuration: MockConfiguration,
  };
});

function createMockConfig(
  overrides: Record<string, string> = {},
): ConfigService {
  const defaults: Record<string, string> = {
    KALSHI_API_KEY_ID: 'test-key',
    KALSHI_PRIVATE_KEY_PATH: '',
    KALSHI_API_BASE_URL: 'https://demo-api.kalshi.co/trade-api/v2',
    ...overrides,
  };
  return {
    get: vi.fn(
      (key: string, defaultVal?: unknown) => defaults[key] ?? defaultVal,
    ),
  } as unknown as ConfigService;
}

describe('KalshiCatalogProvider', () => {
  let provider: KalshiCatalogProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    const config = createMockConfig();
    provider = new KalshiCatalogProvider(config);
  });

  it('should return PlatformId.KALSHI', () => {
    expect(provider.getPlatformId()).toBe(PlatformId.KALSHI);
  });

  it('should use event.title as title and include market detail in description', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: {
        events: [
          {
            event_ticker: 'EVT-1',
            title: 'Will Bitcoin hit $100k?',
            series_ticker: 'CRYPTO',
            category: 'Crypto',
            markets: [
              {
                ticker: 'BTC-100K-YES',
                event_ticker: 'EVT-1',
                title: '',
                subtitle: '',
                yes_sub_title: 'Before Jan 1, 2026',
                status: 'open',
                close_time: '2026-12-31T00:00:00Z',
              },
            ],
          },
        ],
        cursor: '',
      },
    });

    const result = await provider.listActiveContracts();
    expect(result).toHaveLength(1);

    const contract = result[0]!;
    expect(contract.contractId).toBe('BTC-100K-YES');
    expect(contract.title).toBe('Will Bitcoin hit $100k?'); // event title
    expect(contract.description).toBe(
      'Will Bitcoin hit $100k?\nBefore Jan 1, 2026', // event title + market detail
    );
    expect(contract.category).toBe('Crypto');
    expect(contract.settlementDate).toEqual(new Date('2026-12-31T00:00:00Z'));
    expect(contract.platform).toBe(PlatformId.KALSHI);
  });

  it('should use subtitle as market detail when yes_sub_title is absent', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: {
        events: [
          {
            event_ticker: 'EVT-2',
            title: 'Election 2028',
            markets: [
              {
                ticker: 'ELECT-2028',
                event_ticker: 'EVT-2',
                title: '',
                subtitle: 'Democrat wins',
                status: 'open',
              },
            ],
          },
        ],
        cursor: '',
      },
    });

    const result = await provider.listActiveContracts();
    const contract = result[0]!;
    expect(contract.title).toBe('Election 2028');
    expect(contract.description).toBe('Election 2028\nDemocrat wins');
  });

  it('should use only event title when all market fields are empty', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: {
        events: [
          {
            event_ticker: 'EVT-3',
            title: 'Simple Event Question',
            markets: [
              {
                ticker: 'SIMPLE-1',
                event_ticker: 'EVT-3',
                title: '',
                subtitle: '',
                yes_sub_title: '',
                status: 'open',
              },
            ],
          },
        ],
        cursor: '',
      },
    });

    const result = await provider.listActiveContracts();
    const contract = result[0]!;
    expect(contract.title).toBe('Simple Event Question');
    expect(contract.description).toBe('Simple Event Question'); // no market detail
  });

  it('should include rules_primary in description when available', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: {
        events: [
          {
            event_ticker: 'EVT-5',
            title: 'Keir Starmer Out?',
            markets: [
              {
                ticker: 'KSTARMER-OUT',
                event_ticker: 'EVT-5',
                title: '',
                yes_sub_title: 'Before Jul 1, 2026',
                status: 'open',
                rules_primary:
                  'This market resolves Yes if Keir Starmer ceases to be PM before July 1, 2026.',
              },
            ],
          },
        ],
        cursor: '',
      },
    });

    const result = await provider.listActiveContracts();
    const contract = result[0]!;
    expect(contract.title).toBe('Keir Starmer Out?');
    expect(contract.description).toBe(
      'Keir Starmer Out?\nBefore Jul 1, 2026\nThis market resolves Yes if Keir Starmer ceases to be PM before July 1, 2026.',
    );
  });

  it('should prefer category over series_ticker', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: {
        events: [
          {
            event_ticker: 'EVT-4',
            title: 'Some Event',
            series_ticker: '',
            category: 'Politics',
            markets: [
              {
                ticker: 'POL-1',
                event_ticker: 'EVT-4',
                title: 'Market question',
                status: 'open',
              },
            ],
          },
        ],
        cursor: '',
      },
    });

    const result = await provider.listActiveContracts();
    expect(result[0]!.category).toBe('Politics');
  });

  it('should handle cursor-based pagination across multiple pages', async () => {
    mockGetEvents
      .mockResolvedValueOnce({
        data: {
          events: [
            {
              event_ticker: 'E1',
              title: 'Event 1',
              markets: [
                {
                  ticker: 'M1',
                  event_ticker: 'E1',
                  title: 'Market 1',
                  status: 'open',
                },
              ],
            },
          ],
          cursor: 'page2-cursor',
        },
      })
      .mockResolvedValueOnce({
        data: {
          events: [
            {
              event_ticker: 'E2',
              title: 'Event 2',
              markets: [
                {
                  ticker: 'M2',
                  event_ticker: 'E2',
                  title: 'Market 2',
                  status: 'open',
                },
              ],
            },
          ],
          cursor: '',
        },
      });

    const result = await provider.listActiveContracts();
    expect(result).toHaveLength(2);
    expect(result[0]!.contractId).toBe('M1');
    expect(result[1]!.contractId).toBe('M2');
    expect(mockGetEvents).toHaveBeenCalledTimes(2);
  });

  it('should skip events with no markets', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: {
        events: [
          { event_ticker: 'E1', title: 'No markets', markets: [] },
          { event_ticker: 'E2', title: 'No markets field' },
        ],
        cursor: '',
      },
    });

    const result = await provider.listActiveContracts();
    expect(result).toHaveLength(0);
  });

  it('should return empty array when no events', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: { events: [], cursor: '' },
    });

    const result = await provider.listActiveContracts();
    expect(result).toHaveLength(0);
  });

  it('should wrap API errors in PlatformApiError', async () => {
    mockGetEvents.mockRejectedValueOnce(new Error('Network timeout'));

    await expect(provider.listActiveContracts()).rejects.toThrow(
      PlatformApiError,
    );
    await expect(provider.listActiveContracts()).rejects.toThrow(
      /Kalshi catalog fetch failed/,
    );
  });

  describe('outcomeLabel extraction', () => {
    it('should set outcomeLabel from yes_sub_title', async () => {
      mockGetEvents.mockResolvedValueOnce({
        data: {
          events: [
            {
              event_ticker: 'UFC-1',
              title: 'UFC Fight Night',
              markets: [
                {
                  ticker: 'FIGHTER-A',
                  event_ticker: 'UFC-1',
                  title: '',
                  yes_sub_title: 'Sam Patterson wins',
                  status: 'open',
                },
              ],
            },
          ],
          cursor: '',
        },
      });

      const result = await provider.listActiveContracts();
      expect(result[0]!.outcomeLabel).toBe('Sam Patterson wins');
    });

    it('should leave outcomeLabel undefined when yes_sub_title is absent', async () => {
      mockGetEvents.mockResolvedValueOnce({
        data: {
          events: [
            {
              event_ticker: 'EVT-NO-YST',
              title: 'Some Event',
              markets: [
                {
                  ticker: 'MKT-1',
                  event_ticker: 'EVT-NO-YST',
                  title: '',
                  status: 'open',
                },
              ],
            },
          ],
          cursor: '',
        },
      });

      const result = await provider.listActiveContracts();
      expect(result[0]!.outcomeLabel).toBeUndefined();
    });

    it('should treat empty string yes_sub_title as absent', async () => {
      mockGetEvents.mockResolvedValueOnce({
        data: {
          events: [
            {
              event_ticker: 'EVT-EMPTY',
              title: 'Empty YST',
              markets: [
                {
                  ticker: 'MKT-EMPTY',
                  event_ticker: 'EVT-EMPTY',
                  title: '',
                  yes_sub_title: '',
                  status: 'open',
                },
              ],
            },
          ],
          cursor: '',
        },
      });

      const result = await provider.listActiveContracts();
      expect(result[0]!.outcomeLabel).toBeUndefined();
    });
  });

  describe('settlementDate fallback chain', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    });

    function mockMarket(overrides: Record<string, unknown> = {}) {
      mockGetEvents.mockResolvedValueOnce({
        data: {
          events: [
            {
              event_ticker: 'EVT-D',
              title: 'Date Test',
              markets: [
                {
                  ticker: 'DATE-MKT',
                  event_ticker: 'EVT-D',
                  title: '',
                  status: 'open',
                  ...overrides,
                },
              ],
            },
          ],
          cursor: '',
        },
      });
    }

    it('should use expected_expiration_time when present', async () => {
      mockMarket({
        expected_expiration_time: '2026-06-15T00:00:00Z',
        expiration_time: '2026-07-01T00:00:00Z',
        close_time: '2026-06-30T00:00:00Z',
      });

      const result = await provider.listActiveContracts();
      expect(result[0]!.settlementDate).toEqual(
        new Date('2026-06-15T00:00:00Z'),
      );
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should use expiration_time when expected_expiration_time is absent', async () => {
      mockMarket({
        expiration_time: '2026-07-01T00:00:00Z',
        close_time: '2026-06-30T00:00:00Z',
      });

      const result = await provider.listActiveContracts();
      expect(result[0]!.settlementDate).toEqual(
        new Date('2026-07-01T00:00:00Z'),
      );
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should use close_time as last resort and emit warning', async () => {
      mockMarket({ close_time: '2026-06-30T00:00:00Z' });

      const result = await provider.listActiveContracts();
      expect(result[0]!.settlementDate).toEqual(
        new Date('2026-06-30T00:00:00Z'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            'Kalshi market missing expected_expiration_time and expiration_time',
          data: { ticker: 'DATE-MKT', fallback: 'close_time' },
        }),
      );
    });

    it('should emit warning when both expected_expiration_time and expiration_time absent without close_time', async () => {
      mockMarket({});

      const result = await provider.listActiveContracts();
      expect(result[0]!.settlementDate).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { ticker: 'DATE-MKT', fallback: 'none' },
        }),
      );
    });

    it('should treat empty string expiration_time as absent (fall through to close_time)', async () => {
      mockMarket({
        expected_expiration_time: '',
        expiration_time: '',
        close_time: '2026-06-30T00:00:00Z',
      });

      const result = await provider.listActiveContracts();
      expect(result[0]!.settlementDate).toEqual(
        new Date('2026-06-30T00:00:00Z'),
      );
      expect(warnSpy).toHaveBeenCalled();
    });

    it('should return undefined settlementDate for malformed date string and log warning', async () => {
      mockMarket({
        expected_expiration_time: 'not-a-date',
        expiration_time: 'also-bad',
      });

      const result = await provider.listActiveContracts();
      expect(result[0]!.settlementDate).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Kalshi market has invalid date format',
          data: { ticker: 'DATE-MKT', rawDate: 'not-a-date' },
        }),
      );
    });

    it('should return undefined settlementDate when all three fields are absent', async () => {
      mockMarket({});

      const result = await provider.listActiveContracts();
      expect(result[0]!.settlementDate).toBeUndefined();
    });
  });

  describe('getContractResolution', () => {
    it('should return yes outcome when market is settled with result yes', async () => {
      mockGetMarket.mockResolvedValueOnce({
        data: {
          market: { ticker: 'BTC-100K', status: 'settled', result: 'yes' },
        },
      });

      const result = await provider.getContractResolution('BTC-100K');
      expect(result).toEqual({
        outcome: 'yes',
        settled: true,
        rawStatus: 'settled',
      });
    });

    it('should return no outcome when market is settled with result no', async () => {
      mockGetMarket.mockResolvedValueOnce({
        data: {
          market: { ticker: 'BTC-100K', status: 'settled', result: 'no' },
        },
      });

      const result = await provider.getContractResolution('BTC-100K');
      expect(result).toEqual({
        outcome: 'no',
        settled: true,
        rawStatus: 'settled',
      });
    });

    it('should handle case-insensitive result field', async () => {
      mockGetMarket.mockResolvedValueOnce({
        data: {
          market: { ticker: 'BTC-100K', status: 'settled', result: 'Yes' },
        },
      });

      const result = await provider.getContractResolution('BTC-100K');
      expect(result).toEqual({
        outcome: 'yes',
        settled: true,
        rawStatus: 'settled',
      });
    });

    it('should return invalid when settled with unexpected result', async () => {
      mockGetMarket.mockResolvedValueOnce({
        data: {
          market: { ticker: 'BTC-100K', status: 'settled', result: 'void' },
        },
      });

      const result = await provider.getContractResolution('BTC-100K');
      expect(result).toEqual({
        outcome: 'invalid',
        settled: true,
        rawStatus: 'settled',
      });
    });

    it('should return null outcome when market is not settled (open)', async () => {
      mockGetMarket.mockResolvedValueOnce({
        data: { market: { ticker: 'BTC-100K', status: 'open' } },
      });

      const result = await provider.getContractResolution('BTC-100K');
      expect(result).toEqual({
        outcome: null,
        settled: false,
        rawStatus: 'open',
      });
    });

    it('should return null outcome when market is closed but not settled', async () => {
      mockGetMarket.mockResolvedValueOnce({
        data: { market: { ticker: 'BTC-100K', status: 'closed' } },
      });

      const result = await provider.getContractResolution('BTC-100K');
      expect(result).toEqual({
        outcome: null,
        settled: false,
        rawStatus: 'closed',
      });
    });

    it('should throw PlatformApiError on API failure', async () => {
      mockGetMarket.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(provider.getContractResolution('BTC-100K')).rejects.toThrow(
        PlatformApiError,
      );
      await expect(provider.getContractResolution('BTC-100K')).rejects.toThrow(
        /Kalshi resolution check failed/,
      );
    });

    it('should re-throw PlatformApiError as-is', async () => {
      const apiError = new PlatformApiError(
        1099,
        'Rate limited',
        PlatformId.KALSHI,
        'warning',
      );
      mockGetMarket.mockRejectedValueOnce(apiError);

      await expect(provider.getContractResolution('BTC-100K')).rejects.toBe(
        apiError,
      );
    });
  });
});
