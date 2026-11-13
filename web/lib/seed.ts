import type {BasinId, HistoricalDataset, Observation, SourceRecord} from './contracts';
import quarters from '../data/verified-quarters.json';
import monthlyManifest from '../data/monthly-manifest.json';

const keys: Record<BasinId, keyof typeof quarters[number]> = {
  baltic: 'baltic_ytd_million_tonnes',
  azov: 'azov_black_sea_ytd_million_tonnes',
  far_east: 'far_east_ytd_million_tonnes',
};
const basins = Object.fromEntries(Object.entries(keys).map(([basin, key]) => {
  let previous = 0;
  const observations = quarters.map(row => {
    if (row.quarter.endsWith('Q1')) previous = 0;
    const cumulative = Number(row[key]);
    const value = Math.round((cumulative - previous) * 10) / 10;
    previous = cumulative;
    return {period: row.quarter, value, cumulative, publishedOn: row.published_on, sourceUrl: row.source_url};
  });
  return [basin, observations];
})) as Record<BasinId, Observation[]>;

const source = (slug: string) => `https://www.morport.com/rus/news/gruzooborot-morskih-portov-rossii-za-yanvar-${slug}-2026-goda`;
export const MONTHLY_PUBLICATIONS = [
  {period:'2026-03', publishedOn:'2026-04-13', url:source('mart'), values:{baltic:64.3,azov:59.3,far_east:60.2}},
  {period:'2026-04', publishedOn:'2026-05-14', url:source('aprel'), values:{baltic:85.9,azov:83.1,far_east:83.3}},
  {period:'2026-05', publishedOn:'2026-06-10', url:source('may'), values:{baltic:108.4,azov:108.5,far_east:106.6}},
  {period:'2026-06', publishedOn:'2026-07-13', url:source('iyun'), values:{baltic:130.3,azov:132.0,far_east:132.7}},
];
const monthly = Object.fromEntries(Object.keys(keys).map(key => {
  const basin = key as BasinId;
  return [basin, MONTHLY_PUBLICATIONS.slice(1).map((row, i) => ({
    period:row.period,
    value:Math.round((row.values[basin]-MONTHLY_PUBLICATIONS[i].values[basin])*10)/10,
    cumulative:row.values[basin], publishedOn:row.publishedOn, sourceUrl:row.url,
  }))];
})) as Record<BasinId, Observation[]>;
const sources: SourceRecord[] = quarters.map(row => ({
  url:row.source_url, title:`Грузооборот морских портов России: ${row.quarter}`,
  publishedOn:row.published_on,period:row.quarter,kind:'primary',verified:true,
}));
sources.push(...MONTHLY_PUBLICATIONS.slice(1,3).map(row => ({
  url:row.url,title:`Грузооборот морских портов России, накопительно по ${row.period}`,
  publishedOn:row.publishedOn,period:row.period,kind:'primary' as const,verified:true,
})));
const verifiedAt = new Date(Math.max(...monthlyManifest.map(row => Date.parse(row.fetchedAt)))).toISOString();

export const VERIFIED_DATASET: HistoricalDataset = {
  basins, monthly, sources,
  snapshot:{
    version:'ampt-2026q2-20261113-v1',status:'snapshot',checkedAt:verifiedAt,fetchedAt:verifiedAt,
    lastPeriod:'2026-Q2',publicationDate:'2026-07-13',
    sourceLabel:'Ассоциация морских торговых портов (АМТП)',sourceUrl:source('iyun'),
    message:'Проверенный снимок: 18 кварталов, 2022–II квартал 2026; месячная история апреля–июня 2026.',
  },
  warnings:[
    'Это перевалка всего бассейна, а не спрос или загрузка отдельного терминала. Мощности и ремонт задаются пользователем как сценарные условия.',
    'Кварталы вычислены разностью накопленных итогов внутри года. Январь–март не разделён на вымышленные месяцы; месячная история подтверждена только за апрель–июнь 2026.',
    'В новостях и позднейших сравнительных PDF встречаются расхождения: Балтика 2023 и южный бассейн за I полугодие 2024. Сохранена исходная серия новостей; пересмотренные итоги не смешиваются.',
    'Исторические публикации могли редактироваться после выхода. Проверка на прошлых периодах не воспроизводит полностью архив данных, доступный в каждую дату.',
  ],
};
