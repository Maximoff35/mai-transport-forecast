import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {getDataset,parsePublication} from '../lib/sources';
import {MONTHLY_PUBLICATIONS,VERIFIED_DATASET} from '../lib/seed';

const fixtures = ['Q1','04','05','Q2'].map(month => readFileSync(`data/ampt-2026-${month}.html`,'utf8'));

test('primary HTML proves basin coverage, date, cumulative figures and monthly subtraction',()=>{
  for (let i=0;i<fixtures.length;i++) {
    const actual=parsePublication(fixtures[i],MONTHLY_PUBLICATIONS[i].period);
    assert.deepEqual(actual.values,MONTHLY_PUBLICATIONS[i].values);
    assert.equal(actual.publishedOn,MONTHLY_PUBLICATIONS[i].publishedOn);
  }
  assert.equal(VERIFIED_DATASET.basins.baltic.length,58);
  assert.equal(VERIFIED_DATASET.basins.baltic.at(-1)?.value,66);
  assert.deepEqual(VERIFIED_DATASET.monthly.baltic.map(row=>row.value),[21.6,22.5,21.9]);
  for (const basin of ['baltic','azov','far_east'] as const) {
    assert.equal(Math.round(VERIFIED_DATASET.monthly[basin].reduce((sum,row)=>sum+row.value,0)*10)/10,VERIFIED_DATASET.basins[basin].at(-1)?.value);
    for (const row of VERIFIED_DATASET.monthly[basin]) assert.ok(VERIFIED_DATASET.sources.some(source=>source.url===row.sourceUrl && source.publishedOn===row.publishedOn));
  }
});

test('parser refuses wrong period, missing basin, duplicated total, wrong unit and invalid publication date',()=>{
  assert.throws(()=>parsePublication(fixtures[1],'2026-05'),/Заголовок/);
  assert.throws(()=>parsePublication(fixtures[1].replaceAll('Балтийского','OTHER'),'2026-04'),/трёх бассейнов/);
  assert.throws(()=>parsePublication(fixtures[1]+'<p>Грузооборот морских портов Балтийского бассейна составил 85,9 млн тонн.</p>','2026-04'),/трёх бассейнов/);
  assert.throws(()=>parsePublication(fixtures[1].replaceAll('85,9','85,9 тыс'),'2026-04'),/трёх бассейнов/);
  assert.throws(()=>parsePublication(fixtures[1].replace('14.05.2026','31.02.2026'),'2026-04'),/дата/);
});

test('dataset requests never fetch upstream and return an isolated snapshot', async () => {
  const fetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error('Unexpected upstream request'); };
    const snapshot = await getDataset({mode: 'live', refresh: true});
    assert.equal(calls, 0);
    assert.equal(snapshot.snapshot.status, 'snapshot');
    assert.match(snapshot.snapshot.message, /CSV/);
    snapshot.basins.baltic[0].value = 999;
    assert.equal((await getDataset()).basins.baltic[0].value, 46.6);
  } finally {
    globalThis.fetch = fetch;
  }
});
