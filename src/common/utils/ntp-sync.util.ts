import { NtpTimeSync } from 'ntp-time-sync';
import { DriftResult } from '../types/ntp.type';
import { Logger } from '@nestjs/common';
import { getCorrelationId } from '../services/correlation-context';

const logger = new Logger('NtpSync');

const PRIMARY_SERVER = 'pool.ntp.org';
const FALLBACK_SERVER = 'time.google.com';
const TIMEOUT_MS = 5000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Helper function to delay execution
 */
const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Fetch NTP time with retry logic
 */
async function fetchWithRetry(server: string): Promise<DriftResult | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const timeSync = NtpTimeSync.getInstance({
        servers: [server],
        replyTimeout: TIMEOUT_MS,
      });

      const result = await timeSync.getTime();
      const driftMs = Math.abs(result.offset);

      logger.log({
        message: 'NTP sync successful',
        correlationId: getCorrelationId(),
        data: { driftMs, serverUsed: server, attempt },
      });

      return {
        driftMs,
        serverUsed: server,
        timestamp: new Date(),
      };
    } catch (error) {
      logger.warn({
        message: 'NTP sync attempt failed',
        correlationId: getCorrelationId(),
        data: {
          server,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        },
      });

      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }
  return null;
}

/**
 * Synchronizes with NTP servers and measures clock drift
 *
 * Attempts to sync with primary NTP server (pool.ntp.org) first,
 * then falls back to secondary server (time.google.com) if primary fails.
 *
 * Retries each server up to 3 times with 2-second delay between attempts.
 *
 * @returns Promise<DriftResult> containing drift measurement and server info
 * @throws Error if all sync attempts fail
 */
export async function syncAndMeasureDrift(): Promise<DriftResult> {
  // Try primary server
  const result = await fetchWithRetry(PRIMARY_SERVER);
  if (result) {
    return result;
  }

  // Fallback to Google
  logger.warn({
    message: 'Primary NTP server failed, trying fallback',
    correlationId: getCorrelationId(),
  });
  const fallbackResult = await fetchWithRetry(FALLBACK_SERVER);
  if (fallbackResult) {
    return fallbackResult;
  }

  // All servers failed
  throw new Error('NTP sync failed after all retries');
}
