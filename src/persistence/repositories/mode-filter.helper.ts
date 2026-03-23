/**
 * Returns a Prisma where-clause fragment for mode-scoping queries.
 * Convention enforcer and grep target — ensures every repository query
 * that touches mode-sensitive tables includes isPaper filtering.
 *
 * @example
 * prisma.openPosition.findMany({ where: { status: 'OPEN', ...withModeFilter(isPaper) } })
 */
export function withModeFilter(isPaper: boolean): { isPaper: boolean } {
  return { isPaper };
}
