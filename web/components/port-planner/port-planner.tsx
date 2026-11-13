'use client';

import {useEffect, useMemo, useState} from 'react';
import Link from 'next/link';
import {ArrowDownToLine, ArrowRight, CalendarDays, CircleHelp, Database, History, Info, LoaderCircle, RotateCcw, Settings2, TrendingUp, TriangleAlert} from 'lucide-react';
import {BASINS, DEMO_INPUT, moscowDate, type ActionId, type ApiError, type BasinId, type HistoricalDataset, type ScenarioInput, type ScenarioResult} from '../../lib/contracts';
import {Brand, DataPanel, dateLabel, download, number, periodLabel} from './data-panel';
import {PlanChart, ScenarioDetails} from './results';
import {ReplayPanel} from './replay-panel';
import {validateUploadedDataset} from '../../lib/csv';
import {validateInput} from '../../lib/engine';
import {CapacityEvidence} from './capacity-evidence';

const STORAGE_KEY = 'port-planner.dataset.v1';
const SCENARIO_KEY = 'port-planner.scenario.v1';
type PlannerView = 'forecast' | 'history' | 'replay' | 'data';
const pages = [
  {view: 'forecast', href: '/', label: 'Текущий прогноз', icon: TrendingUp},
  {view: 'history', href: '/history', label: 'История', icon: History},
  {view: 'replay', href: '/retrospective', label: 'Ретроспектива', icon: Settings2},
  {view: 'data', href: '/data', label: 'Данные', icon: Database},
] as const;
const introductions: Record<PlannerView, {title: string; description: string}> = {
  forecast: {title: 'Хватит ли мощности для ожидаемого груза?', description: 'Измените условия. Сравните прогноз перевалки с мощностью и выберите доступные меры.'},
  history: {title: 'История перевалки и проверка прогноза', description: 'Сравните кварталы и месячные факты. Посмотрите, как прогноз совпадал с опубликованными объёмами.'},
  replay: {title: 'Как прогноз помогает увеличить результат', description: 'Дополнительный груз, выручка и затраты в одном понятном расчёте. По умолчанию — последние три календарных года доступной истории.'},
  data: {title: 'Данные и опубликованные мощности', description: 'Добавьте новые квартальные факты из CSV и проверьте источники годовых мощностей.'},
};
const actionNames: Record<ActionId, string> = {base: 'Исходный план', reserve: 'Добавить резерв', move: 'Перенести ремонт'};

function lastCompleteQuarter(asOf: string) {
  const [year, month] = asOf.split('-').map(Number);
  const quarter = Math.floor((month - 1) / 3);
  return quarter === 0 ? `${year - 1}-Q4` : `${year}-Q${quarter}`;
}

function validate(input: ScenarioInput) {
  const errors: Record<string, string> = {};
  if (!(input.capacity >= 0.01 && input.capacity <= 1000)) errors.capacity = 'Укажите мощность от 0,01 до 1 000.';
  if (!(input.repairLoss >= 0 && input.repairLoss <= 1000) || input.repairLoss > input.capacity) errors.repairLoss = 'Потери должны быть от 0 до заданной мощности.';
  if (!(input.reserve >= 0 && input.reserve <= 1000)) errors.reserve = 'Укажите резерв от 0 до 1 000.';
  if (!(input.shockPercent >= -50 && input.shockPercent <= 50)) errors.shockPercent = 'Укажите поправку от −50 до +50%.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOf) || input.asOf < '2012-01-01' || input.asOf > '2100-12-31') errors.asOf = 'Укажите дату в пределах 2012–2100 гг.';
  for (const key of ['reserveLeadDays', 'repairLeadDays'] as const) {
    if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > 3650) errors[key] = 'Укажите целое число дней от 0 до 3 650.';
  }
  return errors;
}

