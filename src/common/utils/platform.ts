import { Platform } from '@prisma/client';
import { PlatformId } from '../types/platform.type';

/**
 * Converts PlatformId enum to Prisma Platform enum.
 * Centralizes the uppercase conversion pattern used throughout the codebase.
 *
 * @param platformId - The platform identifier (lowercase: 'kalshi', 'polymarket')
 * @returns Platform enum value (uppercase: 'KALSHI', 'POLYMARKET')
 */
export function toPlatformEnum(platformId: PlatformId): Platform {
  const normalized = platformId.toUpperCase();

  // Validate the conversion produces a valid Platform enum value
  if (!Object.values(Platform).includes(normalized as Platform)) {
    throw new Error(
      `Invalid platform ID: ${platformId}. Must be one of: ${Object.values(Platform).join(', ')}`,
    );
  }

  return normalized as Platform;
}
