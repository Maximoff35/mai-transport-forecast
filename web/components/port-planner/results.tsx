import {useState} from 'react';
import {ArrowRight, CalendarDays, Database, ExternalLink, FileText, Layers3, ShieldCheck, TrendingUp} from 'lucide-react';
import {Bar, CartesianGrid, ComposedChart, LabelList, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import type {ActionId, ActionResult, ScenarioResult} from '../../lib/contracts';
import {dateLabel, number, periodLabel} from './data-panel';

const names: Record<ActionId, string> = {base: 'Исходный план', reserve: 'Резерв', move: 'Перенос ремонта'};
const ticks = {fill: '#5d7485', fontSize: 11};
const tooltip = {border: '1px solid #dce6ec', borderRadius: 8, fontSize: 12};
const grid = <CartesianGrid vertical={false} stroke="#e4ecf1" strokeDasharray="3 3"/>;
const tons = (value: unknown) => `${number(Number(value))} млн т`;
const signed = (value: number) => `${value > 0 ? '+' : ''}${number(value, 2)}%`;

function ChartLegend({items}: {items: Array<[string, string]>}) {
  return <div className="legend">{items.map(([label, color]) => <span key={label}><i className={color}/>{label}</span>)}</div>;
}

export function PlanChart({result, selected}: {result: ScenarioResult; selected: ActionResult}) {
  const rows = result.planPeriods.map((period, index) => ({
    period: periodLabel(period),
    base: result.baseLoads[index],
    scenario: result.planLoads[index],
    covered: result.planLoads[index] - selected.gaps[index],
    capacity: selected.capacities[index],
    gap: selected.gaps[index],
  }));
  return <div className="plan-chart">
    <div className="chart-heading"><strong>{result.basinLabel}</strong><span>млн т за квартал</span></div>
    <ChartLegend items={[
      ['Базовый прогноз', 'light'], ['Сценарная нагрузка', 'teal-dot'], ['Превышение', 'amber-dot'],
      [`Мощность · ${names[selected.id].toLowerCase()}${selected.available ? '' : ' (недоступно)'}`, selected.available ? 'navy-dot' : 'grey-dot'],
    ]}/>
    <div className="plan-chart-canvas"><ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <ComposedChart data={rows} margin={{top: 22, right: 24, bottom: 0, left: -22}} accessibilityLayer>
        {grid}<XAxis dataKey="period" tick={ticks} tickLine={false} axisLine={false}/><YAxis domain={[0, 'auto']} tick={ticks} tickLine={false} axisLine={false}/>
        <Tooltip formatter={value => tons(value)} contentStyle={tooltip}/>
        <Bar dataKey="base" name="Базовый прогноз" fill="#d7e4eb" radius={[4, 4, 0, 0]} maxBarSize={54} isAnimationActive={false}/>
        <Bar dataKey="covered" name="Нагрузка в пределах мощности" stackId="scenario" fill="#168d80" maxBarSize={54} isAnimationActive={false}/>
        <Bar dataKey="gap" name="Превышение" stackId="scenario" fill="#d6a45e" radius={[4, 4, 0, 0]} maxBarSize={54} isAnimationActive={false}>
          <LabelList dataKey="scenario" position="top" fill="#173c52" fontSize={13} formatter={value => number(Number(value))}/>
        </Bar>
        <Bar dataKey="capacity" name={selected.available ? 'Доступная мощность' : 'Условная мощность'}
          fill={selected.available ? '#254e6b' : '#8799a6'} radius={[4, 4, 0, 0]} maxBarSize={54} isAnimationActive={false}/>
      </ComposedChart>
    </ResponsiveContainer></div>
    <div className="quarter-labels">{rows.map(row => <p key={row.period}>
      Нагрузка <b>{number(row.scenario)}</b> · мощность <b>{number(row.capacity)}</b> · <b className={row.gap > 0 ? 'warning-text' : 'teal'}>{row.gap > 0 ? `превышение ${number(row.gap)}` : 'мощности хватает'}</b>
    </p>)}</div>
  </div>;
}

function HistoryChart({result, horizon, onHorizon}: {
  result: ScenarioResult;
  horizon: number;
  onHorizon: (value: number) => void;
}) {
  const [tab, setTab] = useState<'quarter' | 'month'>('quarter');
  const [historyWindow, setHistoryWindow] = useState('8');
  const [selectedPeriod, setSelectedPeriod] = useState('');
  const visible = historyWindow === '8' ? result.history.slice(-8) : result.history;
  const last = result.history.at(-1);
  const visibleForecast = result.forecast.filter(point => point.lead <= horizon);
  const rows = [
    ...visible.map(point => ({period: point.period, actual: point.value, base: point === last ? point.value : null, scenario: point === last ? point.value : null})),
    ...visibleForecast.map(point => ({period: point.period, actual: null, base: point.base, scenario: point.scenario})),
  ];
  const observed = result.history.find(point => point.period === selectedPeriod) ?? last;
  const forecast = visibleForecast.find(point => point.period === selectedPeriod);

  function prior(offset: number) {
    if (!observed) return undefined;
    const [year, quarter] = observed.period.split('-Q').map(Number);
    const index = year * 4 + quarter - 1 - offset;
    return result.history.find(point => point.period === `${Math.floor(index / 4)}-Q${index % 4 + 1}`);
  }

  const pastComparisons = [{label: 'К предыдущему кварталу', point: prior(1)}, {label: 'К тому же кварталу год назад', point: prior(4)}];
  return <section id="history" className="section">
    <div className="section-heading">
      <div><h2>История и прогноз перевалки</h2><p>Базовый прогноз повторяет тот же квартал прошлого года. Поправка меняет только сценарную нагрузку.</p></div>
      <div className="segmented"><button aria-pressed={tab === 'quarter'} onClick={() => setTab('quarter')}>Кварталы</button><button aria-pressed={tab === 'month'} onClick={() => setTab('month')}>Месячные факты</button></div>
    </div>
    <div className="panel detail-panel">
      {tab === 'month' ? <MonthlyFacts result={result}/> : <>
        <div className="history-toolbar">
          <ChartLegend items={[[ 'Факт', 'navy-dot'], ['Базовый прогноз', 'grey-line'], ['Сценарная нагрузка', 'teal-line']]}/>
          <div className="inline-fields">
            <label>История<select value={historyWindow} onChange={event => setHistoryWindow(event.currentTarget.value)}><option value="8">Последние 8 кварталов</option><option value="all">Все кварталы ({result.history.length})</option></select></label>
            <label>Горизонт графика<select value={horizon} onChange={event => onHorizon(Number(event.currentTarget.value))}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>{value} кв.</option>)}</select></label>
          </div>
        </div>
        <div className="history-chart"><ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={rows} margin={{top: 25, right: 25, bottom: 5, left: -15}} accessibilityLayer
            onClick={state => { if (typeof state.activeLabel === 'string') setSelectedPeriod(state.activeLabel); }}>
            {grid}<XAxis dataKey="period" tickFormatter={periodLabel} tick={ticks} tickLine={false} axisLine={false} minTickGap={14}/>
            <YAxis tick={ticks} tickLine={false} axisLine={false} domain={['auto', 'auto']}/>
            <Tooltip formatter={value => tons(value)} labelFormatter={value => periodLabel(String(value))} contentStyle={tooltip}/>
            {last && <ReferenceLine x={last.period} stroke="#94a9b8" strokeDasharray="3 4" label={{value: 'Срез фактов', position: 'top', fill: '#5d7485', fontSize: 11}}/>}
            <Line name="Факт" dataKey="actual" stroke="#254e6b" strokeWidth={2.5} dot={{r: 3, fill: '#fff'}} isAnimationActive={false}/>
            <Line name="Базовый прогноз" dataKey="base" stroke="#778c9b" strokeWidth={2.5} strokeDasharray="6 4" dot={{r: 3}} isAnimationActive={false}/>
            <Line name="Сценарная нагрузка" dataKey="scenario" stroke="#168d80" strokeWidth={2.5} strokeDasharray="2 3" dot={{r: 4, fill: '#fff'}} isAnimationActive={false}/>
          </LineChart>
        </ResponsiveContainer></div>
        <div className="observation-grid">
          <label>Выбрать квартал<select value={forecast?.period ?? observed?.period ?? ''} onChange={event => setSelectedPeriod(event.currentTarget.value)}>
            <optgroup label="Факты">{result.history.map(point => <option key={point.period} value={point.period}>{periodLabel(point.period)}</option>)}</optgroup>
            <optgroup label="Прогноз">{visibleForecast.map(point => <option key={point.period} value={point.period}>{periodLabel(point.period)} · прогноз</option>)}</optgroup>
          </select></label>
          {forecast ? <>
            <div><span>Базовый прогноз</span><strong>{tons(forecast.base)}</strong></div>
            <div><span>Сценарная нагрузка</span><strong>{tons(forecast.scenario)}</strong></div>
            <div><span>Опорный факт · {periodLabel(forecast.referencePeriod)}</span><strong>{tons(forecast.referenceValue)}</strong></div>
          </> : observed ? <>
            <div><span>Фактический объём</span><strong>{tons(observed.value)}</strong></div>
            {pastComparisons.map(({label, point}) => <div key={label}><span>{label}</span><strong>{point && point.value > 0 ? signed((observed.value / point.value - 1) * 100) : '—'}</strong>{point && <span>{periodLabel(point.period)} · {tons(point.value)}</span>}</div>)}
          </> : null}
        </div>
        <p className="chart-note">Факты по {periodLabel(result.snapshot.lastPeriod)}, опубликовано {dateLabel(result.snapshot.publicationDate)}. Пунктир показывает прогноз из этого среза, в том числе для кварталов, которые уже наступили. Горизонт графика не меняет два квартала плана.</p>
      </>}
    </div>
  </section>;
}

