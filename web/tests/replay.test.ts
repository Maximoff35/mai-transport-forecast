import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../app/api/replay/route';
import { calculateReplay, validateReplay, type ReplayResult } from '../lib/replay';
import { VERIFIED_DATASET } from '../lib/seed';
import { validateUploadedDataset } from '../lib/csv';
import national from '../data/national-annual.json';

const request = {
  basin: 'baltic', first: '2026-Q1', last: '2026-Q2', capacity: 68, repairLoss: 4, reserve: 3,
  reserveLeadDays: 45, repairLeadDays: 90, allowMove: true,
};

test('historical choice ignores the outcome and uses the same calendar and scenario rules', () => {
  const input = validateReplay(request);
  const original = calculateReplay(VERIFIED_DATASET, input);
  assert.equal(original.windows[0].asOf, '2025-10-10');
  assert.deepEqual(original.windows[0].references.map(row => row.value), [68.1, 67.7]);
  assert.deepEqual(original.windows[0].actual.map(row => row.value), [64.3, 66]);
  assert.equal(original.windows[0].actions.find(row => row.id === 'move')?.available, false);
  assert.deepEqual(original.strategies.map(row => row.gap), [2, 0, 0]);
  assert.equal(original.strategies[1].contribution, null);
  const changed = structuredClone(VERIFIED_DATASET);
  changed.basins.baltic.find(row => row.period === '2026-Q2')!.value = 30;
  const rerun = calculateReplay(changed, input);
  assert.deepEqual(rerun.windows[0].actions, original.windows[0].actions);
  assert.equal(rerun.windows[0].strategies.base.totalGap, 0);
});

test('long replay uses disjoint windows, actual releases and source URLs', () => {
  const result = calculateReplay(VERIFIED_DATASET, validateReplay({...request, first: '2012-Q1'}));
  const periods = result.windows.flatMap(row => row.periods);
  assert.ok(result.windows.length >= 24);
  assert.equal(new Set(periods).size, periods.length);
  assert.ok(result.skipped.some(row => row.first === '2012-Q1'));
  assert.ok(result.windows.every(w => w.references.every(r => r.sourceUrl && r.publishedOn <= w.asOf)));
  assert.equal(result.windows.length, 27);
  assert.deepEqual(result.strategies.map(row => row.gap), [31.6, 20.6, 11.1]);
  assert.deepEqual(result.strategies.map(row => row.reserves), [0, 7, 27]);
  assert.equal(result.comparison.fixedReserveThresholdTons, 475000);
  const quarters = VERIFIED_DATASET.basins.baltic;
  assert.deepEqual(quarters.map(row => row.period), Array.from({length:58}, (_, i) => `${2012+Math.floor(i/4)}-Q${i%4+1}`));
  assert.deepEqual(national.map(row => row.year), Array.from({length:35}, (_, i) => 1991+i));
});

test('economic estimate accounts for recoverable volume, contribution and measure cost', () => {
  const row = calculateReplay(VERIFIED_DATASET, validateReplay({
    ...request, recoverablePercent: 25, tariff: 800, variableCost: 500, reserveCost: 20_000_000, moveCost: 0,
  })).strategies[1];
  assert.deepEqual([row.revenue, row.processingCost, row.measureCost, row.contribution, row.breakEvenTons],
    [400_000_000, 250_000_000, 20_000_000, 130_000_000, 66_667]);
  assert.throws(() => validateReplay({...request, tariff: 800}), {name:'ValidationError'});
});

test('previous browser dataset is backfilled with the new archive', () => {
  const previous = structuredClone(VERIFIED_DATASET);
  for (const rows of Object.values(previous.basins)) rows.splice(0, rows.length - 18);
  assert.deepEqual(validateUploadedDataset(previous).basins, VERIFIED_DATASET.basins);
});

test('replay API returns a selected historical range and rejects a single quarter', async () => {
  const post = (body: unknown) => POST(new Request('http://localhost/api/replay', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
  }));
  const response = await post({...request, first: '2018-Q1', last: '2020-Q4'});
  assert.equal(response.status, 200);
  assert.ok((await response.json() as ReplayResult).windows.length >= 4);
  assert.equal((await post({...request, last: request.first})).status, 422);
});
