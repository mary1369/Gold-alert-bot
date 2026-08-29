const assert = require('assert');
const { classifyTick, buildProxyFlow } = require('./dukascopy_adapter');

assert.strictEqual(classifyTick(null, 100), 0);
assert.strictEqual(classifyTick(100, 101), 1);
assert.strictEqual(classifyTick(101, 100), -1);
assert.strictEqual(classifyTick(100, 100), 0);

const result = buildProxyFlow([
  { timestamp: 1, price: 100, volume: 2 },
  { timestamp: 2, price: 101, volume: 3 },
  { timestamp: 3, price: 100, volume: 1 },
  { timestamp: 4, price: 100, volume: 5 },
]);

assert.strictEqual(result.isReal, false);
assert.strictEqual(result.out.length, 4);
assert.deepStrictEqual(result.out.map(x => x.delta), [0, 3, -1, 0]);
assert.deepStrictEqual(result.out.map(x => x.cvd), [0, 3, 2, 2]);

console.log('OK: Dukascopy proxy Order Flow adapter tests passed');