function MonthlyFacts({result}: {result: ScenarioResult}) {
  if (!result.monthlyHistory.length) return <div className="empty-state compact"><CalendarDays size={25}/><h3>Для этого бассейна нет помесячных фактов</h3><p>Используйте квартальную историю.</p></div>;
  return <>
    <p className="chart-note">Только опубликованные месячные объёмы. Для плана мощности применяется квартальный прогноз.</p>
    <div className="secondary-chart"><ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <ComposedChart data={result.monthlyHistory} margin={{top: 24, right: 20, left: -15, bottom: 4}} accessibilityLayer>
        {grid}<XAxis dataKey="period" tickFormatter={periodLabel} tick={ticks} axisLine={false} tickLine={false}/><YAxis domain={[0, 'auto']} tick={ticks} axisLine={false} tickLine={false}/>
        <Tooltip labelFormatter={value => periodLabel(String(value))} formatter={value => tons(value)} contentStyle={tooltip}/>
        <Bar dataKey="value" name="Факт" fill="#315a74" maxBarSize={65} radius={[4, 4, 0, 0]} isAnimationActive={false}><LabelList dataKey="value" position="top" formatter={value => number(Number(value))}/></Bar>
      </ComposedChart>
    </ResponsiveContainer></div>
    <div className="table-scroll"><table><thead><tr><th>Месяц</th><th>Объём, млн т</th><th>Опубликовано</th><th>Источник</th></tr></thead><tbody>
      {result.monthlyHistory.map(row => <tr key={row.period}><td>{periodLabel(row.period)}</td><td>{number(row.value)}</td><td>{dateLabel(row.publishedOn)}</td><td><a href={row.sourceUrl} target="_blank" rel="noreferrer">Публикация <ExternalLink size={12}/></a></td></tr>)}
    </tbody></table></div>
  </>;
}

