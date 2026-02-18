import 'reflect-metadata';

// Shared environment variables for e2e tests.
// Vitest runs this file before each test file via setupFiles in vitest.config.ts.

process.env.RISK_BANKROLL_USD = '10000';
process.env.RISK_MAX_POSITION_PCT = '0.03';
process.env.RISK_MAX_OPEN_PAIRS = '10';
process.env.RISK_DAILY_LOSS_PCT = '0.05';
process.env.OPERATOR_API_TOKEN = 'test-token';
