import publishedRecords from '../data/basin-capacities.json';
import type { BasinId } from './contracts';

export type CapacityMode = 'scenario' | 'published';

export interface AnnualCapacityRecord {
  year: number;
  measuredYear?: number;
  basin: BasinId;
  annualCapacity: number;
  asOf: string;
  sourceUrl: string;
  publishedOn?: string | null;
  publicationYear?: number;
  sourceTitle?: string;
  localSourceUrl?: string;
  unit?: 'million_tonnes_per_year';
  measurement?: 'installed';
  reconstructionOnly?: boolean;
  asOfBasis?: string;
  dateNote?: string;
  copyKind?: string;
  sourcePage?: number;
}

export interface CapacityReference extends AnnualCapacityRecord {
  period: string;
  quarterlyEquivalent: number;
}

/** Apply a capacity reference only to the reconstruction year assigned in the dataset. */
export function capacityForPeriod(
  records: readonly AnnualCapacityRecord[], basin: BasinId, period: string,
): CapacityReference | undefined {
  const year = Number(period.slice(0, 4));
  const record = records.find(row => row.basin === basin && row.year === year);
  if (!record) return undefined;
  if (record.asOf !== `${year}-01-01` || !Number.isFinite(record.annualCapacity) || record.annualCapacity <= 0) {
    throw new Error(`Некорректный опубликованный срез мощности ${basin}:${year}.`);
  }
  return { ...record, period, quarterlyEquivalent: record.annualCapacity / 4 };
}

export const PUBLISHED_CAPACITIES = publishedRecords as AnnualCapacityRecord[];

export const PUBLISHED_CAPACITY_ASSUMPTIONS = [
  'Опубликованный показатель мощности истекшего года относится к началу следующего года для реконструкции. Поле asOf задаёт эту привязку, а источник и measuredYear сохраняют исходный период.',
  'Квартальный эквивалент равен годовой мощности, делённой на четыре. Равномерное распределение мощности по кварталам является допущением расчёта.',
  'Годовой показатель описывает установленную мощность. Сезонные ограничения, специализация грузов, ремонт и подходы к портам требуют отдельных данных.',
  'Срезы мощности могут быть опубликованы позднее исторической даты решения. Точная дата публикации установлена не у всех источников. Результат является реконструкцией при заданной опубликованной годовой мощности.',
  'Для лет без опубликованного среза окна пропускаются с указанием года. Мощности соседних лет автоматически не переносятся.',
  'Потеря мощности при ремонте и дополнительный резерв остаются сценарными вводными пользователя.',
];
