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

test('economic choice maximizes expected contribution among available actions before actuals are revealed', () => {
  const input = validateReplay({
    ...request, recoverablePercent: 25, tariff: 800, variableCost: 500, reserveCost: 20_000_000, moveCost: 0,
  });
  const original = calculateReplay(VERIFIED_DATASET, input);
  const window = original.windows[0];
  assert.equal(original.chosenObjective, 'contribution');
  assert.equal(window.strategies.forecast.action, 'reserve');
  assert.equal(window.predictedChoiceScore, 205_000_000);
  assert.equal(window.predictedContributionByAction.base, 0);
  assert.equal(window.predictedContributionByAction.move, null);
  const availableScores = window.actions.filter(action => action.available).map(action => {
    const recovered = (window.actions[0].totalGap - action.totalGap) * 1e6 * .25;
    const cost = action.id === 'reserve' ? 20_000_000 : 0;
    return recovered * 300 - cost;
  });
  assert.equal(window.predictedChoiceScore, Math.max(...availableScores));
  const changed = structuredClone(VERIFIED_DATASET);
  changed.basins.baltic.find(row => row.period === '2026-Q1')!.value = 0;
  changed.basins.baltic.find(row => row.period === '2026-Q2')!.value = 0;
  const rerun = calculateReplay(changed, input);
  assert.equal(rerun.windows[0].strategies.forecast.action, window.strategies.forecast.action);
  assert.equal(rerun.windows[0].predictedChoiceScore, window.predictedChoiceScore);
  assert.equal(rerun.windows[0].choiceReason, window.choiceReason);
  assert.equal(rerun.strategies[1].contribution, -20_000_000);
  assert.equal(rerun.strategies[1].uselessReserves, 1);
  assert.equal(rerun.strategies[1].classificationCounts.noOverload, 1);
});

test('a measure with negative expected contribution loses to the zero-cost baseline', () => {
  const result = calculateReplay(VERIFIED_DATASET, validateReplay({
    ...request, recoverablePercent: 25, tariff: 800, variableCost: 500, reserveCost: 1_000_000_000, moveCost: 0,
  }));
  assert.equal(result.windows[0].strategies.forecast.action, 'base');
  assert.equal(result.windows[0].predictedChoiceScore, 0);
  assert.ok(result.windows[0].predictedContributionByAction.reserve! < 0);
  assert.equal(result.strategies[1].contribution, 0);
  assert.equal(result.strategies[1].missedWindows, 1);
  assert.equal(result.strategies[1].classificationCounts.missed, 1);
  assert.match(result.windows[0].choiceReason, /Сохранён исходный план/);
});

test('known measure costs can change the best choice among all three available actions', () => {
  const dataset = structuredClone(VERIFIED_DATASET);
  dataset.basins.baltic.find(row => row.period === '2025-Q1')!.value = 60;
  dataset.basins.baltic.find(row => row.period === '2025-Q2')!.value = 70;
  const parameters = {
    ...request, repairLeadDays: 0, recoverablePercent: 100, tariff: 100, variableCost: 0,
    reserveCost: 0, moveCost: 200_000_000,
  };
  const expensiveMove = calculateReplay(dataset, validateReplay(parameters));
  assert.equal(expensiveMove.windows[0].actions.every(action => action.available), true);
  assert.deepEqual(expensiveMove.windows[0].actions.map(action => action.totalGap), [6,3,2]);
  assert.equal(expensiveMove.windows[0].strategies.forecast.action, 'reserve');
  assert.equal(expensiveMove.windows[0].predictedChoiceScore, 300_000_000);
  const freeMove = calculateReplay(dataset, validateReplay({...parameters, moveCost: 0}));
  assert.equal(freeMove.windows[0].strategies.forecast.action, 'move');
  assert.equal(freeMove.windows[0].predictedChoiceScore, 400_000_000);
});

test('zero recoverable share and zero margin preserve the simpler action on economic ties', () => {
  for (const economics of [
    {recoverablePercent: 0, tariff: 800, variableCost: 500},
    {recoverablePercent: 100, tariff: 500, variableCost: 500},
    {recoverablePercent: 100, tariff: 100, variableCost: 500},
  ]) {
    const result = calculateReplay(VERIFIED_DATASET, validateReplay({
      ...request, ...economics, reserveCost: 0, moveCost: 0,
    }));
    assert.equal(result.windows[0].strategies.forecast.action, 'base');
    assert.equal(result.strategies[1].contribution, 0);
  }
});

test('volume and outcome summaries include all windows and distinguish quiet periods from missed gaps', () => {
  const result = calculateReplay(VERIFIED_DATASET, validateReplay({...request, first:'2012-Q1'}));
  assert.equal(result.chosenObjective, 'gap');
  const observed = result.windows.flatMap(window => window.actual).reduce((total, row) => total + row.value, 0);
  assert.ok(Math.abs(result.totalObserved - observed) < 1e-6);
  for (const row of result.strategies) {
    assert.ok(Math.abs(row.servedVolume + row.gap - result.totalObserved) < 1e-6);
    assert.equal(Object.values(row.resultCounts).reduce((a, b) => a + b, 0), result.windows.length);
    assert.equal(Object.values(row.classificationCounts).reduce((a, b) => a + b, 0), result.windows.length);
    assert.equal(row.improvedWindows, row.resultCounts.improved);
    assert.equal(row.gapClosedWindows, row.classificationCounts.gapClosed);
    assert.equal(row.missedWindows, row.classificationCounts.missed);
    assert.ok(row.uselessReserves <= row.reserves);
    assert.equal(row.recoverableTons, null);
    assert.equal(row.predictedContribution, null);
  }
  assert.ok(result.strategies[1].classificationCounts.noOverload > 0);
  assert.ok(result.strategies[1].missedWindows > 0);
  const one = calculateReplay(VERIFIED_DATASET, validateReplay(request));
  assert.equal(one.totalObserved, 130.3);
  assert.equal(one.strategies[0].servedVolume, 128.3);
  assert.equal(one.strategies[1].servedVolume, 130.3);
  assert.equal(one.strategies[1].gapClosedWindows, 1);
});

test('empty replay retains zero aggregates and explicit economic assumptions', () => {
  const result = calculateReplay(VERIFIED_DATASET, validateReplay({
    ...request, first:'2000-Q1', last:'2000-Q2', recoverablePercent:25,
    tariff:800, variableCost:500, reserveCost:20_000_000, moveCost:0,
  }));
  assert.equal(result.windows.length, 0);
  assert.equal(result.totalObserved, 0);
  for (const row of result.strategies) {
    assert.deepEqual([row.gap, row.servedVolume, row.reserves, row.contribution], [0,0,0,0]);
    assert.equal(Object.values(row.classificationCounts).reduce((a,b)=>a+b,0),0);
  }
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
