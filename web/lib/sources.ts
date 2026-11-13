import type {BasinId, HistoricalDataset} from './contracts';
import {VERIFIED_DATASET} from './seed';

const BASIN_IDS: BasinId[] = ['baltic', 'azov', 'far_east'];

function plainText(html: string): string {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
    .replace(/<[^>]*>/g,' ')
    .replace(/&#(x[\da-f]+|\d+);/gi,(_, code:string) => {
      const point = code.toLowerCase().startsWith('x') ? parseInt(code.slice(1),16) : Number(code);
      return point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    })
    .replace(/&(?:nbsp|#160);/gi,' ').replace(/&amp;/gi,'&')
    .replace(/[\s\u00a0\u202f]+/g,' ').trim();
}

export interface ParsedPublication {publishedOn:string;values:Record<BasinId,number>;title:string}

/** Extract only total basin turnover, never port totals, cargo subtypes or YoY comparators. */
export function parsePublication(html: string, period: string): ParsedPublication {
  const title = plainText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const words: Record<string,string> = {'2026-03':'март','2026-04':'апрель','2026-05':'май','2026-06':'июнь','2026-Q3':'сентябрь'};
  if (!words[period] || !title.toLowerCase().includes('грузооборот морских портов россии') ||
      !title.includes('2026') || !title.toLowerCase().includes(words[period])) {
    throw new Error('Заголовок публикации не соответствует ожидаемому периоду.');
  }
  const date = html.match(/<p\b[^>]*class=["'][^"']*\bdate\b[^"']*["'][^>]*>\s*(\d{2})\.(\d{2})\.(\d{4})\s*<\/p>/i);
  if (!date) throw new Error('В первичной публикации не найдена дата выхода.');
  const publishedOn = `${date[3]}-${date[2]}-${date[1]}`;
  const parsedDate = new Date(publishedOn+'T00:00:00Z');
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0,10)!==publishedOn ||
      publishedOn > new Date().toISOString().slice(0,10)) throw new Error('Некорректная дата публикации.');
  const periodEnd = period === '2026-Q3' ? '2026-09-30' : `${period}-` + ({'03':'31','04':'30','05':'31','06':'30'}[period.slice(-2)] || '31');
  if (publishedOn < periodEnd) throw new Error('Публикация вышла до окончания наблюдаемого периода.');
  const text = plainText(html);
  const names: Record<BasinId,string> = {baltic:'Балтийского',azov:'Азово[-–—]Черноморского',far_east:'Дальневосточного'};
  const values = {} as Record<BasinId,number>;
  for (const id of BASIN_IDS) {
    const regex = new RegExp(`Грузооборот морских портов ${names[id]} бассейна составил\\s+(\\d+(?:[,.]\\d+)?)\\s*млн\\s*(?:тонн|т\\b)`,'giu');
    const matches = [...text.matchAll(regex)];
    if (matches.length !== 1) throw new Error('Не найден однозначный общий итог всех трёх бассейнов в млн тонн.');
    const value = Number(matches[0][1].replace(',','.'));
    if (!Number.isFinite(value) || value <= 0 || value > 1000) throw new Error('Итог бассейна вне допустимого диапазона.');
    values[id] = value;
  }
  return {publishedOn,values,title};
}

/**
 * Public publications are checked while preparing the embedded snapshot.
 * Runtime requests use only the snapshot or a CSV supplied by the analyst.
 */
export async function getDataset(
  options: {mode?: 'live' | 'snapshot'; refresh?: boolean} = {},
): Promise<HistoricalDataset> {
  const dataset = structuredClone(VERIFIED_DATASET);
  if (options.mode === 'live' || options.refresh) {
    dataset.snapshot.message = 'Для обновления среза загрузите квартальные данные в CSV.';
  }
  return dataset;
}