function Slider({id, label, unit, value, min, max, onChange, error, help}: {
  id: string; label: string; unit: string; value: number; min: number; max: number;
  onChange: (value: number) => void; error?: string; help?: string;
}) {
  const finite = Number.isFinite(value);
  const lower = finite ? Math.min(min, value) : min;
  const upper = finite ? Math.max(max, value) : max;
  const progress = finite ? (value - lower) / (upper - lower) * 100 : 0;
  return <div className="slider-field">
    <div className="slider-heading"><label htmlFor={id}>{label}</label><span className="number-input">
      <input id={id} type="number" step="0.1" value={finite ? value : ''} onChange={event => onChange(event.currentTarget.valueAsNumber)}
        aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}/>
      <span>{unit}</span>
    </span></div>
    <input className="slider" type="range" min={lower} max={upper} step="0.1" value={finite ? value : lower} aria-label={`${label} — ползунок`}
      style={{'--progress': `${progress}%`} as React.CSSProperties} onChange={event => onChange(event.currentTarget.valueAsNumber)}/>
    <div className="slider-limits"><span>{Number.isInteger(lower) ? number(lower, 0) : lower.toLocaleString('ru-RU')}</span><span>{Number.isInteger(upper) ? number(upper, 0) : upper.toLocaleString('ru-RU')}</span></div>
    {help && <p className="slider-help">{help}</p>}
    {error && <p className="input-error" id={`${id}-error`}>{error}</p>}
  </div>;
}

type Outcome = {
  key: string;
  dataset: HistoricalDataset | null;
  result?: ScenarioResult;
  error?: string;
  fields?: Record<string, string>;
};

