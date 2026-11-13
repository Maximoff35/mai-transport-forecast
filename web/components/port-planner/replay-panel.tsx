'use client';

import {useEffect, useMemo, useRef, useState, type FormEvent} from 'react';
import {Calculator, ChevronDown, Info} from 'lucide-react';
import {BASINS, type ApiError, type BasinId, type HistoricalDataset} from '../../lib/contracts';
import type {ReplayResult} from '../../lib/replay';
import type {CapacityMode} from '../../lib/capacity';
import {VERIFIED_DATASET} from '../../lib/seed';
import {periodLabel} from './data-panel';
import {ReplayFinancialHeadline, ReplayResults, AnnualHistory} from './replay-results';
import './replay.css';

const economicsFields = [
  {key: 'tariff', label: 'Цена обработки тонны', unit: '₽/т', maximum: 1e6, hint: 'Сколько оператор получает за обработанную тонну.'},
  {key: 'variableCost', label: 'Затраты на обработку тонны', unit: '₽/т', maximum: 1e6, hint: 'Расходы, которые возникают при обработке дополнительной тонны.'},
  {key: 'recoverablePercent', label: 'Какая доля превышения даёт дополнительный груз', unit: '%', maximum: 100, hint: 'Какую часть расчётного превышения можно превратить в оплаченные заявки.'},
  {key: 'reserveCost', label: 'Цена дополнительной мощности за квартал', unit: '₽', maximum: 1e12, hint: 'Полная цена одного подключения заданного резерва.'},
  {key: 'moveCost', label: 'Цена одного переноса ремонта', unit: '₽', maximum: 1e12, hint: 'Дополнительные расходы на изменение графика работ.'},
] as const;
const EXAMPLE_ECONOMICS = {
  tariff: 1391,
  variableCost: 1000,
  recoverablePercent: 25,
  reserveCost: 100000000,
  moveCost: 50000000,
};

