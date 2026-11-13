'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BASINS, type ApiError, type BasinId, type HistoricalDataset } from '../../lib/contracts';
import { STRATEGIES, type ReplayResult } from '../../lib/replay';
import { VERIFIED_DATASET } from '../../lib/seed';
import annual from '../../data/national-annual.json';
import { dateLabel, download, number, periodLabel } from './data-panel';

const prices = [
  ['recoverablePercent', 'Доля дефицита, соответствующая дополнительным заявкам, %'],
  ['tariff', 'Тариф за обработанную тонну, ₽'],
  ['variableCost', 'Переменные затраты на тонну, ₽'],
  ['reserveCost', 'Стоимость одного назначения резерва, ₽'],
  ['moveCost', 'Дополнительные затраты на один перенос, ₽'],
] as const;
const actions = { base: 'Исходный план', reserve: 'Резерв', move: 'Перенос' };
const rubles = (value: number | null) => value === null ? '—' : `${number(value, 0)} ₽`;
const datasets = [
  ['1991–1999: стратегия Росморпорта', annual[0].sourceUrl],
  ['2000–2024: статистика АСОП', annual[9].sourceUrl],
  ['2025: годовой выпуск АСОП', annual.at(-1)!.sourceUrl],
];

export function ReplayPanel({ dataset }: { dataset: HistoricalDataset | null }) {
  const [basin, setBasin] = useState<BasinId>('baltic');
  const initialQuarters = (dataset ?? VERIFIED_DATASET).basins.baltic;
  const [first, setFirst] = useState(initialQuarters.at(-2)!.period);
  const [last, setLast] = useState(initialQuarters.at(-1)!.period);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [active, setActive] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [economy, setEconomy] = useState(false);
  const quarters = useMemo(() => (dataset ?? VERIFIED_DATASET).basins[basin].map(row => row.period), [basin, dataset]);
  const window = result?.windows[active];
  const chart = window?.periods.map((period, i) => ({
    period: periodLabel(period), forecast: window.references[i].value, actual: window.actual[i].value,
    base: window.strategies.base.capacities[i], selected: window.strategies.forecast.capacities[i],
  }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const numeric = ['capacity', 'repairLoss', 'reserve', 'reserveLeadDays', 'repairLeadDays'];
    const body = {
      basin, first, last, allowMove: form.has('allowMove'), dataset: dataset ?? undefined,
      ...Object.fromEntries(numeric.map(key => [key, Number(form.get(key))])),
      ...Object.fromEntries(prices.map(([key]) => [key, economy ? Number(form.get(key)) : null])),
    };
    setWorking(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch('/api/replay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const payload = await response.json() as ReplayResult | ApiError;
      if ('error' in payload) throw new Error(payload.error.message);
      if (!response.ok) throw new Error('Сервер не вернул расчёт.');
      setActive(payload.windows.length - 1);
      setResult(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Повторите запрос.');
    } finally {
      setWorking(false);
    }
  }

  return <section id="replay" className="replay-section">
    <h2>Ретроспектива решений</h2>
    <p>Выберите прошлый период. Для каждого двухквартального окна приложение сначала принимает решение по доступному тогда прогнозу, затем подставляет опубликованный факт.</p>
    <form className="panel replay-form" onSubmit={submit} onChange={() => setResult(null)}>
      <fieldset disabled={working}>
        <div className="replay-fields">
          <label>Бассейн<select value={basin} onChange={e => setBasin(e.target.value as BasinId)}>{Object.entries(BASINS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label>Первый квартал<select value={first} onChange={e => setFirst(e.target.value)}>{quarters.map(q => <option key={q} value={q}>{periodLabel(q)}</option>)}</select></label>
          <label>Последний квартал<select value={last} onChange={e => setLast(e.target.value)}>{quarters.map(q => <option key={q} value={q}>{periodLabel(q)}</option>)}</select></label>
        </div>
        <div className="button-group" aria-label="Быстрый выбор диапазона">
          {[3, 5, 10].map(years => <button key={years} type="button" className="button" onClick={() => {
            const end = quarters.at(-1)!;
            const minYear = Number(end.slice(0, 4)) - years + 1;
            const start = quarters.find(q => q >= `${minYear}-Q1`) ?? quarters[0];
            setFirst(start); setLast(end); setResult(null);
          }}>Последние {years} г.</button>)}
          <button type="button" className="button" onClick={() => {setFirst(quarters[0]);setLast(quarters.at(-1)!);setResult(null);}}>Весь архив</button>
        </div>
        <details>
          <summary>Мощность, ремонт и сроки</summary>
          <p>Во всех окнах используется одинаковая сценарная мощность. Ремонт запланирован на второй квартал каждого окна.</p>
          <div className="replay-fields">
            <label>Мощность, млн т/кв.<input name="capacity" type="number" required min="0.01" max="1000" step="any" defaultValue={68}/></label>
            <label>Потеря при ремонте, млн т<input name="repairLoss" type="number" required min="0" max="1000" step="any" defaultValue={4}/></label>
            <label>Резерв, млн т<input name="reserve" type="number" required min="0" max="1000" step="any" defaultValue={3}/></label>
            <label>Срок заказа резерва, дней<input name="reserveLeadDays" type="number" required min="0" max="3650" defaultValue={45}/></label>
            <label>Срок согласования переноса, дней<input name="repairLeadDays" type="number" required min="0" max="3650" defaultValue={90}/></label>
            <label className="replay-check"><input name="allowMove" type="checkbox" defaultChecked/> Разрешить перенос при соблюдении срока</label>
          </div>
        </details>
        <details>
          <summary>Экономика и окупаемость</summary>
          <p>Используйте параметры одного оператора и груза в сопоставимых ценах. Доля относится к объёму, который действительно не был бы обработан без меры. Все денежные результаты — оценка при ваших вводных.</p>
          <label className="replay-check"><input type="checkbox" checked={economy} onChange={e => setEconomy(e.target.checked)}/> Ввести экономические параметры</label>
          {economy && <div className="replay-fields">{prices.map(([key, title]) => <label key={key}>{title}<input name={key} type="number" required min="0" max={key === 'recoverablePercent' ? 100 : ['tariff', 'variableCost'].includes(key) ? 1e6 : 1e12} step="any"/></label>)}</div>}
          <p>Источники для сверки: <a href="https://www.globalports.com/ru/terminals/ust-luga-container-terminal/information-disclosure/" target="_blank" rel="noreferrer">раскрытие УЛКТ</a> и <a href="https://www.globalports.com/upload/iblock/b67/hvq174d2r1e2zqo2mjx61kyc414v369i/Prilozhenie-k-Uvedoml-1261_UK_2025_Tarify-na-perevalku-i-khranenie-gen.-gruzov-_KE_-_1_.pdf" target="_blank" rel="noreferrer">прейскурант «Глобал Портс»</a>. Например, в таблице 1 ставка для удобрений по схеме «вагон — специализированный контейнер клиента — судно» составляет 1 391 ₽/т без НДС. Она относится только к этой услуге и не подставляется в расчёт бассейна.</p>
        </details>
        <button className="button primary" type="submit">{working ? 'Считаем…' : 'Сравнить решения'}</button>
      </fieldset>
    </form>
    {error && <p className="import-error" role="alert">{error}</p>}
    {result && <div className="panel replay-output" aria-live="polite">
      <div className="data-panel-heading"><h3>{result.basin} · {periodLabel(result.first)} — {periodLabel(result.last)}</h3>
        <button type="button" className="button" onClick={() => download('retrospective.json', JSON.stringify(result, null, 2), 'application/json')}>Выгрузить расчёт</button>
      </div>
      <p>Проверено окон без пересечений: <strong>{result.windows.length}</strong>. Пропущено: <strong>{result.skipped.length}</strong>. {result.trailingQuarter && `Последний квартал ${periodLabel(result.trailingQuarter)} остался без пары.`}</p>
      {result.skipped.length > 0 && <details><summary>Почему пропущены окна</summary><ul>{result.skipped.map(row => <li key={row.first}>{periodLabel(row.first)}. {row.reason}</li>)}</ul></details>}
      {window && <>
        <label className="replay-window">Показать окно<select value={active} onChange={e => setActive(Number(e.target.value))}>{result.windows.map((item, i) => <option key={item.periods[0]} value={i}>{item.periods.map(periodLabel).join(' — ')}</option>)}</select></label>
        <p>Решение на <strong>{dateLabel(window.asOf)}</strong> · {actions[window.strategies.forecast.action]}. Расчётный дефицит <strong>{number(window.strategies.base.totalGap)} → {number(window.strategies.forecast.totalGap)} млн т</strong>.</p>
        <p>Данные на дату решения: <a href={window.origin.sourceUrl || undefined} target="_blank" rel="noreferrer">{periodLabel(window.origin.period)}</a>. {window.actions.filter(action => !action.available && action.reason).map(action => action.reason).join(' ')}</p>
        <div className="replay-chart"><ResponsiveContainer width="100%" height={270}><BarChart data={chart} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 4" vertical={false}/><XAxis dataKey="period"/><YAxis unit=" млн т" width={78}/><Tooltip/><Legend/>
          <Bar dataKey="forecast" name="Прогноз на дату решения" fill="#92a8b8"/>
          <Bar dataKey="actual" name="Фактическая перевалка" fill="#238778"/>
          <Bar dataKey="base" name="Исходная мощность" fill="#d8b278"/>
          <Bar dataKey="selected" name="Мощность после выбранной меры" fill="#274c65"/>
        </BarChart></ResponsiveContainer></div>
        <div className="table-scroll"><table><thead><tr><th>Квартал</th><th>Прогноз, млн т</th><th>Факт, млн т</th><th>Источники</th></tr></thead><tbody>{window.periods.map((period, i) => <tr key={period}><td>{periodLabel(period)}</td><td>{number(window.references[i].value)}</td><td>{number(window.actual[i].value)}</td><td>{window.references[i].sourceUrl && <a href={window.references[i].sourceUrl} target="_blank" rel="noreferrer">Опора прогноза</a>}{' · '}{window.actual[i].sourceUrl && <a href={window.actual[i].sourceUrl} target="_blank" rel="noreferrer">Публикация факта</a>}{window.actual[i].previousSourceUrl && <> · <a href={window.actual[i].previousSourceUrl} target="_blank" rel="noreferrer">Предыдущий накопленный итог</a></>}</td></tr>)}</tbody></table></div>
        <h4>Итоги выбранного диапазона</h4>
        {result.windows.length > 1 && <div className="replay-chart"><ResponsiveContainer width="100%" height={230}><LineChart data={result.windows.map(item => ({ period: item.periods[0], ...Object.fromEntries(Object.entries(item.strategies).map(([key, value]) => [key, value.totalGap])) }))}>
          <CartesianGrid strokeDasharray="3 4" vertical={false}/><XAxis dataKey="period" minTickGap={35}/><YAxis unit=" млн т" width={78}/><Tooltip/><Legend/>
          <Line dataKey="base" name={STRATEGIES.base} stroke="#9a5b15" strokeWidth={2}/>
          <Line dataKey="forecast" name={STRATEGIES.forecast} stroke="#12796c" strokeWidth={2}/>
          <Line dataKey="fixed" name={STRATEGIES.fixed} stroke="#274c65" strokeWidth={2}/>
        </LineChart></ResponsiveContainer></div>}
        <div className="table-scroll"><table><thead><tr><th>Правило</th><th>Дефицит, млн т</th><th>Снижение дефицита, млн т</th><th>Резервов</th><th>Переносов</th></tr></thead><tbody>{result.strategies.map(row => <tr key={row.id}><td>{STRATEGIES[row.id]}</td><td>{number(row.gap, 2)}</td><td>{number(row.avoidedGap, 2)}</td><td>{row.reserves}</td><td>{row.moves}</td></tr>)}</tbody></table></div>
        {result.comparison.extraFixedReserves > 0 && result.comparison.extraFixedAvoidedGap > 0 && <p>Резерв в каждом квартале ремонта сокращает дефицит ещё на <strong>{number(result.comparison.extraFixedAvoidedGap, 2)} млн т</strong> относительно выбора по прогнозу. Для этого требуется ещё <strong>{result.comparison.extraFixedReserves}</strong> назначений.</p>}
        {result.comparison.fixedReserveThresholdTons !== null && <p>Порог сравнения: дополнительное назначение окупится, если его цена ниже маржи с <strong>{number(result.comparison.fixedReserveThresholdTons, 0)} т</strong>, умноженной на подтверждённую долю дополнительно обслуживаемых заявок.</p>}
        {result.strategies[1].revenue !== null ? <div className="table-scroll"><table><thead><tr><th>Правило</th><th>Δ выручка</th><th>Δ переменные затраты</th><th>Затраты на меры</th><th>Δ операционный вклад</th><th>Порог, тонн</th></tr></thead><tbody>{result.strategies.map(row => <tr key={row.id}><td>{STRATEGIES[row.id]}</td><td>{rubles(row.revenue)}</td><td>{rubles(row.processingCost)}</td><td>{rubles(row.measureCost)}</td><td>{rubles(row.contribution)}</td><td>{row.breakEvenTons === null ? '—' : number(row.breakEvenTons, 0)}</td></tr>)}</tbody></table></div> : <p>Чтобы оценить выручку и операционный вклад, заполните блок «Экономика и окупаемость».</p>}
        <p>Факт показывает уже обработанный груз. Дефицит рассчитан по заданным мощностям. Для подтверждения денежного эффекта нужны заявки, фактические затраты и ограничения оператора. Порог окупаемости — затраты на меры, делённые на маржу с дополнительной тонны. Для всего диапазона используются одинаковые цены и мощности.</p>
        {result.comparison.forecastContributionOverFixed !== null && <p>Разница операционного вклада между выбором по прогнозу и резервом в квартале ремонта: <strong>{rubles(result.comparison.forecastContributionOverFixed)}</strong>.</p>}
      </>}
    </div>}
    <details className="panel replay-output">
      <summary>Годовая история России · 1991–2025</summary>
      <p>Перевалка всех морских портов России, млн т за год. Этот ряд показывает динамику отрасли. Квартальный прогноз и ретроспектива используют отдельный ряд по бассейнам.</p>
      <div className="replay-chart"><ResponsiveContainer width="100%" height={250}><LineChart data={annual}><CartesianGrid strokeDasharray="3 4" vertical={false}/><XAxis dataKey="year" minTickGap={35}/><YAxis width={78} unit=" млн т"/><Tooltip formatter={value => [`${value} млн т`, 'Перевалка']}/><Line dataKey="value" stroke="#12796c" strokeWidth={2} dot={false}/></LineChart></ResponsiveContainer></div>
      <ul>{datasets.map(([name, url]) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{name}</a></li>)}</ul>
    </details>
  </section>;
}