function ActionDetails({result}: {result: ScenarioResult}) {
  const max = Math.max(1, ...result.actions.map(action => action.totalGap));
  return <section className="section" id="actions">
    <div className="section-heading"><div><h2>Что меняет каждое действие</h2><p>Меры сравниваются по суммарному превышению мощности за два квартала.</p></div></div>
    <div className="two-columns">
      <div className="panel detail-panel">
        <h3>Превышение мощности</h3><div className="bar-axis"><span>0</span><span>{number(max / 2)}</span><span>{tons(max)}</span></div>
        {result.actions.map(action => <div className={action.available ? 'gap-row' : 'gap-row blocked'} key={action.id}>
          <div className="gap-title"><strong>{names[action.id]}</strong><strong>{tons(action.totalGap)}{!action.available && ' · недоступно'}</strong></div>
          <div className="gap-track"><span style={{width: `${action.totalGap / max * 100}%`}}/>{action.totalGap === 0 && <small>Превышения нет</small>}</div>
          <div className="gap-periods">{result.planPeriods.map((period, index) => <span key={period}>{periodLabel(period)}: <b>{number(action.gaps[index])}</b></span>)}</div>
          {action.reason && <p className="chart-note">{action.reason.replace(/\d{4}-\d{2}-\d{2}/g, dateLabel)} Для сравнения показано превышение при условии, что мера выполнена.</p>}
        </div>)}
      </div>
      <div className="panel detail-panel">
        <h3>Какой резерв потребуется</h3>
        <p className="reserve-total">{tons(result.requiredReserve.total)}</p><p className="chart-note">Суммарный объём превышения в исходном плане</p>
        <div className="reserve-periods">{result.planPeriods.map((period, index) => <div key={period}><span>{periodLabel(period)}</span><strong>{tons(result.requiredReserve.byPeriod[index])}</strong></div>)}</div>
        <p>Заданный резерв <strong>{tons(result.input.reserve)}</strong> можно применить в одном квартале{result.requiredReserve.assignedPeriod && ` — ${periodLabel(result.requiredReserve.assignedPeriod)}`}.</p>
        {result.requiredReserve.total > 0 && <p className="chart-note">
          {result.requiredReserve.singleSlotEnough ? 'Превышение сосредоточено в одном квартале. Проверьте, хватает ли заданного резерва и соблюдён ли срок.' : 'Превышение есть в обоих кварталах. Нужны отдельные меры для каждого периода.'}
        </p>}
        {result.input.calendarEnabled && result.actions[1].deadline && <p className="chart-note">Крайний срок согласования резерва: <strong>{dateLabel(result.actions[1].deadline)}</strong>.</p>}
      </div>
    </div>
    <details className="panel info-details"><summary>Как влияет изменение нагрузки</summary><div className="details-body">
      <p>Условия текущего плана сохранены. Поправки показывают чувствительность результата к нагрузке.</p>
      <div className="table-scroll"><table><thead><tr><th>Поправка</th><th>Без мер, млн т</th><th>После доступной меры, млн т</th><th>Выбор</th></tr></thead><tbody>
        {result.stress.map(row => <tr key={row.shock}><td>{signed(row.shock)}</td><td>{number(row.baseGap)}</td><td>{number(row.bestGap)}</td><td>{row.recommendedId ? names[row.recommendedId] : '—'}</td></tr>)}
      </tbody></table></div>
    </div></details>
  </section>;
}

