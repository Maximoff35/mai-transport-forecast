'use client';

import {useState} from 'react';
import {CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import records from '../../data/basin-capacities.json';
import nationalCapacities from '../../data/national-capacities.json';
import nationalCargo from '../../data/national-annual.json';
import {BASINS, type BasinId} from '../../lib/contracts';
import {number} from './data-panel';

export function CapacityEvidence() {
  const [basin, setBasin] = useState<BasinId>('baltic');
  const years = Array.from({length: 15}, (_, i) => 2012 + i);
  const basinRows = years.map(year => ({year, record: records.find(row => row.basin === basin && row.year === year)}));
  const nationalRows = nationalCargo.filter(row => row.year >= 2000).map(row => ({
    year: row.year, cargo: row.value,
    capacity: nationalCapacities.find(point => point.year === row.year)?.annualCapacity ?? null,
  }));
  return <section className="section capacity-evidence" id="capacity-sources">
    <div className="section-heading"><div><h2>Мощности из опубликованных документов</h2><p>Годовые показатели бассейнов и отдельный ряд по всей России. У каждого числа есть источник.</p></div></div>
    <div className="panel detail-panel">
      <div className="capacity-evidence-heading"><div><h3>Бассейны: подтверждённые значения и пробелы</h3><p>Найдено {records.length} значений по трём бассейнам. Точного непрерывного ряда на все годы пока нет.</p></div>
        <label>Бассейн мощности<select value={basin} onChange={event => setBasin(event.currentTarget.value as BasinId)}>{Object.entries(BASINS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      </div>
      <p className="capacity-explanation">Это установленная годовая мощность. Для реконструкции используем её четверть как квартальный эквивалент. Реальная доступность в квартале зависит от оборудования, специализации грузов и ограничений подходов.</p>
      <div className="capacity-chart"><ResponsiveContainer width="100%" height={235} minWidth={0}>
        <LineChart data={basinRows.map(({year, record}) => ({year, capacity: record?.annualCapacity ?? null}))} margin={{top: 15, right: 25, bottom: 4, left: 0}} accessibilityLayer>
          <CartesianGrid vertical={false} strokeDasharray="3 4"/><XAxis dataKey="year" minTickGap={24} tick={{fontSize: 11}}/><YAxis domain={[0, 'auto']} width={55} tick={{fontSize: 11}}/>
          <Tooltip formatter={value => [`${number(Number(value))} млн т/год`, 'Опубликованная мощность']}/>
          <Line dataKey="capacity" stroke="#254e6b" strokeWidth={3} dot={{r: 5}} connectNulls={false} isAnimationActive={false}/>
        </LineChart>
      </ResponsiveContainer></div>
      <p className="capacity-explanation">Разрыв линии означает отсутствие подтверждённого значения. Между известными годами мощность не интерполируем и не переносим автоматически.</p>
      <div className="table-scroll"><table><thead><tr><th>Год применения в расчёте</th><th>Год исходного показателя</th><th>Мощность, млн т/год</th><th>Эквивалент за квартал, млн т</th><th>Подтверждение</th></tr></thead><tbody>
        {basinRows.map(({year, record}) => <tr key={year}><td>{year}</td><td>{record?.measuredYear ?? '—'}</td><td>{record ? number(record.annualCapacity, 1) : 'Нет подтверждённых данных'}</td><td>{record ? number(record.annualCapacity / 4, 2) : '—'}</td><td>{record ? <><a href={`${record.sourceUrl}#page=${record.sourcePage}`} target="_blank" rel="noreferrer">{record.sourceUrl.includes('rosmorport.ru') ? 'Росморпорт' : 'Счётная палата'}, стр. {record.sourcePage}</a><br/><a href={record.localSourceUrl} target="_blank" rel="noreferrer">Копия документа в проекте</a></> : 'Окна этого года пропускаются'}</td></tr>)}
      </tbody></table></div>
      <p className="capacity-explanation">Годовые базы 2011 и 2012 относим к началу следующих годов для реконструкции. Эти даты не являются установленными датами публикации. Документы могут выходить позже исторического решения, поэтому это реконструкция условий мощности.</p>
    </div>
    <div className="panel detail-panel capacity-national">
      <h3>Россия целиком: как росли мощность и перевалка</h3><p className="capacity-explanation">Млн т в год. Мощность относится к концу указанного года. Общероссийские значения не подменяют мощность отдельного бассейна.</p>
      <div className="legend"><span><i className="navy-dot"/>Установленная мощность</span><span><i className="teal-dot"/>Фактическая перевалка</span></div>
      <ResponsiveContainer width="100%" height={270} minWidth={0}><LineChart data={nationalRows} margin={{top: 15, right: 25, bottom: 4, left: 0}} accessibilityLayer>
        <CartesianGrid vertical={false} strokeDasharray="3 4"/><XAxis dataKey="year" minTickGap={30} tick={{fontSize: 11}}/><YAxis domain={[0, 'auto']} width={55} tick={{fontSize: 11}}/>
        <Tooltip formatter={(value, name) => [`${number(Number(value))} млн т/год`, name === 'capacity' ? 'Мощность' : 'Перевалка']}/>
        <Line dataKey="capacity" stroke="#254e6b" strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={false}/><Line dataKey="cargo" stroke="#12796c" strokeWidth={2.5} dot={false} isAnimationActive={false}/>
      </LineChart></ResponsiveContainer>
      <p className="capacity-explanation"><a href={nationalCapacities[0].sourceUrl} target="_blank" rel="noreferrer">АМТП: мощности России за 2000–2024 годы</a> · <a href={nationalCapacities[0].localSourceUrl} target="_blank" rel="noreferrer">Копия графика в проекте</a>. Источники фактической перевалки сохранены в годовом архиве. Значение мощности за 2025 год в этом документе отсутствует.</p>
    </div>
  </section>;
}
