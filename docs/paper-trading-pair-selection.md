# Paper Trading Pair Selection Log

**Verification Date:** 2026-02-28
**Verified By:** Operator (manual curation)
**Validation Phase:** Epic 6.5 — Paper Trading Validation

## Selected Pairs (8 active)

| # | Event Description | Kalshi Ticker | Polymarket Contract ID | Category | Resolution Date | Primary Leg | Rationale |
|---|------------------|---------------|----------------------|----------|----------------|-------------|-----------|
| 1 | Will Republicans lose the House majority before the midterms? | KXLOSEMAJORITY-27JAN01 | 82155...8574 | Politics | 2026-11-03 | polymarket | High-liquidity political market, long resolution window |
| 2 | Blue tsunami in 2026? | KXBLUETSUNAMICOMBO-27FEB | 10455...9402 | Politics | 2026-11-30 | kalshi | Cross-platform political combo market |
| 3 | Will Katy Perry and Justin Trudeau be engaged this year? | KXENGAGEMENTTRUDEAUPERRY-26 | 75971...7980 | Entertainment | 2026-12-31 | polymarket | Novelty market, active on both platforms |
| 4 | Will Mamdani raise the minimum wage to $30 before 2027? | KXNYCMINWAGE-27JAN01 | 71061...6326 | Economics | 2026-12-31 | kalshi | Policy market with clear resolution criteria |
| 5 | Blue wave this year? | KXBLUEWAVECOMBO-27FEB | 39304...0087 | Politics | 2026-11-30 | polymarket | Cross-platform political market |
| 6 | Will the U.S. confirm that aliens exist before 2027? | KXALIENS-27 | 10750...0417 | Science/Novelty | 2026-12-31 | polymarket | Long-dated novelty market |
| 7 | Will Bitcoin outperform Gold in 2026? | KXBTCVSGOLD-26 | 47113...1087 | Crypto/Finance | 2026-12-31 | kalshi | Financial market with regular order book activity |
| 8 | Will Greenland vote for independence this year? | KXGREENIND-27 | 25664...1451 | Geopolitics | 2026-12-31 | polymarket | Geopolitical event market |

## Category Breakdown

| Category | Count | Pairs |
|----------|-------|-------|
| Politics | 3 | #1, #2, #5 |
| Economics/Policy | 1 | #4 |
| Crypto/Finance | 1 | #7 |
| Entertainment/Novelty | 2 | #3, #6 |
| Geopolitics | 1 | #8 |

**Diversification:** 5 categories represented (exceeds 3-category minimum).

## Resolution Date Analysis

| Resolution Window | Count | Pairs |
|-------------------|-------|-------|
| >30 days from validation start | 8 | All pairs |
| At-risk (<14 days from Phase 2 end) | 0 | None |

All 8 pairs have resolution dates in late 2026, providing ample runway for the 7-day validation window.

## Compliance Check

All 8 event descriptions checked against `compliance-matrix.yaml` blocked categories:
- `adult-content`: 0 matches
- `assassination`: 0 matches
- `terrorism`: 0 matches

**Result: PASS** — zero compliance violations.

## Rejected Candidates

| Event Description | Reason for Rejection |
|-------------------|---------------------|
| U.S. Presidential Election 2028 | Resolution date too far out (2028), no near-term order book activity |
| Fed Rate Decision (March 2026) | Already resolved before validation window |
| Super Bowl LVIII Winner | Resolved before validation start date |
| Will TikTok be banned in the U.S.? | Only available on one platform (Polymarket) at time of survey |
| Daily temperature records | Markets too illiquid on Kalshi — order books effectively empty |
| Elon Musk to step down as Tesla CEO | Available on Polymarket only; no matching Kalshi market found |
| Will there be a government shutdown? | Resolution window overlaps too closely with validation start — risk of early resolution |

## Pair Count Note

8 pairs configured vs. AC#1 target of 10-15. This is a known gap accepted for the current validation phase. Additional pairs can be added as new cross-platform markets are identified.
