import { ZodSchema } from 'zod';
import { PlatformApiError } from '../../common/errors/platform-api-error';
import { PlatformId } from '../../common/types/platform.type';

const RAW_DATA_PREVIEW_LIMIT = 1000;

export function parseApiResponse<T>(
  schema: ZodSchema<T>,
  data: unknown,
  context: { platform: PlatformId; operation: string },
): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const rawPreview = JSON.stringify(data);
  throw new PlatformApiError(
    1007,
    `Unexpected API response schema from ${context.platform} (${context.operation})`,
    context.platform,
    'critical',
    undefined,
    {
      operation: context.operation,
      zodErrors: result.error.issues,
      rawData:
        rawPreview.length > RAW_DATA_PREVIEW_LIMIT
          ? rawPreview.slice(0, RAW_DATA_PREVIEW_LIMIT) + '…[truncated]'
          : data,
    },
  );
}