export default function PortPlanner({view = 'forecast'}: {view?: PlannerView}) {
  const [input, setInput] = useState<ScenarioInput>(DEMO_INPUT);
  const [dataset, setDataset] = useState<HistoricalDataset | null>(null);
  const [archiveExample, setArchiveExample] = useState(false);
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [action, setAction] = useState<{key: string; id: ActionId} | null>(null);
  const [storageMessage, setStorageMessage] = useState('');
  const [visibleHorizon, setVisibleHorizon] = useState(4);
  const [ready, setReady] = useState(false);
  const errors = useMemo(() => validate(input), [input]);
  const valid = !Object.keys(errors).length;
  const activeDataset = archiveExample ? null : dataset;
  const key = JSON.stringify([input, offline, attempt]);
  const current = outcome?.key === key && outcome.dataset === activeDataset ? outcome : null;
  const result = current?.result;
  const busy = !ready || (valid && !current);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const saved = JSON.parse(stored) as HistoricalDataset;
        if (saved?.basins?.baltic && saved?.snapshot?.version) setDataset(validateUploadedDataset(saved));
      }
    } catch {
      // A blocked or stale browser store does not affect the bundled dataset.
    }
    try {
      const storedScenario = sessionStorage.getItem(SCENARIO_KEY);
      if (storedScenario) {
        const saved = JSON.parse(storedScenario);
        setInput(validateInput(saved.input));
        setArchiveExample(saved.archiveExample === true);
        setOffline(saved.offline === true);
        if (Number.isInteger(saved.visibleHorizon) && saved.visibleHorizon >= 1 && saved.visibleHorizon <= 4) setVisibleHorizon(saved.visibleHorizon);
      } else setInput(current => ({...current, asOf: moscowDate()}));
    } catch {
      setInput(current => ({...current, asOf: moscowDate()}));
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready || !valid || (view !== 'forecast' && view !== 'history')) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        let computed: ScenarioResult;
        if (offline) {
          const [{calculateScenario}, {VERIFIED_DATASET}] = await Promise.all([import('../../lib/engine'), import('../../lib/seed')]);
          computed = calculateScenario(activeDataset ?? VERIFIED_DATASET, input);
        } else {
          const response = await fetch('/api/scenario', {
            method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal,
            body: JSON.stringify({...input, dataset: activeDataset ?? undefined}),
          });
          const body = await response.json() as ScenarioResult | ApiError;
          if ('error' in body) {
            if (!controller.signal.aborted) setOutcome({key, dataset: activeDataset, error: body.error.message, fields: body.error.fields});
            return;
          }
          if (!response.ok) throw new Error('Сервер не смог выполнить расчёт.');
          computed = body;
        }
        if (!controller.signal.aborted) setOutcome({key, dataset: activeDataset, result: computed});
      } catch (reason) {
        if (!controller.signal.aborted) setOutcome({key, dataset: activeDataset, error: reason instanceof Error ? reason.message : 'Не удалось выполнить расчёт.'});
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [input, valid, key, activeDataset, offline, ready, view]);

  useEffect(() => {
    if (!ready || !valid) return;
    try {
      sessionStorage.setItem(SCENARIO_KEY, JSON.stringify({input, archiveExample, offline, visibleHorizon}));
    } catch {
      // Calculation remains available when session storage is blocked.
    }
  }, [input, archiveExample, offline, visibleHorizon, ready, valid]);

  function update<K extends keyof ScenarioInput>(field: K, value: ScenarioInput[K]) {
    setInput(current => ({...current, [field]: value}));
  }

  function preset(shockPercent: number) {
    setArchiveExample(true);
    setInput({...DEMO_INPUT, shockPercent});
    setAttempt(value => value + 1);
  }

  function applyDataset(data: HistoricalDataset | null) {
    setDataset(data);
    setArchiveExample(false);
    setStorageMessage('');
    try {
      if (data) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      setStorageMessage('Хранилище браузера недоступно. Изменение действует в открытой вкладке.');
    }
    setAttempt(value => value + 1);
  }

  function exportResult(kind: 'json' | 'csv' | 'memo') {
    if (!result) return;
    const stem = `port-plan-${result.input.basin}-${result.input.asOf}`;
    if (kind === 'json') return download(`${stem}.json`, JSON.stringify(result, null, 2), 'application/json;charset=utf-8');
    if (kind === 'memo') return download(`${stem}.txt`, '\uFEFF' + result.memo, 'text/plain;charset=utf-8');
    const rows: unknown[][] = [
      ['Бассейн', result.basinLabel], ['Дата решения', result.input.asOf], ['Срез фактов', result.snapshot.lastPeriod],
      ['Версия набора', result.snapshot.version], ['Статус плана', result.planningUnavailableReason || 'План рассчитан'],
      ['Период', 'Базовый прогноз, млн т', 'Сценарная нагрузка, млн т', 'Действие', 'Мощность, млн т', 'Превышение, млн т', 'Доступно', 'Срок', 'Причина'],
    ];
    if (result.planningAvailable) for (const [index, period] of result.planPeriods.entries()) {
      for (const item of result.actions) {
        rows.push([period, result.baseLoads[index], result.planLoads[index], item.label, item.capacities[index], item.gaps[index], item.available ? 'Да' : 'Нет', item.deadline, item.reason]);
      }
    }
    const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    download(`${stem}.csv`, '\uFEFF' + rows.map(row => row.map(quote).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
  }

  const base = result?.actions.find(item => item.id === 'base');
  const recommended = result?.actions.find(item => item.id === result.recommendedId);
  const selected = (action?.key === key ? result?.actions.find(item => item.id === action.id) : undefined) ?? recommended;
  const blockedAlternative = recommended && result?.actions
    .filter(item => !item.available && item.totalGap < recommended.totalGap)
    .sort((a, b) => a.totalGap - b.totalGap)[0];
  const missingRecentFact = result && result.snapshot.lastPeriod < lastCompleteQuarter(result.input.asOf)
    ? lastCompleteQuarter(result.input.asOf) : null;
  const fieldError = (field: string) => errors[field] || current?.fields?.[field];

  return <>
    <header className="topbar">
      <div className="topbar-inner">
        <Brand/>
        <nav aria-label="Разделы">{pages.map(page => <Link key={page.view} href={page.href} aria-current={view === page.view ? 'page' : undefined}><page.icon size={16} aria-hidden="true"/>{page.label}</Link>)}</nav>
        {(view === 'forecast' || view === 'history') && <details className="export-menu"><summary className="button" aria-disabled={!result}><ArrowDownToLine size={15}/> Экспорт</summary>
          <div><button disabled={!result} onClick={() => exportResult('memo')}>Записка с выводами</button><button disabled={!result} onClick={() => exportResult('csv')}>Таблица расчёта · CSV</button><button disabled={!result} onClick={() => exportResult('json')}>Полный расчёт · JSON</button></div>
        </details>}
      </div>
    </header>
    <main id="overview" className={`page-${view}`}>
      <div className="intro">
        <div><div className="page-eyebrow"><span>{String(pages.findIndex(page => page.view === view) + 1).padStart(2, '0')}</span>Рабочее пространство / {pages.find(page => page.view === view)?.label}</div><h1>{introductions[view].title}</h1><p>{introductions[view].description}</p></div>
        <span className="case-label">КЕЙС А1<br/><strong>Морские бассейны<br/>России</strong></span>
      </div>
      {view === 'forecast' && <>
      <div className="workspace">
        <aside className="panel settings-panel" aria-label="Условия сценария">
          <div className="panel-heading"><h2><Settings2 size={17}/> Условия сценария</h2><button className="icon-button" aria-label="Сбросить весь пример" title="Сбросить весь пример" onClick={() => preset(0)}><RotateCcw size={16}/></button></div>
          <label className="field-label" htmlFor="basin">Территория</label>
          <select id="basin" value={input.basin} onChange={event => update('basin', event.currentTarget.value as BasinId)}>
            {Object.entries(BASINS).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
          </select>
          <div className="presets" aria-label="Архивные сценарии Балтики">{[-5, 0, 5].map(value => <button key={value} onClick={() => preset(value)}
            title="Архивный пример: Балтика, 13.11.2026, мощность 68, ремонт 4, резерв 3 млн т"
            aria-pressed={archiveExample && input.shockPercent === value && input.basin === 'baltic'}>{value === 0 ? 'Базовый' : value < 0 ? '−5%' : '+5%'}</button>)}</div>
          <Slider id="shockPercent" label="Поправка к прогнозу" unit="%" value={input.shockPercent} min={-15} max={15} error={fieldError('shockPercent')} onChange={value => update('shockPercent', value)}/>
          <Slider id="capacity" label="Мощность без ремонта" unit="млн т" value={input.capacity} min={20} max={100} error={fieldError('capacity')} onChange={value => update('capacity', value)}/>
          <Slider id="repairLoss" label="Потеря при ремонте" unit="млн т" value={input.repairLoss} min={0} max={15} help="Ремонт оборудования временно уменьшает объём обработки." error={fieldError('repairLoss')} onChange={value => update('repairLoss', value)}/>
          <Slider id="reserve" label="Доступный резерв" unit="млн т" value={input.reserve} min={0} max={15} help="Дополнительные ресурсы: например, техника или смены. В модели — прирост мощности." error={fieldError('reserve')} onChange={value => update('reserve', value)}/>
          <details className="advanced"><summary><CalendarDays size={15}/> Дата и сроки согласования</summary>
            <div className="advanced-body">
              <label>Дата решения<input type="date" value={input.asOf} min="2012-01-01" max="2100-12-31" onChange={event => update('asOf', event.currentTarget.value)}/></label>
              <div className="lead-fields">{(['reserveLeadDays', 'repairLeadDays'] as const).map((field, index) => <label key={field}>{index === 0 ? 'Резерв, дней' : 'Перенос, дней'}<input type="number" min="0" max="3650" step="1" value={Number.isFinite(input[field]) ? input[field] : ''} onChange={event => update(field, event.currentTarget.valueAsNumber)}/></label>)}</div>
              <label className="check-label"><input type="checkbox" checked={input.allowMove} onChange={event => update('allowMove', event.currentTarget.checked)}/> Рассматривать перенос ремонта</label>
              <label className="check-label"><input type="checkbox" checked={!input.calendarEnabled} onChange={event => update('calendarEnabled', !event.currentTarget.checked)}/> Меры уже согласованы заранее</label>
              <button className="link-button" onClick={() => { setArchiveExample(false); update('asOf', moscowDate()); }}>Рассчитать на сегодня</button>
            </div>
          </details>
          {[fieldError('asOf'), fieldError('reserveLeadDays'), fieldError('repairLeadDays')].filter(Boolean).map((message, index) => <p className="input-error" key={index}>{message}</p>)}
          <p className="settings-note"><Info size={14}/><span>Мощность задаётся для <strong>сценария</strong>. Опубликованные годовые мощности и источники — на странице <Link href="/data">«Данные»</Link>.</span></p>
        </aside>
        <section className="panel plan-panel" aria-label="Плановые кварталы" aria-busy={busy}>
          <div className="panel-heading"><div><p className="kicker">Два следующих полных квартала</p><h2>{result ? result.planPeriods.map(periodLabel).join(' — ') : 'Сценарий мощности'}</h2></div>
            <span className={input.calendarEnabled ? 'status-badge' : 'status-badge warning'}>{input.calendarEnabled ? `На ${dateLabel(input.asOf)}` : 'Условно: меры согласованы'}</span></div>
          {!valid ? <div className="empty-state"><TriangleAlert size={30}/><h3>Проверьте условия сценария</h3><p>Исправьте отмеченные поля. После этого расчёт обновится.</p></div>
            : busy ? <div className="empty-state"><LoaderCircle className="spin" size={30}/><h3>Считаем сценарий</h3><p>Сопоставляем прогноз и мощность. Проверяем сроки мер.</p></div>
            : current?.error ? <div className="empty-state"><TriangleAlert size={30}/><h3>Расчёт недоступен</h3><p>{current.error}</p><div className="button-group"><button className="button" onClick={() => { setOffline(false); setAttempt(value => value + 1); }}>Повторить запрос</button>{!offline && <button className="button" onClick={() => setOffline(true)}>Продолжить автономно</button>}</div></div>
            : result && !result.planningAvailable ? <div className="empty-state"><CalendarDays size={30}/><h3>Для этого плана не хватает фактов</h3><p>{result.planningUnavailableReason}</p><div className="button-group"><Link className="button primary" href="/data">Добавить факты</Link><button className="button" onClick={() => preset(0)}>Открыть архивный пример</button></div></div>
            : result && selected && base && recommended ? <>
              <PlanChart result={result} selected={selected}/>
              <div className="outcome">
                <div><span>Превышение без мер</span><strong>{number(base.totalGap)} <small>млн т</small></strong></div><ArrowRight size={22}/>
                <div><span>{input.calendarEnabled ? 'Минимум среди доступных' : 'Минимум при согласовании'}</span><strong className={result.recommendation.residualGap > 0 ? 'warning-text' : 'teal'}>{number(result.recommendation.residualGap)} <small>млн т</small></strong></div>
                <p>{recommended.id === 'base' ? base.totalGap === 0 ? 'При этих условиях мощности хватает без дополнительных мер.' : 'Доступные меры не снижают превышение.' : `${actionNames[recommended.id]}: ${result.recommendation.fullyCovered ? 'расчётное превышение закрыто.' : 'нужен дополнительный ресурс или другой график.'}`}</p>
              </div>
              <div className="required-reserve-note"><strong>Чтобы закрыть превышение:</strong> {result.planPeriods.map((period, index) => <span key={period}>{periodLabel(period)} — {number(result.requiredReserve.byPeriod[index])} млн т дополнительной мощности{index < result.planPeriods.length - 1 ? '; ' : '.'}</span>)} <span>Задано {number(input.reserve)} млн т для одного квартала.</span></div>
              <div className="action-cards" aria-label="Сценарии для сравнения на графике">{result.actions.map(item => <button key={item.id} className={item.available ? 'action-card' : 'action-card unavailable'} aria-pressed={selected.id === item.id} onClick={() => setAction({key, id: item.id})}>
                <span className="action-title">{actionNames[item.id]}{item.id === result.recommendedId && <small>{input.calendarEnabled ? 'Лучший из доступных' : 'Лучший при согласовании'}</small>}</span>
                <strong>{number(item.totalGap)} <small>{item.available ? 'млн т превышения' : 'млн т, если выполнить'}</small></strong>
                <span className="action-caption">{!item.available ? !input.allowMove && item.id === 'move' ? 'Недоступно: отключено в условиях' : item.deadline ? `Недоступно: срок истёк ${dateLabel(item.deadline)}` : 'Недоступно' : item.id === 'reserve' && item.reservePeriod ? `${periodLabel(item.reservePeriod)} · +${number(input.reserve)} млн т` : item.id === 'base' ? 'Ремонт во втором квартале' : 'Ремонт в первом квартале'}</span>
              </button>)}</div>
              <p className="decision-note">Сравниваем суммарное превышение за два квартала. Нажмите на карточку, чтобы показать её сценарий на графике.</p>
              {blockedAlternative && <p className="decision-note"><strong>Почему вариант с {number(blockedAlternative.totalGap)} млн т не рекомендован?</strong>{' '}
                {blockedAlternative.reason?.replace(/\d{4}-\d{2}-\d{2}/g, dateLabel)}
              </p>}
            </> : null}
        </section>
      </div>
      <div className="data-status">
        <span><i className={offline ? 'offline-dot' : ''}/>{offline ? 'Автономный расчёт' : 'Серверный расчёт'} · {archiveExample ? 'архивный пример' : activeDataset ? 'загруженные данные' : 'исходный CSV'}</span>
        {result && <span>Последний факт: {periodLabel(result.snapshot.lastPeriod)} · опубликован {dateLabel(result.snapshot.publicationDate)}</span>}
        {offline && <button className="link-button" onClick={() => setOffline(false)}>Вернуться к серверу</button>}
        {archiveExample && dataset && <button className="link-button" onClick={() => setArchiveExample(false)}>Вернуться к загруженным данным</button>}
        <Link href="/data">Управление данными →</Link>
      </div>
      {missingRecentFact && <div className="freshness-note"><Info size={15}/><span>Не хватает факта за {periodLabel(missingRecentFact)}. Если квартальный итог опубликован, <Link href="/data">загрузите CSV</Link>.</span></div>}
      <div className="problem-note"><CircleHelp size={18}/><p>Во время ремонта мощность снижается, и часть ожидаемого объёма может не уместиться в квартальный план. Аналитик проверяет возможное превышение и выбирает, какие меры ещё можно согласовать. Расчёт охватывает бассейн. Для расписания конкретного терминала нужны его мощности и заявки.</p></div>
      {result && <p className="chart-note">На {result.metrics.n} контрольных кварталах средний размер ошибки сезонного ориентира для горизонта {result.metrics.horizon} кв. составил {number(result.metrics.mae, 2)} млн т. Малое расчётное превышение может быть меньше ошибки прогноза. Поправки ±5% — проверка сценариев, а не доверительный интервал. <Link href="/history">Посмотреть проверку прогноза →</Link></p>}
      </>}
      {view === 'history' && <>
        <div className="panel history-selection">
          <label htmlFor="history-basin">Бассейн<select id="history-basin" value={input.basin} onChange={event => update('basin', event.currentTarget.value as BasinId)}>{Object.entries(BASINS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <span>Параметры сценария сохранены. <Link href="/">Изменить текущий прогноз →</Link></span>
        </div>
        {busy ? <div className="empty-state"><LoaderCircle className="spin" size={24}/><p>Загружаем историю и проверку прогноза…</p></div> : current?.error ? <div className="empty-state"><p>{current.error}</p><button className="button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></div> : <ScenarioDetails result={result ?? null} visibleHorizon={visibleHorizon} onVisibleHorizon={setVisibleHorizon}/>}
      </>}
      {view === 'replay' && ready && <ReplayPanel key={dataset?.snapshot.version ?? 'seed'} dataset={dataset}/>}
      {view === 'data' && <>
        {ready && <DataPanel dataset={dataset} onApply={applyDataset} onReset={() => applyDataset(null)}/>}
        {storageMessage && <p className="input-error" role="status">{storageMessage}</p>}
        <CapacityEvidence/>
      </>}
      <footer><Brand/><Link href="/">Текущий прогноз →</Link></footer>
    </main>
  </>;
}
