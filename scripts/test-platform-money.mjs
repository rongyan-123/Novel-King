import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doubledCostMicros, parseFen, maximumCharge } from '../platform/money.mjs';

test('MapFlow actual CNY cost is doubled with final upward rounding, including tiny and exponent values', () => {
  assert.equal(doubledCostMicros('0.00023', 'CNY'), 460);
  assert.equal(doubledCostMicros('0.0000006', 'CNY'), 2);
  assert.equal(doubledCostMicros('0.0000005', 'CNY'), 1);
  assert.equal(doubledCostMicros('1e-7', 'CNY'), 1);
  assert.equal(doubledCostMicros(0, 'CNY'), 0);
  for (const value of [-1, 'NaN', 'Infinity', null, true, '1e100', ' 1', '1x', '99999999999999999999']) assert.throws(() => doubledCostMicros(value, 'CNY'));
  assert.throws(() => doubledCostMicros(1, 'USD'));
});
test('recharge fen accepts exact two-place currency and quote covers maximum active channel', () => {
  assert.equal(parseFen('0.01'), 1); assert.equal(parseFen('10000.00'), 1000000);
  for (const value of ['0', '1.001', '-1', 'NaN', '10000.01']) assert.throws(() => parseFen(value));
  assert.equal(maximumCharge({ input: 1600000, output: 3200000, bytes: 0, tokens: 100 }), 6874);
});