function Verification({result}: {result: ScenarioResult}) {
  const [horizon, setHorizon] = useState(1);
  const [method, setMethod] = useState('previousYear');
  const metricId = {previousYear: 'previous_year', previousQuarter: 'previous_quarter', mean2y: 'same_quarter_mean_2y'}[method];
  const metric = result.backtest.methods.find(row => row.id === metricId && row.horizon === 1);
  const comparable = result.policyComparison.filter(row => row.windows > 0);
  const reserveOutperforms = comparable.length > 0 && comparable.every(row => row.alwaysReserve < row.forecastChoice);
  return <section id="verification" className="section">
    <div className="section-heading"><div><h2>Как прогноз и действия проверили на прошлом</h2><p>Для каждого контрольного периода использовали данные, опубликованные к моменту прогноза.</p></div><ShieldCheck size={25}/></div>
    <div className="two-columns">
      <div className="panel detail-panel">
        <div className="panel-heading"><h3>Прогноз рядом с фактом</h3><label className="inline-fields">Метод<select value={method} onChange={event => setMethod(event.currentTarget.value)}>
          <option value="previousYear">Тот же квартал год назад</option><option value="previousQuarter">Последний известный квартал</option><option value="mean2y">Среднее двух лет</option>
        </select></label></div>
        <ChartLegend items={[[ 'Факт', 'navy-dot'], ['Прогноз за квартал', 'teal-line']]}/>
        {result.backtest.points.length ? <div className="secondary-chart"><ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={result.backtest.points} margin={{top: 14, right: 17, left: -17, bottom: 3}} accessibilityLayer>
            {grid}<XAxis dataKey="period" tickFormatter={periodLabel} tick={ticks} axisLine={false} tickLine={false}/><YAxis domain={['auto', 'auto']} tick={ticks} axisLine={false} tickLine={false}/>
            <Tooltip labelFormatter={value => periodLabel(String(value))} formatter={value => tons(value)} contentStyle={tooltip}/>
            <Line name="Факт" dataKey="actual" stroke="#254e6b" strokeWidth={2.5} isAnimationActive={false}/>
            <Line name="Прогноз" dataKey={method} stroke="#168d80" strokeWidth={2.5} strokeDasharray="5 4" isAnimationActive={false}/>
          </LineChart>
        </ResponsiveContainer></div> : <p className="chart-note">Пока нет сопоставимых контрольных кварталов.</p>}
        <p className="chart-note">{metric?.n ? `Для метода «${metric.label}» на горизонте 1 квартала средний размер ошибки составил ${tons(metric.mae)} по ${metric.n} контрольным кварталам. ` : ''}MAE — средняя абсолютная ошибка в млн т. Это проверка базового прогноза без пользовательской поправки. Для оценки вероятности дефицита этих данных недостаточно.</p>
      </div>
      <div className="panel detail-panel">
        <div className="panel-heading"><h3>Сравнение трёх методов</h3><label className="inline-fields">Горизонт<select value={horizon} onChange={event => setHorizon(Number(event.currentTarget.value))}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>{value} кв.</option>)}</select></label></div>
        <div className="table-scroll"><table><thead><tr><th>Метод</th><th>MAE, млн т</th><th>WAPE</th><th>Целей</th></tr></thead><tbody>
          {result.backtest.methods.filter(row => row.horizon === horizon).map(row => <tr key={row.id}><td>{row.label}</td><td>{row.n ? number(row.mae, 2) : '—'}</td><td>{row.n ? `${number(row.wape, 2)}%` : '—'}</td><td>{row.n}</td></tr>)}
        </tbody></table></div>
        <p className="chart-note">WAPE показывает отношение суммы абсолютных ошибок к сумме фактических объёмов. Сезонное правило легко проверить, а меньшая ошибка зависит от бассейна и горизонта.</p>
        <div className="formula"><strong>Базовый прогноз</strong><p>Факт того же квартала год назад.</p><strong>Сценарная нагрузка</strong><p>Прогноз × (1 + поправка / 100).</p></div>
      </div>
    </div>
    <details className="panel info-details" open>
      <summary>Сравнение с резервом во всех исторических окнах</summary>
      <div className="details-body">
        <p>Среднее фактическое превышение за два квартала, млн т. Размещение резерва в контрольном варианте также определяется прогнозом.</p>
        <div className="table-scroll"><table><thead><tr><th>Бассейн</th><th>Исходный план</th><th>Выбор по прогнозу</th><th>Резерв во всех окнах</th><th>Окон</th></tr></thead><tbody>
          {result.policyComparison.map(row => <tr key={row.basin}><td>{row.label}</td><td>{row.windows ? number(row.base, 2) : '—'}</td><td>{row.windows ? number(row.forecastChoice, 2) : '—'}</td><td>{row.windows ? number(row.alwaysReserve, 2) : '—'}</td><td>{row.windows}</td></tr>)}
        </tbody></table></div>
        <p>{reserveOutperforms ? 'Резерв во всех окнах оставил меньше превышения в каждом из сравниваемых бассейнов. ' : ''}Для оценки экономической пользы нужны стоимость мер и подтверждённые мощности.</p>
      </div>
    </details>
  </section>;
}

