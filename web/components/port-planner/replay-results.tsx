import {useState} from 'react';
import {ArrowDownToLine, ArrowRight, CheckCircle2, CircleHelp, TriangleAlert} from 'lucide-react';
import {CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import {STRATEGIES, type ReplayResult} from '../../lib/replay';
import type {ActionId} from '../../lib/contracts';
import annual from '../../data/national-annual.json';
import {dateLabel, download, number, periodLabel} from './data-panel';

const actionNames: Record<ActionId, string> = {base: 'Сохранить исходный план', reserve: 'Добавить мощность', move: 'Перенести ремонт'};
const currency = (value: number | null) => value === null ? '—' : `${number(value, 0)} ₽`;
const volume = (value: number) => `${number(value, 2)} млн т`;
const percent = (value: number, total: number) => total > 0 ? `${number(value / total * 100, 1)}%` : '—';
const shortNumber = (value: number) => new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 3}).format(value);
function shortMoney(value: number) {
  if (Math.abs(value) >= 1e9) return `${shortNumber(value / 1e9)} млрд ₽`;
  if (Math.abs(value) >= 1e6) return `${shortNumber(value / 1e6)} млн ₽`;
  return currency(value);
}
const EPSILON = 1e-8;
type Window = ReplayResult['windows'][number];

export function ReplayFinancialHeadline({result}: {result: ReplayResult}) {
  const economics = result.economics;
  const after = result.strategies.find(row => row.id === 'forecast');
  if (!economics || !after || after.contribution === null || !result.windows.length) return null;
  return <section className="panel replay-financial-headline">
    <div className="replay-result-heading"><div><h3>Сценарный денежный результат</h3><p>{result.basin} · {periodLabel(result.windows[0].periods[0])} — {periodLabel(result.windows.at(-1)!.periods[1])}</p></div><span>Дополнительный результат к исходному плану</span></div>
    <div className="replay-financial-main">
      <div><span>Исходный план</span><strong>0 ₽</strong></div><ArrowRight size={26}/><div><span>Решения с прогнозом</span><strong className={after.contribution >= 0 ? 'replay-positive' : 'replay-negative'}>{after.contribution > 0 ? '+' : ''}{shortMoney(after.contribution)}</strong></div>
      <p>Дополнительно обслуженный объём в денежном сценарии<br/><strong>{volume((after.recoverableTons ?? 0) / 1e6)}</strong></p>
    </div>
    <div className="replay-financial-steps">
      <div><span>Дополнительная выручка</span><strong>{shortMoney(after.revenue ?? 0)}</strong></div><b>−</b>
      <div><span>Затраты на обработку</span><strong>{shortMoney(after.processingCost ?? 0)}</strong></div><b>−</b>
      <div><span>Дополнительная мощность и переносы</span><strong>{shortMoney(after.measureCost ?? 0)}</strong></div>
    </div>
    <p className="replay-summary-caption"><strong>Условия сценария.</strong> Цена обработки {currency(economics.tariff)} за тонну, затраты {currency(economics.variableCost)} за тонну, дополнительный объём составляет {number(economics.recoverablePercent, 0)}% сокращённого превышения. Один резерв стоит {shortMoney(economics.reserveCost)}, перенос — {shortMoney(economics.moveCost)}.</p>
    <p className="replay-summary-caption">Тариф по умолчанию взят из публикации 2025 года для отдельной услуги. Затраты и доля дополнительного объёма — допущения примера. При других вводных меняются выбор мер и денежный результат. Все суммы в одинаковых ценах примера без НДС, до прочих расходов и налогов.</p>
  </section>;
}

function outcomeLabel(window: Window) {
  const before = window.strategies.base.totalGap;
  const after = window.strategies.forecast.totalGap;
  if (after > before + EPSILON) return 'Превышение выросло';
  if (before <= EPSILON) return 'Мощности хватало без мер';
  if (after <= EPSILON) return 'Превышение закрыто';
  if (after < before - EPSILON) return 'Превышение уменьшилось';
  return 'Превышение осталось без изменений';
}

function initialExample(windows: Window[]) {
  const improved = windows.findLastIndex(window => window.strategies.forecast.totalGap < window.strategies.base.totalGap - EPSILON);
  return improved >= 0 ? improved : Math.max(0, windows.length - 1);
}

