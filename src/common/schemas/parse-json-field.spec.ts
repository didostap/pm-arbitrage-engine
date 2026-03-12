import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseJsonField } from './parse-json-field';
import { SystemHealthError } from '../errors/system-health-error';

const testSchema = z.object({ name: z.string(), value: z.number() });

describe('parseJsonField', () => {
  it('should return parsed value on valid input', () => {
    const result = parseJsonField(
      testSchema,
      { name: 'test', value: 42 },
      {
        model: 'TestModel',
        field: 'data',
      },
    );
    expect(result).toEqual({ name: 'test', value: 42 });
  });

  it('should throw SystemHealthError with code 4500 on invalid input', () => {
    expect(() =>
      parseJsonField(
        testSchema,
        { name: 123 },
        {
          model: 'TestModel',
          field: 'data',
          recordId: 'rec-1',
        },
      ),
    ).toThrow(SystemHealthError);

    try {
      parseJsonField(
        testSchema,
        { name: 123 },
        {
          model: 'TestModel',
          field: 'data',
          recordId: 'rec-1',
        },
      );
    } catch (error) {
      const sysErr = error as SystemHealthError;
      expect(sysErr.code).toBe(4500);
      expect(sysErr.severity).toBe('critical');
      expect(sysErr.message).toContain('TestModel.data');
      expect(sysErr.message).toContain('rec-1');
      expect(sysErr.metadata).toHaveProperty('zodErrors');
    }
  });

  it('should include model and field in error message without recordId', () => {
    try {
      parseJsonField(testSchema, null, {
        model: 'OpenPosition',
        field: 'entryPrices',
      });
    } catch (error) {
      const sysErr = error as SystemHealthError;
      expect(sysErr.message).toContain('OpenPosition.entryPrices');
      expect(sysErr.message).not.toContain('id:');
    }
  });
});
