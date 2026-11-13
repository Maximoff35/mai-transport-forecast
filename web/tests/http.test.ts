import test from 'node:test';
import assert from 'node:assert/strict';
import { POST as scenario } from '../app/api/scenario/route';
import { GET as data } from '../app/api/data/route';
import { GET as health } from '../app/api/health/route';
import { POST as previewImport } from '../app/api/import/route';
import { DEMO_INPUT, type ApiError, type HistoricalDataset, type ImportPreview, type ScenarioResult } from '../lib/contracts';

const request = (body: string, type = 'application/json') => new Request('http://localhost/api/scenario', { method: 'POST', headers: { 'Content-Type': type }, body });

test('HTTP: snapshot calculation returns the same input and deadline-aware result', async () => {
  const response = await scenario(request(JSON.stringify(DEMO_INPUT)));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json() as ScenarioResult;
  assert.deepEqual(result.input, DEMO_INPUT);
  assert.equal(result.recommendedId, 'reserve');
  assert.equal(result.actions.find(x => x.id === 'move')?.available, false);
  assert.ok(Math.abs(result.actions[0].totalGap - 2) < 1e-8);
  assert.equal(result.recommendation.residualGap, 0);
  assert.equal(result.snapshot.status, 'snapshot');
});

test('HTTP: invalid numeric/date/boolean/enum values are rejected, never silently corrected', async () => {
  for (const patch of [{ capacity: -1 }, { repairLoss: 69 }, { shockPercent: '5' }, { asOf: '2026-02-30' }, { calendarEnabled: 'false' }, { basin: 'unknown' }, { horizon: 5 }, { dataMode: 'unknown' }]) {
    const response = await scenario(request(JSON.stringify({ ...DEMO_INPUT, ...patch })));
    assert.equal(response.status, 422, JSON.stringify(patch));
    assert.equal((await response.json() as ApiError).error.code, 'VALIDATION');
  }
});

test('HTTP: invalid JSON, unsupported content type and oversized requests have explicit errors', async () => {
  assert.equal((await scenario(request('{'))).status, 400);
  assert.equal((await scenario(request('{}', 'text/plain'))).status, 415);
  assert.equal((await scenario(request(JSON.stringify({ fill: 'x'.repeat(2_097_152) })))).status, 413);
});

test('HTTP: data endpoint distinguishes snapshot and rejects unknown mode', async () => {
  const response = await data(new Request('http://localhost/api/data?mode=snapshot'));
  assert.equal(response.status, 200);
  const dataset = await response.json() as HistoricalDataset;
  assert.equal(dataset.snapshot.lastPeriod, '2026-Q2');
  assert.equal(dataset.basins.baltic.length, 18);
  assert.equal((await data(new Request('http://localhost/api/data?mode=wrong'))).status, 422);
});

test('HTTP: health endpoint does not call the upstream source', async () => {
  const response = await health();
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, 'ok');
});

test('HTTP: preview adds a quarter, scenario uses it and the shared dataset stays intact', async () => {
  const response = await previewImport(request(JSON.stringify({
    csv: 'basin,quarter,value,published_on\nbaltic,2026-Q3,70,2026-10-13\n',
  })));
  assert.equal(response.status, 200);
  const preview = await response.json() as ImportPreview;
  assert.equal(preview.rowsAdded, 1);
  const result = await (await scenario(request(JSON.stringify({ ...DEMO_INPUT, dataset: preview.dataset })))).json() as ScenarioResult;
  assert.equal(result.history.at(-1)?.value, 70);
  assert.equal(result.history.at(-1)?.period, '2026-Q3');
  const seed = await (await data(new Request('http://localhost/api/data'))).json() as HistoricalDataset;
  assert.equal(seed.basins.baltic.at(-1)?.period, '2026-Q2');
  const bad = await previewImport(request(JSON.stringify({ csv: 'basin,quarter,value\nbaltic,2026-Q2,77' })));
  assert.equal(bad.status, 422);
  assert.match((await bad.json() as ApiError).error.message, /Конфликт/);
});
