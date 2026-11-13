import { BASINS, DEMO_INPUT, type ActionId, type ActionResult, type HistoricalDataset, type Observation } from './contracts';
import { actionSet, choose, validateInput } from './engine';

export const STRATEGIES = {
  base: 'Исходный план',
  forecast: 'Мера по прогнозу',
  fixed: 'Резерв в квартале ремонта',
} as const;
export type Strategy = keyof typeof STRATEGIES;
export type ReplayInput = ReturnType<typeof validateReplay>;
const index = (period: string) => Number(period.slice(0, 4)) * 4 + Number(period.at(-1)) - 1;
const label = (q: number) => `${Math.floor(q / 4)}-Q${q % 4 + 1}`;
const startDate = (q: number) => `${Math.floor(q / 4)}-${String(q % 4 * 3 + 1).padStart(2, '0')}-01`;
const round = (x: number) => Math.round(x * 1e6) / 1e6;

function invalid(message: string): never {
  throw Object.assign(new Error(message), { name: 'ValidationError' });
}

export function validateReplay(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Укажите параметры ретроспективы.');
  const r = raw as Record<string, unknown>;
  const scenario = validateInput({
    ...DEMO_INPUT, basin: r.basin, capacity: r.capacity, repairLoss: r.repairLoss, reserve: r.reserve,
    reserveLeadDays: r.reserveLeadDays, repairLeadDays: r.repairLeadDays, allowMove: r.allowMove,
  });
  const first = r.first;
  const last = r.last;
  if (typeof first !== 'string' || typeof last !== 'string' || !/^(?:19|20)\d{2}-Q[1-4]$/.test(first) || !/^(?:19|20)\d{2}-Q[1-4]$/.test(last) || index(last) < index(first) + 1) {
    invalid('Выберите диапазон минимум из двух кварталов.');
  }
  const keys = ['recoverablePercent', 'tariff', 'variableCost', 'reserveCost', 'moveCost'] as const;
  const supplied = keys.map(k => r[k]);
  if (supplied.some(x => x !== null && x !== undefined) && supplied.some((x, i) =>
    typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > (i === 0 ? 100 : i < 3 ? 1e6 : 1e12))) {
    invalid('Для оценки экономики укажите долю от 0 до 100%, тариф, переменные затраты и стоимость обеих мер.');
  }
  const economics = typeof supplied[0] === 'number' ? Object.fromEntries(keys.map((k, i) => [k, supplied[i]])) as Record<typeof keys[number], number> : null;
  return { scenario, first, last, economics };
}

function summarize(actual: number[], capacities: number[]) {
  const gaps = actual.map((value, i) => round(Math.max(0, value - capacities[i])));
  return { capacities, gaps, totalGap: round(gaps[0] + gaps[1]) };
}

type ReplayWindow = {
  periods: string[];
  asOf: string;
  origin: Observation;
  references: Observation[];
  actual: Observation[];
  actions: ActionResult[];
  strategies: Record<Strategy, ReturnType<typeof summarize> & {
    action: ActionId;
    servedVolume: number;
    recoverableTons: number | null;
    contribution: number | null;
  }>;
  fixedDeadline: string;
  predictedChoiceScore: number;
  predictedContributionByAction: Record<ActionId, number | null>;
  choiceReason: string;
};

function measureCost(action: ActionId, economics: ReplayInput['economics']) {
  if (!economics || action === 'base') return 0;
  return action === 'reserve' ? economics.reserveCost : economics.moveCost;
}

function expectedContribution(action: ActionId, avoidedGap: number, economics: NonNullable<ReplayInput['economics']>) {
  const recoveredTons = avoidedGap * 1e6 * economics.recoverablePercent / 100;
  return recoveredTons * (economics.tariff - economics.variableCost) - measureCost(action, economics);
}

