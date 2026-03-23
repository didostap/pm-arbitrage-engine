/**
 * Story 10-5.5 — Paper/Live Mode Boundary: withModeFilter() helper
 *
 * TRUE RED PHASE: The helper does not exist yet.
 * Target path: src/persistence/repositories/mode-filter.helper.ts
 *
 * Tests verify the contract for a Prisma where-clause fragment builder
 * that ensures every repository query is mode-scoped.
 *
 * TDD RED PHASE — all tests skip.
 */
import { describe, it, expect } from 'vitest';

// This import will FAIL until the helper is created — true red phase
import { withModeFilter } from '../../../persistence/repositories/mode-filter.helper';

describe('Paper/Live Boundary — withModeFilter() helper', () => {
  it('[P0] withModeFilter(true) returns { isPaper: true }', () => {
    const filter = withModeFilter(true);

    expect(filter).toEqual({ isPaper: true });
    expect(filter).toHaveProperty('isPaper', true);
    // Must not contain any other keys
    expect(Object.keys(filter)).toEqual(['isPaper']);
  });

  it('[P0] withModeFilter(false) returns { isPaper: false }', () => {
    const filter = withModeFilter(false);

    expect(filter).toEqual({ isPaper: false });
    expect(filter).toHaveProperty('isPaper', false);
    // Must not contain any other keys
    expect(Object.keys(filter)).toEqual(['isPaper']);
  });

  it('[P0] return value is suitable as Prisma where clause fragment', () => {
    // The return type should be a plain object with a single boolean isPaper field,
    // compatible with Prisma's WhereInput pattern for any model with an isPaper column.
    const paperFilter = withModeFilter(true);
    const liveFilter = withModeFilter(false);

    // Verify structural compatibility: can spread into a where clause
    const mockWhereClause = {
      status: 'OPEN',
      ...paperFilter,
    };
    expect(mockWhereClause).toEqual({ status: 'OPEN', isPaper: true });

    const mockWhereClause2 = {
      status: { in: ['OPEN', 'EXIT_PARTIAL'] },
      ...liveFilter,
    };
    expect(mockWhereClause2).toEqual({
      status: { in: ['OPEN', 'EXIT_PARTIAL'] },
      isPaper: false,
    });

    // Verify the isPaper value is a strict boolean (not truthy/falsy string)
    expect(typeof paperFilter.isPaper).toBe('boolean');
    expect(typeof liveFilter.isPaper).toBe('boolean');
    expect(paperFilter.isPaper).toStrictEqual(true);
    expect(liveFilter.isPaper).toStrictEqual(false);
  });
});
