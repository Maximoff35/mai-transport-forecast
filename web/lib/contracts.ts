export type BasinId = 'baltic' | 'azov' | 'far_east';
export const BASINS: Record<BasinId, string> = {baltic:'Балтийский бассейн',azov:'Азово-Черноморский бассейн',far_east:'Дальневосточный бассейн'};
export type DataMode = 'live' | 'snapshot';
export interface Observation {period:string;value:number;publishedOn:string;sourceUrl:string;cumulative?:number;previousSourceUrl?:string}
export interface SourceRecord {url:string;title:string;publishedOn:string;period:string;kind:'primary'|'secondary';verified:boolean}
export interface DataMeta {version:string;status:'online'|'cached'|'snapshot';checkedAt:string;fetchedAt:string;lastPeriod:string;publicationDate:string;sourceLabel:string;sourceUrl:string;message:string}
export interface HistoricalDataset {basins:Record<BasinId,Observation[]>;monthly:Record<BasinId,Observation[]>;snapshot:DataMeta;sources:SourceRecord[];warnings:string[]}
export interface ScenarioInput {basin:BasinId;asOf:string;capacity:number;repairLoss:number;reserve:number;shockPercent:number;reserveLeadDays:number;repairLeadDays:number;allowMove:boolean;calendarEnabled:boolean;horizon:number;dataMode:DataMode}
export const DEMO_INPUT:ScenarioInput={basin:'baltic',asOf:'2026-11-13',capacity:68,repairLoss:4,reserve:3,shockPercent:0,reserveLeadDays:45,repairLeadDays:90,allowMove:true,calendarEnabled:true,horizon:4,dataMode:'snapshot'};
export function moscowDate(now=new Date()):string {return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)}
export function defaultInput():ScenarioInput {return {...DEMO_INPUT,asOf:moscowDate()}}
export interface ForecastPoint {period:string;base:number;scenario:number;referencePeriod:string;referenceValue:number;sourceUrl:string;publishedOn:string;lead:number}
export type ActionId='base'|'reserve'|'move';
export interface ActionResult {id:ActionId;label:string;capacities:number[];gaps:number[];totalGap:number;available:boolean;reason:string|null;deadline:string|null;reservePeriod?:string}
export interface MetricRow {id:string;label:string;horizon:number;mae:number;wape:number;n:number;bias:number}
export interface BacktestPoint {period:string;actual:number;previousYear:number;previousQuarter:number;mean2y:number}
export interface PolicyComparison {basin:BasinId;label:string;base:number;forecastChoice:number;alwaysReserve:number;windows:number;selectedReserveCount:number;alwaysReserveCount:number;reservePlacementUsesForecast:boolean}
export interface ObservationComparison {period:string;value:number;previousPeriod:string|null;previousValue:number|null;qoqPercent:number|null;yearAgoPeriod:string|null;yearAgoValue:number|null;yoyPercent:number|null}
export interface ScenarioResult {
 input:ScenarioInput;calculatedAt:string;basinLabel:string;unit:string;snapshot:DataMeta;
 history:Observation[];monthlyHistory:Observation[];sources:SourceRecord[];forecast:ForecastPoint[];
 planPeriods:string[];baseLoads:number[];planLoads:number[];planningAvailable:boolean;planningUnavailableReason:string|null;
 actions:ActionResult[];recommendedId:ActionId|null;
 recommendation:{title:string;detail:string;residualGap:number;fullyCovered:boolean;needsAdditionalPlan:boolean};
 requiredReserve:{byPeriod:number[];total:number;assignedPeriod:string|null;singleSlotEnough:boolean};
 metrics:MetricRow;backtest:{points:BacktestPoint[];methods:MetricRow[]};policyComparison:PolicyComparison[];
 lastObservedComparison:ObservationComparison;stress:{shock:number;baseGap:number;bestGap:number;recommendedId:ActionId|null;fullyCovered:boolean}[];
 explanationSteps:string[];memo:string;warnings:string[];
}
export interface ApiError {error:{code:string;message:string;fields?:Record<string,string>}}
export interface ImportPreview {dataset:HistoricalDataset;rowsAdded:number;periods:string[];basins:BasinId[];warnings:string[];missingPeriods:string[];sha256:string;format:'legacy-ytd'|'observations'|'explicit-ytd'}