export function ScenarioDetails({result, visibleHorizon, onVisibleHorizon}: {
  result: ScenarioResult | null;
  visibleHorizon: number;
  onVisibleHorizon: (value: number) => void;
}) {
  if (!result) return null;
  return <>
    <HistoryChart result={result} horizon={visibleHorizon} onHorizon={onVisibleHorizon}/>
    {result.planningAvailable && <ActionDetails result={result}/>}
    <Verification result={result}/>
    <section className="section">
      <div className="section-heading"><div><h2>Из чего складывается расчёт</h2></div></div>
      <div className="flow">{[
        {icon: <Database size={20}/>, title: 'Факты', text: 'Квартальные объёмы из публикаций'},
        {icon: <TrendingUp size={20}/>, title: 'Прогноз', text: 'Прошлогодний квартал и поправка'},
        {icon: <Layers3 size={20}/>, title: 'Мощность', text: 'Доступный ресурс с учётом ремонта'},
        {icon: <CalendarDays size={20}/>, title: 'Действия', text: 'Резерв или перенос с проверкой сроков'},
      ].map((step, index) => <div key={step.title}>{step.icon}<span><strong>{step.title}</strong><small>{step.text}</small></span>{index < 3 && <ArrowRight size={16} className="flow-arrow"/>}</div>)}</div>
      <details className="panel info-details"><summary><FileText size={16}/> Расчёт по шагам</summary><div className="details-body"><ol>{result.explanationSteps.map(step => <li key={step}>{step}</li>)}</ol></div></details>
      <details className="panel info-details"><summary><Database size={16}/> Источники и дата среза</summary><div className="details-body">
        <p>Последний факт: {periodLabel(result.snapshot.lastPeriod)}. Публикация: {dateLabel(result.snapshot.publicationDate)}. Дата решения: {dateLabel(result.input.asOf)}.</p><p>{result.snapshot.message}</p>
        <div className="table-scroll"><table><thead><tr><th>Публикация</th><th>Период</th><th>Дата</th><th>Статус источника</th></tr></thead><tbody>
          {result.sources.map((source, index) => <tr key={`${source.url}-${index}`}><td>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title} <ExternalLink size={12}/></a> : source.title}</td><td>{periodLabel(source.period)}</td><td>{dateLabel(source.publishedOn)}</td><td>{source.verified ? 'Проверен' : 'Указан в CSV'}</td></tr>)}
        </tbody></table></div><p className="chart-note">Версия набора: {result.snapshot.version}</p>
      </div></details>
      <details className="panel info-details"><summary>Ограничения применения</summary><div className="details-body"><ul>
        <li>Перевалка измеряет обработанный объём. Для оценки заявок, очередей и потерь груза нужны данные оператора.</li>
        <li>Открытые данные охватывают бассейн. Для применения на терминале нужны его мощности, план ремонтов, данные о заявках и сроки согласования.</li>
        <li>Мощность, ремонт и резерв задаются пользователем. Сравнение оценивает превышение мощности. Для расчёта затрат нужны тарифы.</li>
        {result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
      </ul></div></details>
    </section>
  </>;
}
