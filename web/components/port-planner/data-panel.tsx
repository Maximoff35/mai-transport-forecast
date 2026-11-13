import {Anchor, ArrowDownToLine, Database, FileUp, X} from 'lucide-react';
import {useRef, useState} from 'react';
import Link from 'next/link';
import {BASINS, type ApiError, type HistoricalDataset, type ImportPreview} from '../../lib/contracts';

export const number = (value: number, digits = 1) => new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: digits, maximumFractionDigits: digits,
}).format(value);

export function periodLabel(period: string) {
  const match = /^(\d{4})-Q([1-4])$/.exec(period);
  if (match) return `${['I', 'II', 'III', 'IV'][Number(match[2]) - 1]} кв. ${match[1]}`;
  if (/^\d{4}-\d{2}$/.test(period)) {
    const date = new Date(`${period}-15T12:00:00Z`);
    if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat('ru-RU', {month: 'short', year: 'numeric', timeZone: 'UTC'}).format(date);
  }
  return period;
}

export const dateLabel = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? value.split('-').reverse().join('.') : value;

export function download(name: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], {type: mime}));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Brand() {
  return <Link className="brand" href="/"><span className="brand-icon"><Anchor size={22}/></span>
    <span>План мощности <small>it plow · Кейс А1</small></span>
  </Link>;
}

export function DataPanel({dataset, onApply, onReset}: {
  dataset: HistoricalDataset | null;
  onApply: (data: HistoricalDataset) => void;
  onReset: () => void;
}) {
  const [fileName, setFileName] = useState('');
  const [pending, setPending] = useState<{preview: ImportPreview; baseline: HistoricalDataset} | null>(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const reader = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const preview = pending?.preview;
  const addedRows = pending?.preview.basins.flatMap(basin => {
    const knownPeriods = new Set(pending.baseline.basins[basin].map(row => row.period));
    return pending.preview.dataset.basins[basin]
      .filter(row => !knownPeriods.has(row.period))
      .map(row => ({...row, basin}));
  }) ?? [];

  async function read(file: File) {
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    setPending(null);
    setFileName(file.name);
    setError('');
    if (file.size > 1_000_000) {
      setError('Выберите CSV размером до 1 МБ.');
      setReading(false);
      return;
    }
    setReading(true);
    try {
      const bytes = await file.arrayBuffer();
      let csv: string;
      try {
        csv = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      } catch {
        throw new Error('Сохраните файл в кодировке UTF-8 и загрузите его ещё раз.');
      }
      const response = await fetch('/api/import', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal,
        body: JSON.stringify({csv, baseDataset: dataset ?? undefined}),
      });
      const body = await response.json() as ImportPreview | ApiError;
      if ('error' in body) throw new Error(body.error.message);
      if (!response.ok) throw new Error('Не удалось проверить CSV.');
      const baseline = dataset ?? (await import('../../lib/seed')).VERIFIED_DATASET;
      if (!controller.signal.aborted) setPending({preview: body, baseline});
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не удалось прочитать файл.');
    } finally {
      if (!controller.signal.aborted) setReading(false);
    }
  }

  function cancel() {
    reader.current?.abort();
    setPending(null);
    setFileName('');
    setError('');
    setReading(false);
    if (input.current) input.current.value = '';
  }

  return <section className="panel data-panel" id="data">
    <div className="data-panel-heading">
      <div><h2><Database size={17}/> Данные для расчёта</h2>
        <p>{dataset ? 'Используется набор с вашими дополнениями.' : 'Исходный набор квартальных фактов загружен.'} Новые публикации можно добавить из CSV.</p>
      </div>
      <div className="button-group">
        <a className="button" href="/api/template"><ArrowDownToLine size={15}/> Шаблон</a>
        <button className="button primary" onClick={() => input.current?.click()}><FileUp size={15}/> Загрузить CSV</button>
      </div>
    </div>
    <input ref={input} className="sr-only" type="file" accept=".csv,text/csv" tabIndex={-1} aria-label="Выбрать CSV" onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (file) void read(file);
    }}/>
    {dataset && <button className="link-button" onClick={() => { cancel(); onReset(); }}>Вернуть исходный набор</button>}
    {reading && <p className="import-state" role="status">Проверяем {fileName}…</p>}
    {error && <p className="import-error" role="alert">{error}</p>}
    {preview && <div className="import-preview">
      <div className="data-panel-heading"><strong>Предпросмотр · {fileName}</strong><button className="icon-button" aria-label="Закрыть предпросмотр" onClick={cancel}><X size={16}/></button></div>
      <p>Новых наблюдений: <strong>{preview.rowsAdded}</strong>. {preview.basins.map(basin => BASINS[basin]).join(', ')}.</p>
      <p>Периоды: {preview.periods.map(periodLabel).join(', ') || 'нет новых периодов'}.</p>
      {addedRows.length > 0 && <div className="table-scroll import-rows">
        <table>
          <thead><tr><th>Бассейн</th><th>Квартал</th><th>Объём, млн т</th><th>Дата публикации</th></tr></thead>
          <tbody>{addedRows.slice(0, 12).map(row => <tr key={`${row.basin}-${row.period}`}>
            <td>{BASINS[row.basin]}</td><td>{periodLabel(row.period)}</td>
            <td>{number(row.value, 3)}</td><td>{dateLabel(row.publishedOn)}</td>
          </tr>)}</tbody>
        </table>
        {addedRows.length > 12 && <p>Показаны первые 12 наблюдений.</p>}
      </div>}
      {preview.missingPeriods.length > 0 && <p>Пропуски: {preview.missingPeriods.map(item => {
        const [basin, quarter] = item.split(':');
        return `${BASINS[basin as keyof typeof BASINS] || basin} · ${periodLabel(quarter || '')}`;
      }).join('; ')}.</p>}
      {preview.warnings.length > 0 && <ul>{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
      <p>После применения данные сохраняются в этом браузере. Сверьте объёмы и даты публикации с источником.</p>
      <div className="button-group"><button className="button primary" disabled={!preview.rowsAdded} onClick={() => { onApply(preview.dataset); cancel(); }}>Применить</button><button className="button" onClick={cancel}>Отменить</button></div>
    </div>}
  </section>;
}
