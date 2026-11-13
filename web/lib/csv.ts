import {type BasinId,type HistoricalDataset,type ImportPreview,type Observation,moscowDate} from './contracts';
import {VERIFIED_DATASET} from './seed';

const IDS:BasinId[]=['baltic','azov','far_east'];
const LEGACY={baltic:'baltic_ytd_million_tonnes',azov:'azov_black_sea_ytd_million_tonnes',far_east:'far_east_ytd_million_tonnes'};
const MAX_BYTES=2*1024*1024;
const MAX_ROWS=10_000;
export class CsvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function fail(message: string): never {
  throw new CsvValidationError(message);
}
const round = (value: number) => Math.round(value * 1e9) / 1e9;
const periodIndex = (period: string) => Number(period.slice(0, 4)) * 4 + Number(period.at(-1)) - 1;
const fromIndex = (index: number) => `${Math.floor(index / 4)}-Q${index % 4 + 1}`;

function text(value: unknown, label: string, max = 1000): string {
  if (typeof value !== 'string' || value.length > max) fail(`Некорректное поле «${label}».`);
  return value;
}

function periodEnd(period: string): string {
  const year = Number(period.slice(0, 4));
  const quarter = Number(period.at(-1));
  return new Date(Date.UTC(year, quarter * 3, 0)).toISOString().slice(0, 10);
}

function readPeriod(value: unknown, today: string): string {
  const raw = text(value, 'quarter', 7).trim();
  const period = raw.replace(/^(\d{4})Q([1-4])$/, '$1-Q$2');
  if (!/^20\d{2}-Q[1-4]$/.test(period)) fail(`Квартал «${raw}» должен иметь вид 2026-Q3.`);
  if (periodEnd(period) > today) fail(`Квартал ${period} ещё не завершён. Загрузите фактические данные после его окончания.`);
  return period;
}

function readDate(value: unknown, label: string, today: string): string {
  const date = text(value, label, 10);
  const parsed = new Date(date + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== date || date > today) {
    fail(`Некорректная дата ${label}: «${date}».`);
  }
  return date;
}

