# Framework & Library Gotchas

Known gotchas discovered across Epics 1–4. Each entry includes a problem demonstration and solution.

Last updated: 2026-02-25 (Story 6.5.0)

---

## 1. `plainToInstance()` Does Not Apply TypeScript Defaults

**Source:** Story 3-1 Dev Notes

TypeScript default values on class properties are ignored by `class-transformer`'s `plainToInstance()`. The transformer creates instances by assigning parsed properties directly, bypassing the constructor default assignment.

**Problem:**

```typescript
class ContractPairDto {
  primaryLeg?: PrimaryLeg = PrimaryLeg.KALSHI; // TS default — IGNORED by plainToInstance
}
const dto = plainToInstance(ContractPairDto, parsed);
console.log(dto.primaryLeg); // undefined, NOT PrimaryLeg.KALSHI
```

**Solution:**

```typescript
// Explicitly default in the transform step, not the DTO
const dto = plainToInstance(ContractPairDto, parsed);
dto.primaryLeg = dto.primaryLeg ?? PrimaryLeg.KALSHI;
// Do NOT use exposeDefaultValues: true — it masks missing-field bugs in future DTOs
```

---

## 2. `OnModuleInit` Execution Order Not Guaranteed

**Source:** Story 3-4 Dev Notes, Epic 3 Retro

NestJS does not guarantee the execution order of `OnModuleInit` across providers within the same module. If service A depends on service B having initialized first, you must add a defensive check.

**Problem:**

```typescript
// ContractMatchSyncService depends on ContractPairLoaderService having loaded pairs
// But NestJS does NOT guarantee OnModuleInit order between providers in the same module
@Injectable()
export class ContractMatchSyncService implements OnModuleInit {
  async onModuleInit() {
    const pairs = this.pairLoader.getActivePairs(); // May be empty!
  }
}
```

**Solution:**

```typescript
async onModuleInit() {
  const pairs = this.pairLoader.getActivePairs();
  if (pairs.length === 0) {
    this.logger.warn('No active pairs loaded yet — skipping initial seed');
    return; // Defensive check — don't crash, just skip
  }
  await this.seedMatches(pairs);
}
```

---

## 3. `ConfigService.get()` Returns Strings for Env Vars

**Source:** Story 4-1, 4-2 Dev Notes

`process.env` values are always strings. The `<number>` generic on `ConfigService.get<number>()` is a TypeScript-only hint — it does not convert the value. Arithmetic with string values silently produces wrong results.

**Problem:**

```typescript
// process.env values are ALWAYS strings, even with <number> generic
const maxPct = this.configService.get<number>('RISK_MAX_POSITION_PCT', 0.03);
// maxPct is actually string "0.03", not number 0.03
// Arithmetic silently produces wrong results: "0.03" * 100 = 3, but "0.03" + 1 = "0.031"
```

**Solution:**

```typescript
const maxPctRaw = this.configService.get<string | number>('RISK_MAX_POSITION_PCT', 0.03);
const maxPct = Number(maxPctRaw);
// Always wrap in Number() when expecting numeric values from env
```

---

## 4. Circular Import Resolution via Constants Extraction

**Source:** Story 4-3 Debug Log, Story 2-2 Dev Notes

NestJS DI tokens defined in the same module file that imports controllers/services using those tokens create circular imports. Also, module-level circular dependencies require `forwardRef()`.

**Problem:**

```typescript
// risk-management.module.ts imports RiskController which imports RISK_MANAGER_TOKEN
// from risk-management.module.ts → circular!
// Also: ConnectorModule ↔ DataIngestionModule circular dependency
```

**Solution:**

```typescript
// Extract DI tokens to a separate constants file
// risk-management.constants.ts
export const RISK_MANAGER_TOKEN = 'RISK_MANAGER_TOKEN';

// For module-level circular deps, use forwardRef():
@Module({
  imports: [forwardRef(() => DataIngestionModule)],
})
export class ConnectorModule {}
```

---

## 5. Fire-Once Event Pattern for Warning Emissions

**Source:** Story 4-2 AC2

Methods called on every trade (e.g., `updateDailyPnl`) that emit warning events will flood logs and Telegram if the condition persists. Use a boolean flag to ensure the event fires only once per reset cycle.

**Problem:**

```typescript
// updateDailyPnl() called on every trade — emits LimitApproachedEvent every time
// losses are in the 80-100% range, flooding logs and Telegram
updateDailyPnl(pnl: Decimal) {
  if (this.dailyLossRatio >= 0.8) {
    this.eventEmitter.emit('risk.limit.approached', event); // fires repeatedly!
  }
}
```

**Solution:**