export function ReplayResults({result}: {result: ReplayResult}) {
  const [active, setActive] = useState(() => initialExample(result.windows));
  const before = result.strategies.find(row => row.id === 'base')!;
  const after = result.strategies.find(row => row.id === 'forecast')!;
  const fixed = result.strategies.find(row => row.id === 'fixed')!;
  const window = result.windows[active];
  let avoided = 0;
  const cumulative = [
    {period: 'До проверки', value: 0},
    ...result.windows.map(item => {
      avoided += item.strategies.base.totalGap - item.strategies.forecast.totalGap;
      return {period: item.periods[1], value: Number(avoided.toFixed(6))};
    }),
  ];
  const count = after.classificationCounts;
  const initialImproved = active === initialExample(result.windows) && window &&
    window.strategies.forecast.totalGap < window.strategies.base.totalGap - EPSILON;

  return <div className="replay-results" aria-live="polite">
    <section className="panel replay-summary">
      <div className="replay-result-heading"><div><h3>{result.basin}</h3><p>{periodLabel(result.first)} — {periodLabel(result.last)} · {result.windows.length} проверенных окон по два квартала</p></div>
        <button className="button" onClick={() => download('retrospective.json', JSON.stringify(result, null, 2), 'application/json;charset=utf-8')}><ArrowDownToLine size={15}/> Скачать расчёт</button></div>
      {!result.windows.length ? <div className="replay-empty"><TriangleAlert size={24}/><p>В этом диапазоне нет окон с достаточной историей для проверки. Расширьте период или добавьте факты.</p></div> : <>
        <p className="replay-model-label">Модель при заданной мощности · одинаковая нагрузка в вариантах до и после</p>
        <div className="replay-before-after">
          <div><span>ДО · исходный график ремонта</span><strong>{volume(before.servedVolume)}</strong><p>Груза укладывается в заданную мощность</p><b>Сверх мощности: {volume(before.gap)}</b></div>
          <ArrowRight size={28}/>
          <div><span>ПОСЛЕ · решения по прогнозу</span><strong>{volume(after.servedVolume)}</strong><p>Груза укладывается в мощность после мер</p><b>Сверх мощности: {volume(after.gap)}</b></div>
        </div>
        <div className="replay-kpis">
          <div><strong className={after.avoidedGap >= 0 ? 'replay-positive' : 'replay-negative'}>{after.avoidedGap > 0 ? '+' : ''}{volume(after.avoidedGap)}</strong><span>Изменение обслуживаемого объёма</span><small>{percent(after.avoidedGap, before.servedVolume)} к исходному варианту</small></div>
          <div><strong>{percent(after.avoidedGap, before.gap)}</strong><span>Исходного превышения устранено</span><small>{volume(before.gap)} → {volume(after.gap)}</small></div>
          <div><strong>{after.reserves} из {result.windows.length}</strong><span>Окон с заказом дополнительной мощности</span><small>Ещё {after.moves} переносов ремонта</small></div>
        </div>
        <p className="replay-summary-caption">Для проверки использовано {volume(result.totalObserved)} опубликованной перевалки. Обслуживаемый объём рассчитан как нагрузка в пределах заданной мощности.</p>
        <div className="replay-classifications">
          <div><strong>{count.noOverload}</strong><span>Мощности хватало без мер</span></div>
          <div className="replay-helpful"><strong>{count.gapClosed + count.reducedWithRemainder}</strong><span>Прогноз помог снизить превышение</span></div>
          <div className="replay-missed"><strong>{count.missed}</strong><span>Превышение осталось без улучшения</span></div>
          {count.worsened > 0 && <div className="replay-missed"><strong>{count.worsened}</strong><span>После меры стало хуже</span></div>}
        </div>
        <p className="replay-summary-caption">{after.uselessReserves} из {after.reserves} заказов дополнительной мощности не уменьшили превышение по факту. В {count.gapClosed} окнах превышение закрыто полностью, в {count.reducedWithRemainder} — уменьшено частично.</p>
      </>}
      {(result.skipped.length > 0 || result.trailingQuarter) && <details className="replay-skipped"><summary>Что не вошло в сравнение</summary><p>Пропущено {result.skipped.length} окон.{result.trailingQuarter && ` Последний квартал ${periodLabel(result.trailingQuarter)} остался без пары.`}</p><ul>{result.skipped.map(item => <li key={item.first}>{periodLabel(item.first)}. {item.reason}</li>)}</ul></details>}
    </section>
    {result.windows.length > 0 && <>
      <section className="panel replay-chart-panel">
        <div className="replay-result-heading"><div><h3>Как накапливается результат</h3><p>Дополнительный объём, который уместился бы в мощность после решений по прогнозу.</p></div><span>млн т за весь период</span></div>
        <div className="replay-chart"><ResponsiveContainer width="100%" height={245}>
          <LineChart data={cumulative} margin={{top: 15, right: 24, bottom: 4, left: 0}} accessibilityLayer>
            <CartesianGrid strokeDasharray="3 4" vertical={false}/><XAxis dataKey="period" tickFormatter={periodLabel} minTickGap={35} tick={{fontSize: 11}}/>
            <YAxis domain={['auto', 'auto']} tick={{fontSize: 11}} width={50}/><ReferenceLine y={0} stroke="#99adb9"/>
            <Tooltip labelFormatter={label => periodLabel(String(label))} formatter={value => [volume(Number(value)), 'Накопленный результат']}/>
            <Line dataKey="value" name="Дополнительный обслуживаемый объём" stroke="#12796c" strokeWidth={3} dot={false} activeDot={{r: 5}} isAnimationActive={false}/>
          </LineChart>
        </ResponsiveContainer></div>
        <p className="replay-summary-caption">Ровный участок означает, что в этих окнах дополнительный объём не появился. Это бывает, когда мощности уже хватало или выбранная мера не помогла.</p>
      </section>
      <section className="panel replay-example">
        <div className="replay-result-heading"><div><h3>Почему получилось именно так</h3><p>{initialImproved ? 'Выбран пример, в котором прогноз помог. Ниже доступны все окна, включая неудачные.' : 'Выберите любое окно и сравните решение с последующим фактом.'}</p></div></div>
        <label className="replay-window">Период для разбора<select value={active} onChange={event => setActive(Number(event.currentTarget.value))}>{result.windows.map((item, index) => <option value={index} key={item.periods[0]}>{item.periods.map(periodLabel).join(' — ')} · {outcomeLabel(item)}</option>)}</select></label>
        {window && <WindowExample window={window} economics={result.chosenObjective === 'contribution'}/>}
        <details className="replay-all-windows"><summary>Посмотреть результаты всех {result.windows.length} окон</summary><div className="table-scroll"><table>
          <thead><tr><th>Период</th><th>Сверх мощности до, млн т</th><th>После, млн т</th><th>Действие по прогнозу</th><th>Что получилось</th></tr></thead>
          <tbody>{result.windows.map(item => <tr key={item.periods[0]}><td>{item.periods.map(periodLabel).join(' — ')}</td><td>{number(item.strategies.base.totalGap, 2)}</td><td>{number(item.strategies.forecast.totalGap, 2)}</td><td>{actionNames[item.strategies.forecast.action]}</td><td>{outcomeLabel(item)}</td></tr>)}</tbody>
        </table></div></details>
      </section>
      <section className="panel replay-alternatives">
        <h3>А если добавлять мощность при каждом ремонте?</h3>
        <p>Сравниваем выбор по прогнозу с правилом «заказывать один и тот же резерв в каждом квартале ремонта».</p>
        <div className="table-scroll"><table><thead><tr><th>Правило</th><th>Укладывается в мощность, млн т</th><th>Сверх мощности, млн т</th><th>Заказов резерва</th><th>Переносов</th></tr></thead><tbody>
          {result.strategies.map(row => <tr key={row.id}><td>{STRATEGIES[row.id]}</td><td>{number(row.servedVolume, 2)}</td><td>{number(row.gap, 2)}</td><td>{row.reserves}</td><td>{row.moves}</td></tr>)}
        </tbody></table></div>
        <p>{fixed.reserves > after.reserves ? `Выбор по прогнозу потребовал на ${fixed.reserves - after.reserves} заказов резерва меньше (${percent(fixed.reserves - after.reserves, fixed.reserves)}). ` : ''}
          {fixed.gap < after.gap ? `Постоянное резервирование дополнительно закрыло бы ${volume(after.gap - fixed.gap)} превышения. ` : ''}
          {result.chosenObjective === 'gap' ? 'Чтобы сравнить затраты на эти варианты, включите денежную оценку выше.' : 'С учётом цен итог сравнения показан ниже.'}</p>
      </section>
      {result.economics && <EconomicsResult result={result}/>}
    </>}
  </div>;
}

