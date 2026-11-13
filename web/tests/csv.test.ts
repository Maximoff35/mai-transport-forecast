import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parseCsv, validateUploadedDataset} from '../lib/csv';
import {VERIFIED_DATASET} from '../lib/seed';

test('the existing ASOP CSV can be checked without duplicating verified observations', async () => {
  const csv = readFileSync('../03 Инструмент/asop-verified.csv', 'utf8');
  const preview = await parseCsv(csv);
  assert.equal(preview.format, 'legacy-ytd');
  assert.equal(preview.rowsAdded, 0);
  assert.equal(preview.warnings.length, 54);
  assert.equal(preview.dataset.snapshot.version, VERIFIED_DATASET.snapshot.version);
  assert.deepEqual(preview.dataset.basins, VERIFIED_DATASET.basins);
  assert.match(preview.sha256, /^[0-9a-f]{64}$/);
});

test('UTF-8 BOM, quoted semicolon values and one-basin updates give named gaps', async () => {
  const preview = await parseCsv('\uFEFFquarter;basin;value;published_on;source_url\r\n2026-Q3;baltic;"69,2";2026-10-15;https://example.org/statistics');
  assert.equal(preview.rowsAdded, 1);
  assert.deepEqual(preview.periods, ['2026-Q3']);
  assert.deepEqual(preview.basins, ['baltic']);
  assert.deepEqual(preview.missingPeriods, ['azov:2026-Q3', 'far_east:2026-Q3']);
  assert.equal(preview.dataset.basins.baltic.at(-1)?.value, 69.2);
  assert.equal(preview.dataset.sources.at(-1)?.verified, false);
  assert.equal(preview.dataset.snapshot.lastPeriod, '2026-Q2');
  assert.equal(validateUploadedDataset(preview.dataset).snapshot.version, preview.dataset.snapshot.version);
});

test('explicit YTD converts to quarter values and never bridges a missing predecessor', async () => {
  const preview = await parseCsv('quarter\tbasin\tytd_value\tpublished_on\n2026-Q3\tbaltic\t199.5\t2026-10-15');
  assert.equal(preview.format, 'explicit-ytd');
  assert.equal(preview.dataset.basins.baltic.at(-1)?.value, 69.2);
  assert.equal(preview.dataset.basins.baltic.at(-1)?.cumulative, 199.5);
  const backfill = structuredClone(VERIFIED_DATASET);
  delete backfill.basins.baltic.at(-1)?.cumulative;
  const invalid = 'quarter,basin,ytd_value,published_on\n2021-Q2,baltic,100,2021-07-15';
  await assert.rejects(parseCsv(invalid, backfill), {name: 'ValidationError', message: /baltic:2021-Q1/});
});

test('CSV and server-side revalidation reject malformed rows and any verified-value replacement', async () => {
  const header = 'quarter,basin,value,published_on,source_url\n';
  for (const [row, pattern] of [
    ['2026-Q2,baltic,67,2026-07-13,', /Перезапись/],
    ['2026-Q3,baltic,-1,2026-10-15,', /неотрицательное/],
    ['2026-Q3,baltic,69,2026-09-29,', /раньше окончания/],
    ['2026-Q3,baltic,69,2026-10-15,javascript:alert(1)', /http\(s\)/],
    ['2026-Q3,baltic,\uFFFD,2026-10-15,', /UTF-8/],
    ['2026-Q3,baltic,"69,2026-10-15,', /кавычка/],
  ] as const) {
    await assert.rejects(parseCsv(header + row), {name: 'ValidationError', message: pattern});
  }
  const conflicting = header + '2026-Q3,baltic,69,2026-10-15,\n2026-Q3,baltic,70,2026-10-15,';
  await assert.rejects(parseCsv(conflicting), {name: 'ValidationError', message: /Конфликт повторных/});
  const tampered = structuredClone(VERIFIED_DATASET);
  tampered.basins.baltic.at(-1)!.value = 65;
  assert.throws(() => validateUploadedDataset(tampered), {name: 'ValidationError', message: /изменено/});
});
