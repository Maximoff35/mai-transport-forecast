import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../app/api/replay/route';
import { calculateReplay, validateReplay, type ReplayResult } from '../lib/replay';
import { VERIFIED_DATASET } from '../lib/seed';
import { validateUploadedDataset } from '../lib/csv';
import national from '../data/national-annual.json';
import { capacityForPeriod, PUBLISHED_CAPACITIES, type AnnualCapacityRecord } from '../lib/capacity';

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

const capacityRecord = (year: number, annualCapacity: number): AnnualCapacityRecord => ({
  year, measuredYear: year - 1, annualCapacity, asOf: `${year}-01-01`, basin: 'baltic',
  sourceUrl: 'https://example.test/capacity', publishedOn: `${year}-07-13`,
});

test('published capacity reconstruction preserves constant-capacity arithmetic and marks late information', () => {
  const scenario = calculateReplay(VERIFIED_DATASET, validateReplay(request));
  const published = calculateReplay(VERIFIED_DATASET, validateReplay({...request, capacityMode:'published'}), [capacityRecord(2026,272)]);
  assert.deepEqual(published.strategies.map(row=>row.gap), scenario.strategies.map(row=>row.gap));
  assert.deepEqual(published.windows[0].actions, scenario.windows[0].actions);
  assert.equal(published.capacityMode,'published');
  assert.equal(published.causalBacktest,false);
  assert.equal(published.windows[0].capacityKnownAtDecision,false);
  assert.deepEqual(published.windows[0].capacityQuarterly,[68,68]);
  assert.equal(published.windows[0].capacityReferences[0].annualCapacity,272);
  assert.ok(published.capacityAssumptions.some(text=>text.includes('позднее')));
  assert.equal(scenario.capacityMode,'scenario');
  assert.equal(scenario.causalBacktest,true);
});

test('year-specific capacities change the reserve quarter and retain the common calendar rules', () => {
  const input = validateReplay({...request,first:'2025-Q4',last:'2026-Q1',capacityMode:'published'});
  const result=calculateReplay(VERIFIED_DATASET,input,[capacityRecord(2025,240),capacityRecord(2026,400)]);
  const window=result.windows[0];
  assert.deepEqual(window.capacityQuarterly,[60,100]);
  assert.deepEqual(window.actions.map(row=>row.capacities),[[60,96],[63,96],[56,100]]);
  assert.equal(window.actions[1].reservePeriod,'2025-Q4');
  assert.equal(window.actions[1].deadline,'2025-08-17');
  assert.equal(window.actions[1].available,true);
  assert.deepEqual(window.strategies.base.capacities,[60,96]);
  assert.deepEqual(window.strategies.fixed.capacities,[60,99]);
  assert.equal(window.strategies.forecast.totalGap,4.4);
  assert.equal(window.strategies.base.totalGap,7.4);
  const changed=structuredClone(VERIFIED_DATASET);
  changed.basins.baltic.find(row=>row.period==='2026-Q1')!.value=500;
  const rerun=calculateReplay(changed,input,[capacityRecord(2025,240),capacityRecord(2026,400)]);
  assert.deepEqual(rerun.windows[0].actions,window.actions);
  assert.equal(rerun.windows[0].strategies.forecast.action,window.strategies.forecast.action);
});

test('published mode keeps the requested full history and names every missing capacity year', () => {
  const result=calculateReplay(VERIFIED_DATASET,validateReplay({...request,first:'2012-Q1',capacityMode:'published'}),[capacityRecord(2026,400)]);
  assert.equal(result.first,'2012-Q1');
  assert.equal(result.coverage.requestedWindows,29);
  assert.equal(result.coverage.evaluatedWindows,1);
  assert.equal(result.coverage.skippedWindows,28);
  assert.deepEqual(result.coverage.availableCapacityYears,[2026]);
  assert.deepEqual(result.coverage.missingCapacityYears,Array.from({length:14},(_,i)=>2012+i));
  assert.ok(result.skipped.some(row=>row.reason.includes('2012')));
  assert.deepEqual(result.coverage.coveredPeriods,['2026-Q1','2026-Q2']);
  assert.deepEqual(result.strategies.map(row=>row.gap),[0,0,0]);
});

