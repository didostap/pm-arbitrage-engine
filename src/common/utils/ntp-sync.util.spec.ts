/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { syncAndMeasureDrift } from './ntp-sync.util';
import { NtpTimeSync } from 'ntp-time-sync';

// Mock the ntp-time-sync module
vi.mock('ntp-time-sync', () => {
  const mockGetTime = vi.fn();
  return {
    NtpTimeSync: {
      getInstance: vi.fn(() => ({
        getTime: mockGetTime,
      })),
    },
  };
});

describe('NTP Sync Utility', () => {
  let mockGetTime: Mock;
  let mockGetInstance: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetInstance = NtpTimeSync.getInstance as Mock;
    mockGetTime = vi.fn();
    mockGetInstance.mockReturnValue({
      getTime: mockGetTime,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('syncAndMeasureDrift', () => {
    it('should return drift result with valid data on successful sync', async () => {
      // Arrange
      const mockOffset = -50; // 50ms drift
      mockGetTime.mockResolvedValue({
        now: new Date(),
        offset: mockOffset,
      });

      // Act
      const result = await syncAndMeasureDrift();

      // Assert
      expect(result).toBeDefined();
      expect(result.driftMs).toBe(50); // Math.abs(-50)
      expect(result.serverUsed).toBe('pool.ntp.org');
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should calculate drift as absolute value of offset', async () => {
      // Arrange - positive offset
      mockGetTime.mockResolvedValue({
        now: new Date(),
        offset: 75,
      });

      // Act
      const result = await syncAndMeasureDrift();

      // Assert
      expect(result.driftMs).toBe(75);
    });

    it('should try fallback server when primary fails', async () => {
      // Arrange
      mockGetTime
        .mockRejectedValueOnce(new Error('Timeout')) // 1st attempt - primary fails
        .mockRejectedValueOnce(new Error('Timeout')) // 2nd attempt - primary fails
        .mockRejectedValueOnce(new Error('Timeout')) // 3rd attempt - primary fails
        .mockResolvedValueOnce({
          // 4th attempt - fallback succeeds
          now: new Date(),
          offset: 100,
        });

      // Act
      const promise = syncAndMeasureDrift();
      // Fast-forward through all retry delays (3 retries × 2000ms = 6000ms)
      await vi.advanceTimersByTimeAsync(6000);
      const result = await promise;

      // Assert
      expect(result.driftMs).toBe(100);
      expect(result.serverUsed).toBe('time.google.com');
      expect(mockGetTime).toHaveBeenCalledTimes(4); // 3 primary + 1 fallback
    });

    it('should retry 3 times per server before failing', async () => {
      // Arrange - all attempts fail
      mockGetTime.mockRejectedValue(new Error('Network error'));

      // Act & Assert
      const promise = expect(syncAndMeasureDrift()).rejects.toThrow(
        'NTP sync failed after all retries',
      );
      // Fast-forward through all retry delays (5 retries × 2000ms = 10000ms)
      await vi.advanceTimersByTimeAsync(10000);
      await promise;
      expect(mockGetTime).toHaveBeenCalledTimes(6); // 3 primary + 3 fallback
    });

    it('should succeed on second retry attempt', async () => {
      // Arrange
      mockGetTime
        .mockRejectedValueOnce(new Error('Timeout')) // 1st attempt fails
        .mockResolvedValueOnce({
          // 2nd attempt succeeds
          now: new Date(),
          offset: -25,
        });

      // Act
      const promise = syncAndMeasureDrift();
      // Fast-forward through 1 retry delay (2000ms)
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      // Assert
      expect(result.driftMs).toBe(25);
      expect(result.serverUsed).toBe('pool.ntp.org');
      expect(mockGetTime).toHaveBeenCalledTimes(2);
    });

    it('should handle zero drift correctly', async () => {
      // Arrange
      mockGetTime.mockResolvedValue({
        now: new Date(),
        offset: 0,
      });

      // Act
      const result = await syncAndMeasureDrift();

      // Assert
      expect(result.driftMs).toBe(0);
    });

    it('should create NtpTimeSync instance with correct configuration', async () => {
      // Arrange
      mockGetTime.mockResolvedValue({
        now: new Date(),
        offset: 10,
      });

      // Act
      await syncAndMeasureDrift();

      // Assert
      expect(mockGetInstance).toHaveBeenCalledWith({
        servers: ['pool.ntp.org'],
        replyTimeout: 5000,
      });
    });

    it('should use fallback server configuration after primary fails', async () => {
      // Arrange
      mockGetTime
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValueOnce({
          now: new Date(),
          offset: 50,
        });

      // Act
      const promise = syncAndMeasureDrift();
      // Fast-forward through all retry delays (3 retries × 2000ms = 6000ms)
      await vi.advanceTimersByTimeAsync(6000);
      await promise;

      // Assert
      const calls = mockGetInstance.mock.calls;
      expect(calls[0]?.[0]).toEqual({
        servers: ['pool.ntp.org'],
        replyTimeout: 5000,
      });
      // After primary fails, should try fallback
      expect(calls[calls.length - 1]?.[0]).toEqual({
        servers: ['time.google.com'],
        replyTimeout: 5000,
      });
    });
  });
});