function WindowExample({window, economics}: {window: Window; economics: boolean}) {
  const selected = window.strategies.forecast;
  const predictedBase = window.actions.find(action => action.id === 'base')!;
  const predictedSelected = window.actions.find(action => action.id === selected.action)!;
  const avoided = window.strategies.base.totalGap - selected.totalGap;
  return <div className="replay-window-content">
    <div className="replay-decision">
      <CalendarCard date={window.asOf}/>
      <div><strong>{actionNames[selected.action]}</strong><p>{window.choiceReason}</p><p>В прогнозе объём сверх мощности менялся с {volume(predictedBase.totalGap)} до {volume(predictedSelected.totalGap)}.</p>{economics && <p>Ожидаемый дополнительный вклад: <strong>{currency(window.predictedChoiceScore)}</strong>.</p>}</div>
    </div>
    <div className="table-scroll"><table><thead><tr><th>Квартал</th><th>Прогноз на дату решения, млн т</th><th>Опубликованный факт, млн т</th><th>Мощность до, млн т</th><th>После меры, млн т</th></tr></thead><tbody>
      {window.periods.map((period, index) => <tr key={period}><td>{periodLabel(period)}</td><td>{number(window.references[index].value, 2)}</td><td>{number(window.actual[index].value, 2)}</td><td>{number(window.strategies.base.capacities[index], 2)}</td><td>{number(selected.capacities[index], 2)}</td></tr>)}
    </tbody></table></div>
    <div className="replay-window-outcome">{avoided > EPSILON ? <CheckCircle2 size={20}/> : <CircleHelp size={20}/>}<p><strong>{outcomeLabel(window)}.</strong> В модели обработали бы {volume(window.strategies.base.servedVolume)} до меры и {volume(selected.servedVolume)} после неё.
      {avoided > EPSILON ? ` Дополнительный объём — ${volume(avoided)}.` : avoided < -EPSILON ? ` Обслуживаемый объём сократился на ${volume(-avoided)}.` : ' Обслуживаемый объём не изменился.'}
      {economics && ` Дополнительный вклад после подстановки факта — ${currency(selected.contribution)}.`}</p></div>
    <details><summary>Проверить источники и другие варианты</summary>
      <p>На дату решения был опубликован факт за {periodLabel(window.origin.period)}.</p>
      <div className="table-scroll"><table><thead><tr><th>Вариант</th><th>Доступность</th><th>Прогнозное превышение, млн т</th>{economics && <th>Ожидаемый вклад</th>}</tr></thead><tbody>
        {window.actions.map(action => <tr key={action.id}><td>{actionNames[action.id]}</td><td>{action.available ? 'Доступно' : action.reason}</td><td>{number(action.totalGap, 2)}</td>{economics && <td>{currency(window.predictedContributionByAction[action.id])}</td>}</tr>)}
      </tbody></table></div>
      <ul>{window.actual.map((row, index) => <li key={row.period}>{periodLabel(row.period)}. {window.references[index].sourceUrl && <a href={window.references[index].sourceUrl} target="_blank" rel="noreferrer">Источник прогноза</a>} · {row.sourceUrl && <a href={row.sourceUrl} target="_blank" rel="noreferrer">Публикация факта</a>}{row.previousSourceUrl && <> · <a href={row.previousSourceUrl} target="_blank" rel="noreferrer">Предыдущий накопленный итог</a></>}</li>)}</ul>
    </details>
  </div>;
}

