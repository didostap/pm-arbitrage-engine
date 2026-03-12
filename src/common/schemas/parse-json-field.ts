import { ZodSchema } from 'zod';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../errors/system-health-error';

export function parseJsonField<T>(
  schema: ZodSchema<T>,
  value: unknown,
  context: { model: string; field: string; recordId?: string },
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw new SystemHealthError(
    SYSTEM_HEALTH_ERROR_CODES.DATA_CORRUPTION_DETECTED,
    `Prisma JSON field validation failed: ${context.model}.${context.field}` +
      (context.recordId ? ` (id: ${context.recordId})` : ''),
    'critical',
    `${context.model}.${context.field}`,
    undefined,
    {
      model: context.model,
      field: context.field,
      recordId: context.recordId,
      zodErrors: result.error.issues,
    },
  );
}
