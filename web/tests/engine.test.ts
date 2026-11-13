import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {calculateScenario,validateInput} from '../lib/engine.ts';
import {DEMO_INPUT,type HistoricalDataset,type BasinId} from '../lib/contracts.ts';

const raw=JSON.parse(readFileSync(resolve(process.cwd(),'data/verified-quarters.json'),'utf8'));
const fields={baltic:'baltic_ytd_million_tonnes',azov:'azov_black_sea_ytd_million_tonnes',far_east:'far_east_ytd_million_tonnes'};
const basins=Object.fromEntries(Object.entries(fields).map(([basin,key])=>{let prev=0;return [basin,raw.map((r:Record<string,string>)=>{if(r.quarter.endsWith('Q1'))prev=0;const value=Math.round((Number(r[key])-prev)*10)/10;prev=Number(r[key]);return {period:r.quarter,value,publishedOn:r.published_on,sourceUrl:r.source_url}})]})) as HistoricalDataset['basins'];
const dataset:HistoricalDataset={basins,monthly:{baltic:[],azov:[],far_east:[]},sources:[],warnings:[],snapshot:{version:'test',status:'snapshot',checkedAt:'2026-11-13',fetchedAt:'2026-11-13',lastPeriod:'2026-Q2',publicationDate:'2026-07-13',sourceLabel:'test',sourceUrl:'https://example.test',message:'Frozen fixture'}};
const run=(overrides={})=>calculateScenario(dataset,{...DEMO_INPUT,...overrides});
const gaps=(r:ReturnType<typeof run>)=>r.actions.map(a=>a.totalGap);

