# Persistence Coverage Audit

**Date:** 2026-02-22 (Story 5.5.0, Task 7)
**Note:** Persistence coverage numbers below are unaffected by the cancelOrder and mock factory tests added in this story (those tests don't touch persistence repos). Total suite test count grew from 731 → 760 after code review fixes.

## Summary

| Metric | Statements | Branches | Functions | Lines |
|--------|-----------|----------|-----------|-------|
| **persistence/repositories (aggregate)** | 52.17% | 0% | 66.66% | 57.14% |
| order.repository.ts | 50% | 0% | 85.71% | 60% |
| position.repository.ts | 54.54% | 100% | 54.54% | 54.54% |

The persistence repositories have the lowest coverage in the codebase. Both spec files test 4 methods each (create, findById, findByStatus/findByPairId, updateStatus), leaving several methods and all branch logic untested.

## Repository Analysis

### order.repository.ts

| Method | Tested | Classification | Notes |
|--------|--------|---------------|-------|
| `create(data)` | Yes | Prisma pass-through | Simple `prisma.order.create({ data })` delegation |
| `findById(orderId)` | Yes | Prisma pass-through | Simple `findUnique` delegation |
| `findByPairId(pairId)` | Yes | Prisma pass-through | Simple `findMany` delegation |
| `updateStatus(orderId, status)` | Yes | Prisma pass-through | Simple `update` delegation |
| `findPendingOrders()` | **No** | Prisma pass-through | Simple `findMany` with hardcoded `status: 'PENDING'` filter |
| `updateOrderStatus(orderId, status, fillPrice?, fillSize?)` | **No** | **Business logic** | Conditionally includes `fillPrice`/`fillSize` in update payload based on `undefined` checks (lines 45-48). Has branch logic that is not covered (0% branch coverage). |

**Uncovered lines:** 45-48 (the conditional `fillPrice`/`fillSize` assignment in `updateOrderStatus`)

### position.repository.ts

| Method | Tested | Classification | Notes |
|--------|--------|---------------|-------|
| `create(data)` | Yes | Prisma pass-through | Simple `openPosition.create({ data })` delegation |
| `findById(positionId)` | Yes | Prisma pass-through | Simple `findUnique` delegation |
| `findByPairId(pairId)` | **No** | Prisma pass-through | Simple `findMany` delegation (line 18) |
| `findByStatus(status)` | Yes | Prisma pass-through | Simple `findMany` delegation |
| `findByStatusWithPair(status)` | **No** | Prisma pass-through | `findMany` with `include: { pair: true }` (lines 27-31) |
| `findByStatusWithOrders(status)` | **No** | Prisma pass-through | `findMany` with `include: { pair, kalshiOrder, polymarketOrder }` (lines 37-44). Used by exit monitor for P&L calculation. |
| `updateStatus(positionId, status)` | Yes | Prisma pass-through | Simple `update` delegation |
| `findByIdWithPair(positionId)` | **No** | Prisma pass-through | `findUnique` with `include: { pair: true }` (line 58) |
| `findActivePositions()` | **No** | Prisma pass-through (with domain knowledge) | `findMany` with hardcoded status list (`OPEN`, `SINGLE_LEG_EXPOSED`, `EXIT_PARTIAL`, `RECONCILIATION_REQUIRED`) and triple include. The status list encodes domain logic about what "active" means. (lines 68-82) |
| `updateWithOrder(positionId, data)` | **No** | Prisma pass-through | Generic `update` delegation (line 88) |

**Uncovered lines:** 18, 27-40, 58, 88

## Business Logic Gaps (Action Required)

1. **`OrderRepository.updateOrderStatus()` branch logic** (Priority: Medium)
   - The method conditionally includes `fillPrice` and `fillSize` in the update payload. This is the only true branching logic in either repository, and it has 0% branch coverage.
   - Tests needed:
     - Call with only `status` (no fill data)
     - Call with `status` + `fillPrice` only
     - Call with `status` + `fillSize` only
     - Call with all parameters
   - **Recommended:** Add to next stabilization sprint or as part of execution module hardening.

2. **`PositionRepository.findActivePositions()` domain encoding** (Priority: Low-Medium)
   - The hardcoded status list (`OPEN`, `SINGLE_LEG_EXPOSED`, `EXIT_PARTIAL`, `RECONCILIATION_REQUIRED`) encodes business rules about what constitutes an "active" position. If this list drifts from the domain model, reconciliation will silently miss positions.
   - A test asserting the exact status list would serve as a guard against accidental omission when new statuses are added.
   - **Recommended:** Add coverage when position lifecycle evolves (e.g., new statuses in future epics).

## Prisma Pass-Through Methods (Low Risk)

These methods are simple delegations to Prisma with no conditional logic. Coverage is nice-to-have but low priority:

### order.repository.ts
- `findPendingOrders()` — hardcoded filter, no branching

### position.repository.ts
- `findByPairId(pairId)` — simple `findMany`
- `findByStatusWithPair(status)` — `findMany` + `include`
- `findByStatusWithOrders(status)` — `findMany` + triple `include`
- `findByIdWithPair(positionId)` — `findUnique` + `include`
- `updateWithOrder(positionId, data)` — generic `update` delegation

## Recommendations

1. **Immediate (this sprint):** No action required. The 0% branch coverage is explained by a single method with conditional fill data logic. The risk is low because the method is straightforward.

2. **Next sprint:** Add tests for `updateOrderStatus()` covering all branch combinations (4 test cases). This is the only true business logic gap.

3. **Future:** When position statuses evolve, add a snapshot test for `findActivePositions()` to guard the status list.

4. **Optional:** Bulk-add trivial pass-through tests for remaining untested methods to bring repository coverage above 90%. Low priority since these are pure Prisma delegations with no transformation logic.