export function ReplayPanel({dataset}: {dataset: HistoricalDataset | null}) {
  const data = dataset ?? VERIFIED_DATASET;
  const initial = data.basins.baltic;
  const [basin, setBasin] = useState<BasinId>('baltic');
  const [first, setFirst] = useState(initial[0].period);
  const [last, setLast] = useState(initial.at(-1)!.period);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [economics, setEconomics] = useState(true);
  const [capacityMode, setCapacityMode] = useState<CapacityMode>('published');
  const [automaticRun, setAutomaticRun] = useState(0);
  const formElement = useRef<HTMLFormElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const quarters = useMemo(() => data.basins[basin].map(row => row.period), [basin, data]);
  useEffect(() => {
    const timer = window.setTimeout(() => formElement.current?.requestSubmit(), 0);
    return () => { window.clearTimeout(timer); request.current?.abort(); };
  }, [automaticRun]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const form = new FormData(event.currentTarget);
    const scenarioFields = ['capacity', 'repairLoss', 'reserve', 'reserveLeadDays', 'repairLeadDays'];
    const body = {
      basin, first, last, capacityMode, allowMove: form.has('allowMove'), dataset: dataset ?? undefined,
      ...Object.fromEntries(scenarioFields.map(key => [key, Number(form.get(key))])),
      ...Object.fromEntries(economicsFields.map(({key}) => [key, economics ? Number(form.get(key)) : null])),
      capacity: capacityMode === 'published' ? 68 : Number(form.get('capacity')),
    };
    setWorking(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch('/api/replay', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body), signal: controller.signal,
      });
      const payload = await response.json() as ReplayResult | ApiError;
      if ('error' in payload) throw new Error(payload.error.message);
      if (!response.ok) throw new Error('Сервер не вернул расчёт. Повторите запрос.');
      if (!controller.signal.aborted) setResult(payload);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не удалось выполнить расчёт.');
    } finally {
      if (!controller.signal.aborted) setWorking(false);
    }
  }

  function chooseRange(years: number | null) {
    const end = quarters.at(-1)!;
    const minimumYear = years === null ? null : Number(end.slice(0, 4)) - years + 1;
    setFirst(minimumYear === null ? quarters[0] : quarters.find(quarter => quarter >= `${minimumYear}-Q1`) ?? quarters[0]);
    setLast(end);
    setResult(null);
  }

  function resetExample() {
    formElement.current?.reset();
    setBasin('baltic');
    setFirst(data.basins.baltic[0].period);
    setLast(data.basins.baltic.at(-1)!.period);
    setEconomics(true);
    setCapacityMode('published');
    setError('');
    setResult(null);
    setAutomaticRun(value => value + 1);
  }

  return <section id="replay" className="replay-section">
    <div className="section-heading">
      <div><h2>Что изменилось бы с нашим прогнозом</h2><p>{capacityMode === 'published' ? 'Реконструируем прошлые условия с опубликованной годовой мощностью. История для прогноза ограничена датой решения, сведения о мощности могли появиться позднее.' : 'Проверяем прошлый период при заданной мощности. Прогноз использует известную на дату решения историю, затем результат сравнивается с фактом.'}</p></div>
      <button className="button" type="button" disabled={working} onClick={resetExample}>Сбросить пример</button>
    </div>
    {working && <p className="replay-loading" role="status">Считаем результат на всей доступной истории при выбранных условиях…</p>}
    {result && <ReplayFinancialHeadline result={result}/>}
    <form ref={formElement} className="panel replay-form" onSubmit={submit} onChange={() => {setResult(null); setError('');}}>
      <fieldset disabled={working}>
        <div className="replay-fields">
          <label>Бассейн<select value={basin} onChange={event => {
            const id = event.currentTarget.value as BasinId;
            const available = data.basins[id];
            setBasin(id);
            if (!available.some(row => row.period === first)) setFirst(available[0].period);
            if (!available.some(row => row.period === last)) setLast(available.at(-1)!.period);
          }}>{Object.entries(BASINS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label>Начало периода<select value={first} onChange={event => setFirst(event.currentTarget.value)}>{quarters.map(quarter => <option key={quarter} value={quarter}>{periodLabel(quarter)}</option>)}</select></label>
          <label>Конец периода<select value={last} onChange={event => setLast(event.currentTarget.value)}>{quarters.map(quarter => <option key={quarter} value={quarter}>{periodLabel(quarter)}</option>)}</select></label>
        </div>
        <div className="replay-capacity-mode">
          <label>Мощность в истории<select value={capacityMode} onChange={event => {
            setCapacityMode(event.currentTarget.value as CapacityMode);
            setResult(null);
            setAutomaticRun(value => value + 1);
          }}>
            <option value="published">По опубликованной годовой мощности</option>
            <option value="scenario">Условная мощность</option>
          </select></label>
          <p>{capacityMode === 'published'
            ? 'Годовую мощность из источника делим на четыре и получаем квартальный эквивалент. Для годов без данных окна остаются в диапазоне с отметкой о пропуске. Даты поздних публикаций учитываются в пояснении реконструкции.'
            : 'Одна и та же заданная мощность используется во всех прошлых кварталах.'} Ремонт, дополнительная мощность и цены задаются для сценария.</p>
        </div>
        <div className="replay-range-buttons">
          <span>Быстрый выбор</span>
          {[3, 5, 10].map(years => <button key={years} type="button" className="button" onClick={() => chooseRange(years)}>Последние {years} г.</button>)}
          <button type="button" className="button" onClick={() => chooseRange(null)}>Весь архив</button>
        </div>
        <details className="replay-assumptions">
          <summary>Условия мощности и ремонта <ChevronDown size={15}/></summary>
          <p><strong>Мощность</strong> — сколько груза можно обработать за квартал. <strong>Превышение</strong> — объём сверх этой мощности. {capacityMode === 'published' ? 'Четверть годового показателя — расчётный эквивалент. Для фактической доступности в квартале нужны сведения оператора.' : 'Во всех прошлых окнах применяются одни и те же заданные условия.'}</p>
          <div className="replay-fields">
            <label hidden={capacityMode === 'published'}>Мощность без ремонта, млн т/кв.<input name="capacity" type={capacityMode === 'published' ? 'hidden' : 'number'} required={capacityMode === 'scenario'} min="0.01" max="1000" step="any" defaultValue={68}/></label>
            <label>Снижение мощности при ремонте, млн т<input name="repairLoss" type="number" required min="0" max="1000" step="any" defaultValue={4}/></label>
            <label>Дополнительная мощность, млн т<input name="reserve" type="number" required min="0" max="1000" step="any" defaultValue={3}/></label>
          </div>
          <details className="replay-calendar">
            <summary>Сроки согласования</summary>
            <p>Ремонт изначально запланирован на второй квартал каждого окна. Прогноз помогает решить, заказать ли дополнительную мощность или перенести ремонт на первый квартал.</p>
            <div className="replay-fields">
              <label>Заказ дополнительной мощности, дней<input name="reserveLeadDays" type="number" required min="0" max="3650" defaultValue={45}/></label>
              <label>Согласование переноса ремонта, дней<input name="repairLeadDays" type="number" required min="0" max="3650" defaultValue={90}/></label>
            </div>
            <label className="replay-check"><input name="allowMove" type="checkbox" defaultChecked/> Рассматривать перенос ремонта при соблюдении срока</label>
          </details>
        </details>
        <div className="replay-economics-entry">
          <label className="replay-check"><input type="checkbox" checked={economics} onChange={event => setEconomics(event.currentTarget.checked)}/><strong>Добавить денежную оценку и выбирать меры по ожидаемому вкладу</strong></label>
          <p>Заполнен пример с тарифом 1 391 ₽/т и условными затратами. Мера выбирается по ожидаемому дополнительному вкладу после затрат.</p>
        </div>
        {economics && <details className="replay-economics">
          <summary>Параметры примера экономики · изменить</summary>
          <p><strong>Пример экономики</strong> — тариф из публикации 2025 года, затраты и сохраняемая доля — допущения. В примере 25% сокращённого превышения превращается в оплаченные тонны. Вклад с такой тонны до оплаты мер составляет 391 ₽.</p>
          <div className="replay-fields">{economicsFields.map(({key, label, unit, maximum, hint}) => <label key={key}>
            {label}, {unit}<input name={key} type="number" required min="0" max={maximum} step="any" defaultValue={EXAMPLE_ECONOMICS[key]}/><small>{hint}</small>
          </label>)}</div>
          <div className="replay-formula"><Calculator size={18}/><p>Дополнительный вклад = дополнительный оплаченный груз × (цена обработки − затраты на тонну) − затраты на меры.</p></div>
          <p>Для всего диапазона используются одинаковые цены. Заполните все поля, включая нулевые затраты, если они подтверждены.</p>
          <p><a href="https://www.globalports.com/upload/iblock/b67/hvq174d2r1e2zqo2mjx61kyc414v369i/Prilozhenie-k-Uvedoml-1261_UK_2025_Tarify-na-perevalku-i-khranenie-gen.-gruzov-_KE_-_1_.pdf" target="_blank" rel="noreferrer">Тарифная публикация «Глобал Портс», 2025</a>. Ставка 1 391 ₽/т без НДС относится к удобрениям по схеме «вагон — специализированный контейнер клиента — судно».</p>
        </details>}
        <div className="replay-submit"><button className="button primary" type="submit">{working ? 'Проверяем прошлые решения…' : 'Сравнить до и после'}</button><span>{economics ? 'Выбираем меру по ожидаемому дополнительному вкладу' : 'Выбираем меру с наименьшим ожидаемым превышением'}</span></div>
      </fieldset>
    </form>
    {error && <p className="import-error" role="alert">{error}</p>}
    {result && <ReplayResults key={`${result.first}-${result.last}-${result.basin}-${result.chosenObjective}-${result.capacityMode}`} result={result}/>}
    <details className="panel replay-context"><summary><Info size={15}/> Источники, допущения и история отрасли</summary><div>
      <p>Опубликованная перевалка используется как одинаковая нагрузка в двух вариантах. Обработанный объём рассчитывается при заданной мощности. Для подтверждения эффекта в работе оператора нужны его заявки, мощности и фактические затраты.</p>
      <details><summary>Где проверить цены на отдельную услугу</summary><p><a href="https://www.globalports.com/ru/terminals/ust-luga-container-terminal/information-disclosure/" target="_blank" rel="noreferrer">Раскрытие информации УЛКТ</a> содержит тарифные документы. Ставку нужно выбрать для своего груза и схемы обработки. Затраты на тонну и цены дополнительных мер подтверждает оператор.</p></details>
      <AnnualHistory/>
    </div></details>
  </section>;
}