function readUrl(value: unknown): string {
  const url = text(value, 'source_url', 2000).trim();
  if (!url) return '';
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { fail('source_url должен быть корректной http(s) ссылкой.'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail('source_url должен быть http(s) ссылкой без логина и пароля.');
  }
  return url;
}

function readVolume(value: unknown, label: string): number {
  if (typeof value === 'string') {
    const volume = value.trim().replace(',', '.');
    if (!/^\d+(?:\.\d+)?$/.test(volume)) fail(`«${label}» должен содержать неотрицательное число.`);
    value = Number(volume);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    fail(`«${label}» вне допустимого числового диапазона.`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Некорректный объект ${label}.`);
  return value as Record<string, unknown>;
}

function ensureAfterPeriod(period: string, publishedOn: string) {
  if (publishedOn < periodEnd(period)) fail(`Дата публикации ${publishedOn} раньше окончания ${period}.`);
}

function datasetVersion(basins: HistoricalDataset['basins']): string {
  const observations = JSON.stringify(basins);
  let hash = 2166136261;
  for (let i = 0; i < observations.length; i++) {
    hash = Math.imul(hash ^ observations.charCodeAt(i), 16777619);
  }
  return `csv-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Validate client-held data on every calculation; client labels never establish primary-source verification. */
export function validateUploadedDataset(raw:unknown):HistoricalDataset {
  const today = moscowDate();
  const obj=record(raw,'dataset'),basins=record(obj.basins,'basins');
  const safe=structuredClone(VERIFIED_DATASET);
  let count=0;
  for(const id of IDS){
    const rows=basins[id];if(!Array.isArray(rows)||!rows.length)fail(`Нужна история бассейна ${id}.`);
    count+=(rows as unknown[]).length;if(count>MAX_ROWS)fail('В наборе не может быть больше 10000 наблюдений.');
    const seen=new Set<string>();
    safe.basins[id]=(rows as unknown[]).map(value=>{
      const row=record(value,'observation'),p=readPeriod(row.period,today),publishedOn=readDate(row.publishedOn,'publishedOn',today);
      ensureAfterPeriod(p,publishedOn);
      if(seen.has(p))fail(`Повтор квартала ${id}:${p}.`);seen.add(p);
      const result:Observation={period:p,value:readVolume(row.value,`${id}:${p}`),publishedOn,sourceUrl:readUrl(row.sourceUrl)};
      if(row.cumulative!==undefined){result.cumulative=readVolume(row.cumulative,'cumulative');if(result.cumulative<result.value)fail(`Накопленный итог меньше квартала ${id}:${p}.`);}
      return result;
    }).sort((a,b)=>a.period.localeCompare(b.period));
    for(const verified of VERIFIED_DATASET.basins[id]){
      const existing=safe.basins[id].find(row=>row.period===verified.period);
      if(!existing||Math.abs(existing.value-verified.value)>1e-8)fail(`Проверенное наблюдение ${id}:${verified.period} отсутствует или изменено. Импорт добавляет историю без перезаписи проверенных фактов.`);
      Object.assign(existing,verified);
    }
  }
  // Imported quarterly CSV cannot alter independently checked monthly observations.
  safe.monthly=structuredClone(VERIFIED_DATASET.monthly);
  const imported = IDS.flatMap(id => safe.basins[id].filter(row =>
    !VERIFIED_DATASET.basins[id].some(base => base.period === row.period)));
  if (!imported.length) return safe;

  for (const id of IDS) {
    const series = safe.basins[id];
    for (const row of series) {
      if (row.cumulative === undefined) continue;
      if (VERIFIED_DATASET.basins[id].some(base => base.period === row.period)) continue;
      const previous = series.find(item => item.period === fromIndex(periodIndex(row.period) - 1));
      const priorCumulative = row.period.endsWith('Q1') ? 0 : previous?.cumulative;
      if (priorCumulative === undefined || Math.abs(row.cumulative - priorCumulative - row.value) > 1e-8 ||
          (!row.period.endsWith('Q1') && previous && previous.publishedOn > row.publishedOn)) {
        fail(`Накопленный итог не согласуется с квартальным значением ${id}:${row.period}.`);
      }
    }
  }
  const allPeriods = IDS.map(id => new Set(safe.basins[id].map(row => row.period)));
  const lastCommon = [...allPeriods[0]].filter(p => allPeriods.every(periods => periods.has(p))).at(-1)!;
  const stamp = new Date().toISOString();
  safe.snapshot = {
    ...safe.snapshot,
    version: datasetVersion(safe.basins),
    checkedAt: stamp,
    lastPeriod: lastCommon,
    sourceLabel: 'CSV аналитика и проверенная история АМТП',
    message: 'Новые строки CSV требуют проверки источников. Дата первичной публикации относится к проверенному срезу АМТП.',
  };
  const sourceByPeriod = new Map(imported.map(row => [`${row.period}|${row.sourceUrl}|${row.publishedOn}`, row]));
  safe.sources=[...VERIFIED_DATASET.sources,...Array.from(sourceByPeriod.values(), row=>({url:row.sourceUrl,title:`CSV аналитика: ${row.period}`,publishedOn:row.publishedOn,period:row.period,kind:'secondary' as const,verified:false}))];
  safe.warnings=[...VERIFIED_DATASET.warnings,'Новые кварталы из CSV введены аналитиком; приложение не подтверждает их операторское происхождение и точность.'];
  return safe;
}

/** RFC-style quoted cells; comma, semicolon or tab are selected from the header, never decimal values. */
function cells(input:string,delimiter:string):string[][] {
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
  for(let i=0;i<input.length;i++){
    const ch=input[i];
    if(quoted){if(ch==='"'){if(input[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=ch;continue;}
    if(ch==='"'){if(cell||closed)fail('Кавычки допустимы только в начале поля CSV.');quoted=true;}
    else if(ch===delimiter){row.push(cell);cell='';closed=false;}
    else if(ch==='\r'||ch==='\n'){if(ch==='\r'&&input[i+1]==='\n')i++;row.push(cell);if(row.some(s=>s.trim()))rows.push(row);row=[];cell='';closed=false;}
    else {if(closed&&!/\s/.test(ch))fail('После закрывающей кавычки должен идти разделитель.');if(!closed)cell+=ch;}
    if(rows.length>MAX_ROWS)fail('CSV содержит больше 10000 строк.');
  }
  if(quoted)fail('В CSV не закрыта кавычка.');
  row.push(cell);if(row.some(s=>s.trim()))rows.push(row);
  return rows;
}

export function findMissingPeriods(dataset:HistoricalDataset):string[]{
  const result:string[]=[];
  const last=Math.max(...IDS.map(id=>periodIndex(dataset.basins[id].at(-1)!.period)));
  for(const id of IDS){const observed=new Set(dataset.basins[id].map(row=>row.period));const first=periodIndex(dataset.basins[id][0].period);for(let i=first;i<=last;i++){const p=fromIndex(i);if(!observed.has(p))result.push(`${id}:${p}`);}}
  return result;
}

export async function parseCsv(input:string,baseDataset:HistoricalDataset=VERIFIED_DATASET):Promise<ImportPreview>{
  const today = moscowDate();
  if (typeof input !== 'string') fail('CSV должен быть текстом UTF-8.');
  const bytes = new TextEncoder().encode(input);
  if (bytes.length > MAX_BYTES) fail('CSV должен быть текстом UTF-8 размером не больше 2 МБ.');
  if (/[\uFFFD\uD800-\uDFFF]/u.test(input) || input.includes('\0')) {
    fail('CSV содержит повреждённый UTF-8 или нулевой байт. Сохраните файл в UTF-8.');
  }
  const normalized=input.replace(/^\uFEFF/,'');
  const headerLine=normalized.split(/\r?\n/)[0];
  const delimiters=[',',';','\t'].filter(d=>headerLine.includes(d));
  if(delimiters.length!==1)fail('Не удалось однозначно определить разделитель заголовка CSV (запятая, точка с запятой или табуляция).');
  const rows=cells(normalized,delimiters[0]);if(rows.length<2)fail('CSV должен содержать заголовок и хотя бы одну строку данных.');
  const header=rows.shift()!.map(s=>s.trim().toLowerCase());
  if(new Set(header).size!==header.length||header.some(s=>!s))fail('Заголовок CSV содержит пустые или повторяющиеся поля.');
  const legacy=Object.values(LEGACY).every(key=>header.includes(key));
  const hasValue=header.includes('value'),hasYtd=header.includes('ytd_value');
  if(!header.includes('quarter')||(!legacy&&(!header.includes('basin')||hasValue===hasYtd)))fail('Ожидается quarter + три *_ytd_million_tonnes либо quarter,basin,value (квартал) либо quarter,basin,ytd_value (накопленный итог).');
  const format:ImportPreview['format']=legacy?'legacy-ytd':hasYtd?'explicit-ytd':'observations';
  if(legacy&&(hasValue||hasYtd||header.includes('basin')))fail('Нельзя смешивать квартальные значения и накопленные итоги в одном CSV.');
  const allowed=new Set(['quarter','published_on','source_url',...(legacy?Object.values(LEGACY):['basin',hasYtd?'ytd_value':'value'])]);
  if(header.some(key=>!allowed.has(key)))fail(`Неизвестные колонки CSV: ${header.filter(key=>!allowed.has(key)).join(', ')}.`);
  const dataset=validateUploadedDataset(baseDataset),warnings:string[]=[];
  type Incoming={id:BasinId;period:string;value:number;publishedOn:string;sourceUrl:string};
  const incoming:Incoming[]=[];
  for(let n=0;n<rows.length;n++){
    if(rows[n].length!==header.length)fail(`Строка ${n+2}: число полей не совпадает с заголовком.`);
    const row=Object.fromEntries(header.map((key,i)=>[key,rows[n][i].trim()]));
    const p=readPeriod(row.quarter,today),publishedOn=row.published_on?readDate(row.published_on,`published_on, строка ${n+2}`,today):today;
    ensureAfterPeriod(p,publishedOn);
    if(!row.published_on)warnings.push('Для строк без published_on использована дата импорта. Это дата доступности в приложении, а не подтверждённая дата публикации.');
    const sourceUrl=readUrl(row.source_url||'');
    if(legacy){for(const id of IDS)incoming.push({id,period:p,value:readVolume(row[LEGACY[id]],`${LEGACY[id]}, строка ${n+2}`),publishedOn,sourceUrl});}
    else {if(!IDS.includes(row.basin as BasinId))fail(`Строка ${n+2}: basin должен быть baltic, azov или far_east.`);incoming.push({id:row.basin as BasinId,period:p,value:readVolume(row[hasYtd?'ytd_value':'value'],`value, строка ${n+2}`),publishedOn,sourceUrl});}
  }
  incoming.sort((a,b)=>a.period.localeCompare(b.period));
  const seen=new Map<string,Incoming>(),periods=new Set<string>(),basins=new Set<BasinId>();let rowsAdded=0;
  for(const row of incoming){
    const key=`${row.id}:${row.period}`,prior=seen.get(key);
    if(prior){if(prior.value!==row.value||prior.publishedOn!==row.publishedOn||prior.sourceUrl!==row.sourceUrl)fail(`Конфликт повторных строк CSV для ${key}.`);warnings.push(`Одинаковый повтор ${key} пропущен.`);continue;}seen.set(key,row);
    let value=row.value;
    let publishedOn = row.publishedOn;
    if(format!=='observations'&&!row.period.endsWith('Q1')){
      const previousPeriod=fromIndex(periodIndex(row.period)-1);
      const previous=dataset.basins[row.id].find(item=>item.period===previousPeriod);
      if(previous?.cumulative===undefined)fail(`Для накопленного итога ${key} не хватает накопленного итога предыдущего квартала ${row.id}:${previousPeriod}. Загрузите его или используйте явный квартальный формат value.`);
      value=round(row.value-previous.cumulative);
      if(value<0)fail(`Накопленный итог уменьшился в ${key}; нужна проверка версии данных.`);
      if (previous.publishedOn > publishedOn) {
        publishedOn = previous.publishedOn;
        warnings.push(`Для ${key} объём доступен с ${publishedOn}, когда известны оба накопленных итога.`);
      }
    }
    const existing=dataset.basins[row.id].find(item=>item.period===row.period);
    if(existing){if(Math.abs(existing.value-value)>1e-8||(format!=='observations'&&existing.cumulative!==undefined&&Math.abs(existing.cumulative-row.value)>1e-8))fail(`Конфликт ${key}: существующее значение ${existing.value}, в CSV ${value}. Перезапись запрещена.`);warnings.push(`Существующее наблюдение ${key} совпадает; повтор пропущен.`);continue;}
    dataset.basins[row.id].push({period:row.period,value,publishedOn,sourceUrl:row.sourceUrl,...(format!=='observations'?{cumulative:row.value}:{})});
    dataset.basins[row.id].sort((a,b)=>a.period.localeCompare(b.period));rowsAdded++;periods.add(row.period);basins.add(row.id);
  }
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const sha256=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const result=validateUploadedDataset(dataset);
  const missingPeriods=findMissingPeriods(result);
  if(missingPeriods.length)warnings.push(`Не хватает кварталов: ${missingPeriods.join(', ')}.`);
  result.warnings=[...new Set([...result.warnings,...warnings])];
  return {dataset:result,rowsAdded,periods:[...periods].sort(),basins:[...basins],warnings:[...new Set(warnings)],missingPeriods,sha256,format};
}