test('capacity snapshots apply only to their dated year and reject an invalid snapshot or excessive repair', () => {
  const record=capacityRecord(2013,303.8);
  assert.equal(capacityForPeriod([record],'baltic','2012-Q4'),undefined);
  assert.equal(capacityForPeriod([record],'baltic','2014-Q1'),undefined);
  assert.equal(capacityForPeriod([record],'baltic','2013-Q1')?.quarterlyEquivalent,75.95);
  assert.throws(()=>capacityForPeriod([{...record,asOf:'2012-01-01'}],'baltic','2013-Q1'));
  const tooSmall=calculateReplay(VERIFIED_DATASET,validateReplay({...request,capacityMode:'published'}),[capacityRecord(2026,8)]);
  assert.equal(tooSmall.windows.length,0);
  assert.match(tooSmall.skipped[0].reason,/Потеря при ремонте/);
  assert.throws(()=>validateReplay({...request,capacityMode:'guessed'}),{name:'ValidationError'});
});

test('the published source archive covers only available capacity years and preserves source provenance', () => {
  const result=calculateReplay(VERIFIED_DATASET,validateReplay({...request,first:'2012-Q1',capacityMode:'published'}));
  const sourceYears=[...new Set(PUBLISHED_CAPACITIES.filter(row=>row.basin==='baltic').map(row=>row.year))].sort((a,b)=>a-b);
  const firstHistoryYear=Number(VERIFIED_DATASET.basins.baltic[0].period.slice(0,4));
  const completeAvailableYears=sourceYears.filter(year=>year>firstHistoryYear&&year<2026);
  assert.deepEqual(result.coverage.availableCapacityYears,sourceYears);
  assert.equal(result.coverage.evaluatedWindows,completeAvailableYears.length*2);
  assert.equal(result.coverage.requestedWindows,29);
  assert.equal(result.coverage.evaluatedWindows+result.coverage.skippedWindows,29);
  const example=result.windows.find(window=>window.periods[0]==='2017-Q1')!;
  assert.deepEqual(example.capacityQuarterly,[83.625,83.625]);
  assert.equal(example.capacityReferences[0].annualCapacity,334.5);
  assert.ok(example.capacityReferences.every(row=>!!row.sourceUrl&&!!row.localSourceUrl));
  assert.equal(example.capacityKnownAtDecision,false);
  assert.equal(result.causalBacktest,false);
});

test('the published 2013 to 2014 boundary applies each sourced annual value to its own year', () => {
  const result=calculateReplay(VERIFIED_DATASET,validateReplay({...request,first:'2013-Q4',last:'2014-Q1',capacityMode:'published'}));
  const window=result.windows[0];
  assert.deepEqual(window.capacityQuarterly,[75.95,76.95]);
  assert.deepEqual(window.actions[0].capacities,[75.95,72.95]);
  assert.deepEqual(window.capacityReferences.map(row=>row.year),[2013,2014]);
  assert.deepEqual(window.capacityReferences.map(row=>row.measuredYear),[2012,2013]);
  assert.equal(window.capacityKnownAtDecision,false);
  assert.ok(window.capacityReferences.every(row=>row.publishedOn===null));
});

test('six sourced capacity snapshots retain exact annual-to-quarter arithmetic for each basin', () => {
  const expected: Record<number,number[]> = {
    2012:[73.05,57.75,40.675], 2013:[75.95,64.775,47.025],
    2014:[76.95,66,47.975], 2017:[83.625,93.35,51],
    2018:[86.45,95.7,56.575], 2019:[90.35,97.6,59.825],
  };
  for(const [year,values] of Object.entries(expected)) {
    const actual=(['baltic','azov','far_east'] as const).map(basin=>capacityForPeriod(PUBLISHED_CAPACITIES,basin,`${year}-Q1`)?.quarterlyEquivalent);
    assert.deepEqual(actual,values);
  }
  const keys=PUBLISHED_CAPACITIES.map(row=>`${row.basin}:${row.year}`);
  assert.equal(new Set(keys).size,keys.length);
  assert.ok(PUBLISHED_CAPACITIES.every(row=>row.unit==='million_tonnes_per_year'&&row.measurement==='installed'));
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