function CalendarCard({date}: {date: string}) {
  return <div className="replay-decision-date"><span>Решение принято</span><strong>{dateLabel(date)}</strong></div>;
}

function EconomicsResult({result}: {result: ReplayResult}) {
  const forecast = result.strategies.find(row => row.id === 'forecast')!;
  const economics = result.economics!;
  return <section className="panel replay-money">
    <h3>Денежный результат при ваших ценах</h3>
    <p>Мера выбрана по ожидаемому вкладу до появления факта. Здесь показан результат после подстановки опубликованных объёмов.</p>
    <div className="replay-money-kpis">
      <div><span>Дополнительная выручка</span><strong>{currency(forecast.revenue)}</strong></div>
      <div><span>Обработка и меры</span><strong>{currency((forecast.processingCost ?? 0) + (forecast.measureCost ?? 0))}</strong></div>
      <div><span>Дополнительный вклад после затрат</span><strong className={(forecast.contribution ?? 0) >= 0 ? 'replay-positive' : 'replay-negative'}>{currency(forecast.contribution)}</strong></div>
    </div>
    <p>В расчёте {number(economics.recoverablePercent, 1)}% сокращённого превышения даёт дополнительный обслуживаемый объём. Цена — {currency(economics.tariff)} за тонну, затраты — {currency(economics.variableCost)} за тонну.</p>
    <div className="table-scroll"><table><thead><tr><th>Правило</th><th>Дополнительный объём денежного сценария, т</th><th>Δ выручка</th><th>Δ затраты на обработку</th><th>Затраты на меры</th><th>Δ вклад</th></tr></thead><tbody>
      {result.strategies.map(row => <tr key={row.id}><td>{STRATEGIES[row.id]}</td><td>{row.recoverableTons === null ? '—' : number(row.recoverableTons, 0)}</td><td>{currency(row.revenue)}</td><td>{currency(row.processingCost)}</td><td>{currency(row.measureCost)}</td><td>{currency(row.contribution)}</td></tr>)}
    </tbody></table></div>
    {forecast.breakEvenTons !== null ? <p>Для покрытия затрат на выбранные меры нужно обработать дополнительно {number(forecast.breakEvenTons, 0)} тонн денежного сценария.
      {forecast.breakEvenAvoidedGapTons !== null && ` При вашей доле заявок это соответствует ${number(forecast.breakEvenAvoidedGapTons, 0)} тоннам сокращённого превышения.`}</p> : <p>При этих вводных положительный порог окупаемости по дополнительным тоннам не определяется. Проверьте разницу цены и затрат.</p>}
    {result.comparison.forecastContributionOverFixed !== null && <p>Разница вклада между выбором по прогнозу и резервом при каждом ремонте: <strong>{currency(result.comparison.forecastContributionOverFixed)}</strong>.</p>}
    <details className="replay-money-assumptions"><summary>Допущения денежного расчёта</summary><ul>{result.economicAssumptions.map(assumption => <li key={assumption}>{assumption}</li>)}</ul></details>
    <p className="replay-summary-caption">Дополнительный вклад учитывает перечисленные переменные затраты и меры. Для расчёта чистой прибыли нужны остальные расходы, налоги и подтверждённые заявки оператора.</p>
  </section>;
}

export function AnnualHistory() {
  return <details className="replay-annual"><summary>Годовая история морских портов России, 1991–2025</summary>
    <p>Перевалка всех портов России, млн т за год. Расчёт решений выше использует отдельную квартальную историю бассейна.</p>
    <div className="replay-chart"><ResponsiveContainer width="100%" height={230}><LineChart data={annual} accessibilityLayer>
      <CartesianGrid vertical={false} strokeDasharray="3 4"/><XAxis dataKey="year" minTickGap={30} tick={{fontSize: 11}}/><YAxis tick={{fontSize: 11}} width={50}/><Tooltip formatter={value => [volume(Number(value)), 'Перевалка']}/><Line dataKey="value" stroke="#12796c" strokeWidth={2} dot={false} isAnimationActive={false}/>
    </LineChart></ResponsiveContainer></div>
    <ul>{[
      ['1991–1999 · стратегия Росморпорта', annual[0].sourceUrl],
      ['2000–2024 · статистика АСОП', annual[9].sourceUrl],
      ['2025 · годовой выпуск АСОП', annual.at(-1)!.sourceUrl],
    ].map(([title, url]) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{title}</a></li>)}</ul>
  </details>;
}