```typescript
private dailyLossApproachEmitted = false;

updateDailyPnl(pnl: Decimal) {
  if (this.dailyLossRatio >= 0.8 && !this.dailyLossApproachEmitted) {
    this.eventEmitter.emit('risk.limit.approached', event);
    this.dailyLossApproachEmitted = true; // fire once per day
  }
}

resetDaily() {
  this.dailyPnl = new Decimal(0);
  this.dailyLossApproachEmitted = false; // reset flag at midnight UTC
}
```

---

## 6. `FinancialDecimal` / `Decimal` Precision — Absolute Rule: No Native Arithmetic on Monetary Fields

**Source:** Story 4.5.1 (property-based testing), Epic 4 Retro, Epic 6 Retro, Story 6.5.0 (codebase-wide audit)

**Absolute rule:** Any arithmetic operation (`+`, `-`, `*`, `/`, `Math.abs()`, `Math.round()`) on a field that touches money uses `decimal.js`, regardless of where the code lives — connectors, formatters, logging, utilities, display code. No context-based exceptions.

Native JavaScript `number` uses IEEE 754 floating-point, which introduces rounding errors that accumulate in financial calculations. All monetary and probability arithmetic must use `Decimal` via the `FinancialMath` utility or direct `decimal.js` calls.

**Problem:**

```typescript
// Native JS number arithmetic introduces floating-point errors
const edge = priceA - priceB - fees; // 0.1 + 0.2 = 0.30000000000000004
const positionSize = bankroll * 0.03; // Accumulated rounding in position sizing
```

**Solution:**

```typescript
import { FinancialMath } from '../common/utils/financial-math';

// All financial calculations use Decimal (via decimal.js) through FinancialMath
const edge = FinancialMath.calculateEdge(priceA, priceB, fees);
const positionSize = FinancialMath.calculatePositionSize(bankroll, maxPct);
// Never convert to number until final display/serialization
// Property-based tests (Story 4.5.1) verify composition chain correctness
```

**Non-obvious violation sites discovered in Story 6.5.0 audit:**

| Site | Example | Why it's not obvious |
|------|---------|---------------------|
| Connector price conversions | `priceCents / 100` in Kalshi connector | "Just a unit conversion" — but it produces a price used in order submission |
| Sort comparators on price arrays | `bids.sort((a, b) => b.price - a.price)` | "Just comparison" — but arithmetic on price fields, fix for consistency |
| Spread calculation in logging | `bestAsk.price - bestBid.price` in log object | "Just logging" — but native subtraction on price fields |
| Fee percent-to-decimal conversions | `takerFeePercent / 100` | "Just conversion" — but fee value used in P&L scenarios |
| Fill price calculation | `taker_fill_cost / filledQuantity / 100` | Multi-step division on monetary values with cumulative precision loss |
| Edge recalculation | `Math.abs(entryFillPrice - orderResult.filledPrice)` | Combines `Math.abs` + native subtraction on fill prices |

**Decimal constructor best practice — use `.toString()` bridge:**

```typescript
// Prefer toString() when converting from number to Decimal
new Decimal(value.toString())  // explicit — signals intent
new Decimal(value)             // implicit — acceptable but less clear
```

**Sort comparator performance trade-off:**

`array.sort((a, b) => new Decimal(b.price).minus(a.price).toNumber())` creates Decimal objects per comparison. This is acceptable because order book sorts run once per message (~10-50 levels), not in a tight loop. The consistency benefit outweighs the negligible GC overhead.

**Audit summary (Story 6.5.0):** 11 violation sites across 7 files identified and fixed. All fixes use `decimal.js` internally and convert to `number` at the interface boundary via `.toNumber()`. See story file for full audit table.

---

## 7. P&L Source of Truth: Order Fill Records, Not Position Entry Prices

**Source:** Stories 5.3, 5.4, 5.5 Dev Notes

Always compute P&L from order fill records (`order.fillPrice`, `order.fillSize`), never from `position.entryPrices`. The `entryPrices` field is a convenience snapshot set at position creation time and may drift from reality if partial fills or reconciliation adjustments occur.

**Problem:**

```typescript
const pnl = position.entryPrices.kalshi - position.entryPrices.polymarket; // WRONG — uses snapshot, not actual fills
```

**Solution:**

```typescript
const kalshiCost = new Decimal(order.kalshiOrder.fillPrice.toString()).mul(new Decimal(order.kalshiOrder.fillSize.toString()));
const polyCost = new Decimal(order.polymarketOrder.fillPrice.toString()).mul(new Decimal(order.polymarketOrder.fillSize.toString()));
const pnl = kalshiCost.plus(polyCost).minus(totalCapitalDeployed); // Correct — uses actual fill data
```