export function calculateReplay(dataset: HistoricalDataset, input: ReplayInput) {
  const { scenario, first, last, economics } = input;
  const rows = new Map(dataset.basins[scenario.basin].map(row => [index(row.period), row]));
  const skipped: { first: string; reason: string }[] = [];
  const windows: ReplayWindow[] = [];
  for (let q = index(first); q + 1 <= index(last); q += 2) {
    // The last calendar quarter usually publishes after the target starts.
    // Use the most recent quarter actually available before that date.
    const origin = [rows.get(q - 1), rows.get(q - 2), rows.get(q - 3)].find(row => row && row.publishedOn < startDate(q));
    const facts = [rows.get(q), rows.get(q + 1)];
    const refs = [rows.get(q - 4), rows.get(q - 3)];
    const periods = [label(q), label(q + 1)];
    if (!origin || q + 1 - index(origin.period) > 4 || facts.some(f => !f) || refs.some(ref => !ref || ref.publishedOn > origin.publishedOn)) {
      const missing = [q - 4, q - 3, q, q + 1].filter(n => !rows.has(n)).map(label);
      skipped.push({ first: periods[0], reason: missing.length ? `Нет данных за ${missing.join(', ')}.` : 'К дате решения нет подходящего опубликованного среза для горизонта 1–4 квартала.' });
      continue;
    }
    const references = refs as Observation[];
    const actual = facts as Observation[];
    const loads = references.map(row => row.value);
    const asOf = origin.publishedOn;
    const actions = actionSet(loads, periods, { ...scenario, asOf });
    const predictedContributionByAction: Record<ActionId, number | null> = { base: null, reserve: null, move: null };
    if (economics) {
      for (const action of actions) {
        if (action.available) predictedContributionByAction[action.id] = round(expectedContribution(
          action.id, actions[0].totalGap - action.totalGap, economics,
        ));
      }
    }
    // Decide from forecasts and known costs before reading the target outcomes.
    // Iteration order preserves the simpler action when scores are equal.
    const selected = economics
      ? actions.filter(action => action.available).reduce((best, action) =>
        predictedContributionByAction[action.id]! > predictedContributionByAction[best.id]! + 1e-6 ? action : best,
      actions[0])
      : choose(actions)!;
    const predictedChoiceScore = economics ? predictedContributionByAction[selected.id]! : -selected.totalGap;
    const choiceReason = economics
      ? selected.id === 'base'
        ? 'По прогнозу доступные меры не дают положительного дополнительного вклада после затрат. Сохранён исходный план.'
        : `${selected.label} даёт наибольший ожидаемый дополнительный вклад среди доступных мер: ${Math.round(predictedChoiceScore).toLocaleString('ru-RU')} ₽ после затрат.`
      : `${selected.label} даёт минимальное прогнозное превышение среди доступных мер: ${selected.totalGap.toLocaleString('ru-RU')} млн т.`;
    const fixedDeadline = new Date(Date.parse(startDate(q + 1)) - scenario.reserveLeadDays * 86_400_000).toISOString().slice(0, 10);
    const fixedReserve = asOf <= fixedDeadline && scenario.reserve > 0;
    const values = actual.map(row => row.value);
    const base = summarize(values, actions[0].capacities);
    const fixedCaps = [scenario.capacity, round(scenario.capacity - scenario.repairLoss + (fixedReserve ? scenario.reserve : 0))];
    const policies = {
      base: { ...base, action: 'base' as const },
      forecast: { ...summarize(values, selected.capacities), action: selected.id },
      fixed: { ...summarize(values, fixedCaps), action: fixedReserve ? 'reserve' as const : 'base' as const },
    };
    const totalObserved = values[0] + values[1];
    const strategies = Object.fromEntries((Object.keys(STRATEGIES) as Strategy[]).map(id => {
      const policy = policies[id];
      const avoidedGap = base.totalGap - policy.totalGap;
      return [id, {
        ...policy,
        servedVolume: round(totalObserved - policy.totalGap),
        recoverableTons: economics ? round(avoidedGap * 1e6 * economics.recoverablePercent / 100) : null,
        contribution: economics ? round(expectedContribution(policy.action, avoidedGap, economics)) : null,
      }];
    })) as ReplayWindow['strategies'];
    windows.push({ periods, asOf, origin, references, actual, actions, strategies, fixedDeadline,
      predictedChoiceScore, predictedContributionByAction, choiceReason });
  }
  const totalObserved = round(windows.reduce((total, window) => total + window.actual.reduce((sum, row) => sum + row.value, 0), 0));
  const strategies = (Object.keys(STRATEGIES) as Strategy[]).map(id => {
    let gap = 0, reserves = 0, moves = 0, extraTons = 0, deltaTons = 0;
    let uselessReserves = 0, improvedWindows = 0, missedWindows = 0, gapClosedWindows = 0;
    let predictedContribution = 0;
    const resultCounts = { improved: 0, unchanged: 0, worsened: 0 };
    const classificationCounts = { gapClosed: 0, reducedWithRemainder: 0, missed: 0, worsened: 0, noOverload: 0 };
    for (const window of windows) {
      const policy = window.strategies[id];
      gap += policy.totalGap;
      reserves += Number(policy.action === 'reserve');
      moves += Number(policy.action === 'move');
      const delta = (window.strategies.base.totalGap - policy.totalGap) * 1e6;
      deltaTons += delta;
      if (economics) extraTons += delta * economics.recoverablePercent / 100;
      const improved = delta > 1e-3;
      const worsened = delta < -1e-3;
      const baseOverloaded = window.strategies.base.totalGap > 1e-9;
      uselessReserves += Number(policy.action === 'reserve' && !improved);
      improvedWindows += Number(improved);
      missedWindows += Number(baseOverloaded && !improved && !worsened);
      gapClosedWindows += Number(baseOverloaded && policy.totalGap <= 1e-9);
      resultCounts[improved ? 'improved' : worsened ? 'worsened' : 'unchanged']++;
      if (worsened) classificationCounts.worsened++;
      else if (!baseOverloaded) classificationCounts.noOverload++;
      else if (policy.totalGap <= 1e-9) classificationCounts.gapClosed++;
      else if (improved) classificationCounts.reducedWithRemainder++;
      else classificationCounts.missed++;
      if (economics) {
        const loads = window.references.map(row => row.value);
        const expectedGap = summarize(loads, policy.capacities).totalGap;
        predictedContribution += expectedContribution(policy.action, window.actions[0].totalGap - expectedGap, economics);
      }
    }
    const revenue = economics ? round(extraTons * economics.tariff) : null;
    const processingCost = economics ? round(extraTons * economics.variableCost) : null;
    const measureCost = economics ? round(reserves * economics.reserveCost + moves * economics.moveCost) : null;
    const contribution = revenue === null ? null : round(revenue - processingCost! - measureCost!);
    const margin = economics ? economics.tariff - economics.variableCost : 0;
    return {
      id, gap: round(gap), avoidedGap: round(deltaTons / 1e6), reserves, moves,
      servedVolume: round(totalObserved - gap),
      uselessReserves, improvedWindows, missedWindows, gapClosedWindows, resultCounts, classificationCounts,
      recoverableTons: economics ? round(extraTons) : null,
      predictedContribution: economics ? round(predictedContribution) : null,
      revenue, processingCost, measureCost, contribution,
      breakEvenTons: measureCost !== null && margin > 0 ? Math.ceil(measureCost / margin) : null,
      breakEvenAvoidedGapTons: economics && measureCost !== null && margin > 0 && economics.recoverablePercent > 0
        ? Math.ceil(measureCost / (margin * economics.recoverablePercent / 100)) : null,
    };
  });
  const forecast = strategies.find(row => row.id === 'forecast')!;
  const fixed = strategies.find(row => row.id === 'fixed')!;
  const comparison = {
    extraFixedReserves: fixed.reserves - forecast.reserves,
    extraFixedAvoidedGap: round(forecast.gap - fixed.gap),
    forecastContributionOverFixed: forecast.contribution === null || fixed.contribution === null
      ? null : round(forecast.contribution - fixed.contribution),
    fixedReserveThresholdTons: fixed.reserves > forecast.reserves && forecast.gap > fixed.gap &&
      fixed.moves === 0 && forecast.moves === 0
      ? round((forecast.gap - fixed.gap) * 1e6 / (fixed.reserves - forecast.reserves)) : null,
    fixedExtraReserveBreakEvenCost: economics && fixed.reserves > forecast.reserves &&
      fixed.moves === 0 && forecast.moves === 0
      ? round((fixed.avoidedGap - forecast.avoidedGap) * 1e6 * economics.recoverablePercent / 100 *
        (economics.tariff - economics.variableCost) / (fixed.reserves - forecast.reserves)) : null,
  };
  return { basin: BASINS[scenario.basin], first, last, windows, skipped, strategies, economics, scenario, comparison,
    totalObserved, chosenObjective: economics ? 'contribution' as const : 'gap' as const,
    economicAssumptions: economics ? [
      'Дополнительный операционный вклад считается относительно исходного плана для тех же фактических объёмов.',
      'Предотвращённое превышение × 1 000 000 × заданная доля восстанавливаемого объёма × (тариф − переменные затраты) − стоимость назначенных мер.',
      'Тариф и переменные затраты заданы в рублях за тонну. Стоимость резерва или переноса задана на одно назначение в двухквартальном окне.',
      'Доля восстанавливаемого объёма, тарифы и затраты являются вводными пользователя. Расчёт оценивает дополнительный операционный вклад при этих предположениях.',
      'Действие выбирается по прогнозному вкладу и доступности на дату решения. Фактический объём используется после выбора для ретроспективного результата.',
    ] : [],
    trailingQuarter: (index(last) - index(first) + 1) % 2 ? last : null };
}

export type ReplayResult = ReturnType<typeof calculateReplay>;
