import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyBpsCeil,
  applyBpsFloor,
  divCeil,
  divFloor,
  fromMajor,
  parseAmount,
  splitProportionally,
  toMajor,
} from '../src/money/amount.js'

test('parseAmount rejects anything that is not integer minor units', () => {
  assert.equal(parseAmount('100500'), 100500n)
  assert.throws(() => parseAmount('1000.50'))
  assert.throws(() => parseAmount(1000))
  assert.throws(() => parseAmount('1e5'))
})

test('major/minor conversion survives the round trip', () => {
  assert.equal(fromMajor('1000.50', 2), 100050n)
  assert.equal(fromMajor('1 000,50', 2), 100050n)
  assert.equal(fromMajor('7', 0), 7n)
  assert.equal(toMajor(100050n, 2), '1000.50')
  assert.equal(toMajor(-5n, 2), '-0.05')
  assert.throws(() => fromMajor('1.005', 2), /at most 2 decimal places/)
})

test('rounding direction is explicit and correct for negatives', () => {
  assert.equal(divFloor(-7n, 2n), -4n)
  assert.equal(divCeil(-7n, 2n), -3n)
  assert.equal(applyBpsFloor(100000n, 50), 500n)
  // 0.5% of 1001 = 5.005 → the platform's favour is up.
  assert.equal(applyBpsCeil(100100n, 50), 501n)
  assert.equal(applyBpsFloor(100100n, 50), 500n)
})

test('splitProportionally never invents or loses a minor unit', () => {
  const parts = splitProportionally(1000n, [6000, 4000])
  assert.deepEqual(parts, [600n, 400n])

  // 100 across three equal shares: 33/33/33 leaves 1 — it goes to the largest
  // weight, deterministically, and the total still matches.
  const thirds = splitProportionally(100n, [1, 1, 1])
  assert.equal(thirds.reduce((a, b) => a + b, 0n), 100n)

  for (const total of [1n, 7n, 999n, 1_000_003n]) {
    const weights = [5123, 2877, 2000]
    const split = splitProportionally(total, weights)
    assert.equal(split.reduce((a, b) => a + b, 0n), total, `total ${total}`)
  }
})

test('share_bps always sum to exactly 10000, whatever the investor count', () => {
  for (const count of [1, 2, 3, 7, 11, 100]) {
    const amounts = Array.from({ length: count }, (_, i) => BigInt(1000 + i * 37))
    const shares = splitProportionally(10000n, amounts)
    assert.equal(shares.reduce((a, b) => a + b, 0n), 10000n, `${count} investors`)
  }
})
