import { ZodSchema } from 'zod';
import { Logger } from '@nestjs/common';
import { PlatformId } from '../../common/types/platform.type';

const logger = new Logger('WsMessageParser');

export function parseWsMessage<T>(
  schema: ZodSchema<T>,
  data: unknown,
  context: { platform: PlatformId },
): T | null {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  logger.warn(
    `Invalid WebSocket message from ${context.platform}: ${result.error.issues.map((i) => i.message).join(', ')}`,
  );
  return null;
}