test('baseline, negative and positive load scenarios retain exact control results',()=>{
  const base=run();assert.deepEqual(base.planPeriods,['2027-Q1','2027-Q2']);assert.deepEqual(base.baseLoads,[64.3,66]);assert.deepEqual(gaps(base),[2,0,.3]);assert.equal(base.recommendedId,'reserve');assert.equal(base.recommendation.fullyCovered,true);
  assert.equal(run({shockPercent:-5}).actions[0].totalGap,0);
  const stress=run({shockPercent:5});assert.deepEqual(gaps(stress).slice(0,2),[5.3,2.3]);assert.equal(stress.recommendation.needsAdditionalPlan,true);assert.deepEqual(stress.requiredReserve.byPeriod,[0,5.3]);
  assert.deepEqual(stress.history,base.history);assert.equal(stress.forecast.at(-1)?.scenario,69.3);
});
test('southern basin shows the forbidden hypothetical move and recommends reserve',()=>{
  const r=run({basin:'azov'});assert.deepEqual(gaps(r),[8.7,5.7,4.7]);assert.equal(r.actions[2].available,false);assert.equal(r.actions[2].deadline,'2026-10-03');assert.equal(r.recommendedId,'reserve');assert.equal(r.recommendation.residualGap,5.7);assert.equal(r.requiredReserve.singleSlotEnough,true);
  assert.equal(run({basin:'azov',calendarEnabled:false}).recommendedId,'move');
});
test('deadline includes October 3 but excludes October 4; disabled move remains visible',()=>{
  assert.equal(run({asOf:'2026-10-03'}).actions[2].available,true);assert.equal(run({asOf:'2026-10-04'}).actions[2].available,false);
  assert.equal(run({allowMove:false,calendarEnabled:false}).actions.length,3);assert.equal(run({allowMove:false,calendarEnabled:false}).actions[2].available,false);
  assert.equal(run().actions[1].deadline,'2027-02-15');
});
test('display horizon does not truncate the two-quarter plan',()=>{
  const r=run({horizon:1});assert.equal(r.forecast.length,1);assert.equal(r.planningAvailable,true);assert.deepEqual(gaps(r),[2,0,.3]);
  const stale=run({asOf:'2027-04-01'});assert.equal(stale.planningAvailable,false);assert.equal(stale.recommendedId,null);assert.equal(stale.recommendation.needsAdditionalPlan,true);assert.equal(stale.actions.every(a=>!a.available),true);
});
test('stale data names the exact historical quarters required for the plan',()=>{
  const r=run({asOf:'2027-08-01'});assert.equal(r.planningAvailable,false);assert.match(r.planningUnavailableReason!,/2026-Q4, 2027-Q1/);assert.match(r.planningUnavailableReason!,/Загрузите данные/);
});
test('new user-supplied history extends plan and evaluation without recursive forecasts',()=>{
  const fresh=structuredClone(dataset);
  for(const basin of Object.keys(fields) as BasinId[])fresh.basins[basin].push(
    {period:'2026-Q3',value:70,publishedOn:'2026-10-13',sourceUrl:'https://example.test/3'},
    {period:'2026-Q4',value:71,publishedOn:'2027-01-13',sourceUrl:'https://example.test/4'},
    {period:'2027-Q1',value:72,publishedOn:'2027-04-13',sourceUrl:'https://example.test/1'},
  );
  const r=calculateScenario(fresh,{...DEMO_INPUT,asOf:'2027-05-01'});assert.equal(r.planningAvailable,true);assert.deepEqual(r.planPeriods,['2027-Q3','2027-Q4']);assert.deepEqual(r.baseLoads,[70,71]);assert.equal(r.backtest.points.at(-1)?.period,'2027-Q1');assert.equal(r.backtest.methods.every(m=>m.n===6),true);
  assert.equal(calculateScenario(fresh,{...DEMO_INPUT,asOf:'2027-04-12'}).history.at(-1)?.period,'2026-Q4');
});
test('release-date truncation prevents future data leaking into current prediction',()=>{
  const before=run({asOf:'2026-07-12'}),after=run({asOf:'2026-07-13'});assert.equal(before.history.at(-1)?.period,'2026-Q1');assert.equal(after.history.at(-1)?.period,'2026-Q2');assert.equal(before.forecast[0].period,'2026-Q2');
});
test('QoQ and YoY use differenced quarterly history',()=>{
  const r=run().lastObservedComparison;assert.equal(r.value,66);assert.equal(r.previousValue,64.3);assert.equal(r.yearAgoValue,67.7);assert.equal(r.qoqPercent?.toFixed(2),'2.64');assert.equal(r.yoyPercent?.toFixed(2),'-2.51');
});
test('all three methods and four horizons share six fixed evaluation targets',()=>{
  const r=run();assert.equal(r.backtest.methods.length,12);assert.equal(r.backtest.methods.every(m=>m.n===6),true);assert.equal(r.backtest.points.length,6);assert.equal(r.backtest.points[0].period,'2025-Q1');assert.equal(r.metrics.mae,3.6);assert.equal(r.backtest.methods.find(m=>m.id==='previous_quarter'&&m.horizon===1)?.mae,1.31666667);
});
test('strong reserve control is reported honestly for every basin',()=>{
  const expected={baltic:[2.74,1.74,1.08],azov:[5.7,4.56,4.16],far_east:[2.84,2.24,1.1]};
  for(const p of run().policyComparison){assert.deepEqual([p.base,p.forecastChoice,p.alwaysReserve],expected[p.basin as BasinId]);assert.equal(p.windows,5);assert.equal(p.alwaysReserveCount,5);assert.equal(p.reservePlacementUsesForecast,true);assert.ok(p.selectedReserveCount<=p.alwaysReserveCount)}
});
test('two simultaneous gaps require quarter-specific resources',()=>{
  const r=run({capacity:50});assert.ok(r.requiredReserve.byPeriod.every(x=>x>0));assert.equal(r.requiredReserve.singleSlotEnough,false);assert.equal(r.requiredReserve.total,r.requiredReserve.byPeriod.reduce((a,b)=>a+b,0));
});
test('strict validation rejects bad types, impossible dates, nonfinite and extreme values',()=>{
  for(const overrides of [{capacity:null},{capacity:'68'},{capacity:NaN},{capacity:Infinity},{capacity:0},{capacity:1001},{repairLoss:69},{shockPercent:-101},{horizon:5},{horizon:1.5},{reserveLeadDays:-1},{allowMove:'true'},{asOf:'2026-02-30'},{asOf:'2026-2-01'},{dataMode:'unknown'},{basin:'unknown'}])assert.throws(()=>validateInput({...DEMO_INPUT,...overrides}),{name:'ValidationError'});
  for(const raw of [null,[],42,'test'])assert.throws(()=>validateInput(raw),{name:'ValidationError'});
  assert.deepEqual(validateInput(DEMO_INPUT),DEMO_INPUT);
});
test('engine never mutates the dataset or caller input',()=>{
  const before=JSON.stringify(dataset),input={...DEMO_INPUT};run();calculateScenario(dataset,input);assert.equal(JSON.stringify(dataset),before);assert.deepEqual(input,DEMO_INPUT);
});
