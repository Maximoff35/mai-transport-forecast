import { BASINS, type ActionId, type ActionResult, type HistoricalDataset, type MetricRow, type Observation, type PolicyComparison, type ScenarioInput, type ScenarioResult } from './contracts.ts';

const METHODS = [
  {id:'previous_quarter',label:'Последний известный квартал'},
  {id:'previous_year',label:'Тот же квартал год назад'},
  {id:'same_quarter_mean_2y',label:'Среднее того же квартала за два года'},
];
const round=(n:number)=>Math.round((n+Number.EPSILON)*1e8)/1e8;
const sum=(ns:number[])=>ns.reduce((a,b)=>a+b,0);
const qi=(p:string)=>{const m=/^(\d{4})-?Q([1-4])$/.exec(p);if(!m)throw new Error(`Неизвестный квартал: ${p}`);return Number(m[1])*4+Number(m[2])-1};
const qlabel=(q:number)=>`${Math.floor(q/4)}-Q${q%4+1}`;
const qdate=(q:number)=>`${Math.floor(q/4)}-${String((q%4)*3+1).padStart(2,'0')}-01`;
const minusDays=(day:string,days:number)=>new Date(Date.parse(day+'T00:00:00Z')-days*86400000).toISOString().slice(0,10);
const gap=(loads:number[],caps:number[])=>loads.map((x,i)=>round(Math.max(0,x-caps[i])));

export function validateInput(raw:unknown):ScenarioInput {
  const fields:Record<string,string>={};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw validation({input:'Ожидается объект параметров сценария.'});
  const r=raw as Record<string,unknown>;
  if(!['baltic','azov','far_east'].includes(r.basin as string))fields.basin='Выберите один из трёх бассейнов.';
  if(!['live','snapshot'].includes(r.dataMode as string))fields.dataMode='Режим данных: live или snapshot.';
  if(typeof r.asOf!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(r.asOf)||!Number.isFinite(Date.parse(r.asOf+'T00:00:00Z'))||new Date(r.asOf+'T00:00:00Z').toISOString().slice(0,10)!==r.asOf||r.asOf<'2012-01-01'||r.asOf>'2100-12-31')fields.asOf='Укажите существующую дату в формате ГГГГ-ММ-ДД (2012–2100).';
  for(const [key,min,max,integer] of [['capacity',0.01,1000,false],['repairLoss',0,1000,false],['reserve',0,1000,false],['shockPercent',-50,50,false],['reserveLeadDays',0,3650,true],['repairLeadDays',0,3650,true],['horizon',1,4,true]] as const){
    const value=r[key];if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))fields[key]=`Параметр ${key}: ${integer?'целое ':''}число от ${min} до ${max}.`;
  }
  if(typeof r.repairLoss==='number'&&typeof r.capacity==='number'&&r.repairLoss>r.capacity)fields.repairLoss='Потеря мощности при ремонте не может превышать мощность.';
  for(const key of ['allowMove','calendarEnabled'])if(typeof r[key]!=='boolean')fields[key]=`Параметр ${key} должен быть true или false.`;
  if(Object.keys(fields).length)throw validation(fields);
  return {basin:r.basin,asOf:r.asOf,capacity:r.capacity,repairLoss:r.repairLoss,reserve:r.reserve,shockPercent:r.shockPercent,reserveLeadDays:r.reserveLeadDays,repairLeadDays:r.repairLeadDays,allowMove:r.allowMove,calendarEnabled:r.calendarEnabled,horizon:r.horizon,dataMode:r.dataMode} as ScenarioInput;
}
function validation(fields:Record<string,string>){const e=Object.assign(new Error(Object.values(fields).join(' ')),{fields,code:'INVALID_INPUT'});e.name='ValidationError';return e}

function observations(rows:Observation[],asOf:string):Observation[]{
  const ordered=rows.filter(r=>r.publishedOn<=asOf).map(r=>({...r})).sort((a,b)=>qi(a.period)-qi(b.period));
  const seen=new Set<number>();
  for(const row of ordered){const q=qi(row.period);if(!Number.isFinite(row.value)||row.value<0||seen.has(q))throw new Error('В исходных данных обнаружен неверный объём или повтор квартала.');seen.add(q)}
  return ordered;
}
function prediction(map:Map<number,number>,origin:number,target:number,method:string):number|undefined {
  if(target<=origin||target-origin>4)return undefined;
  if(method==='previous_quarter')return map.get(origin);
  const a=map.get(target-4);if(a===undefined||target-4>origin)return undefined;
  if(method==='previous_year')return a;
  const b=map.get(target-8);return b===undefined?undefined:(a+b)/2;
}
function evaluation(rows:Observation[]){
  const map=new Map(rows.map(r=>[qi(r.period),r.value]));
  const releases=new Map(rows.map(r=>[qi(r.period),r.publishedOn]));
  // Use the latest six targets available to all three methods at all horizons.
  const candidates=[...map.keys()].filter(t=>t>=Math.min(...map.keys())+12);
  const targets=candidates.filter(t=>METHODS.every(method=>[1,2,3,4].every(h=>{
    const origin=t-h,issued=releases.get(origin);
    if(!issued||prediction(map,origin,t,method.id)===undefined)return false;
    const refs=method.id==='previous_quarter'?[origin]:method.id==='previous_year'?[t-4]:[t-4,t-8];
    return refs.every(q=>!!releases.get(q)&&releases.get(q)!<=issued);
  }))).slice(-6);
  const methods:MetricRow[]=[];
  for(let horizon=1;horizon<=4;horizon++)for(const method of METHODS){
    const samples=targets.flatMap(t=>{const p=prediction(map,t-horizon,t,method.id);return p===undefined?[]:[{actual:map.get(t)!,error:map.get(t)!-p}]});
    methods.push({id:method.id,label:method.label,horizon,n:samples.length,mae:samples.length?round(sum(samples.map(s=>Math.abs(s.error)))/samples.length):0,wape:samples.length&&sum(samples.map(s=>s.actual))?round(100*sum(samples.map(s=>Math.abs(s.error)))/sum(samples.map(s=>s.actual))):0,bias:samples.length?round(sum(samples.map(s=>s.error))/samples.length):0});
  }
  const points=targets.flatMap(t=>{const origin=t-1,a=prediction(map,origin,t,'previous_year'),b=prediction(map,origin,t,'previous_quarter'),c=prediction(map,origin,t,'same_quarter_mean_2y');return a===undefined||b===undefined||c===undefined?[]:[{period:qlabel(t),actual:map.get(t)!,previousYear:a,previousQuarter:b,mean2y:c}]});
  return {methods,points};
}
function policies(dataset:HistoricalDataset,asOf:string,input:ScenarioInput):PolicyComparison[]{
  return (Object.keys(BASINS) as Array<keyof typeof BASINS>).map(basin=>{
    const rows=observations(dataset.basins[basin],asOf),map=new Map(rows.map(r=>[qi(r.period),r.value])),releases=new Map(rows.map(r=>[qi(r.period),r.publishedOn]));
    let windows=0,baseTotal=0,selectedTotal=0,reserveTotal=0,selectedReserveCount=0;
    // Keep the same expanding-origin experiment when new history is uploaded.
    // Eighteen frozen quarters produce five overlapping windows per basin.
    for(let first=Math.min(...map.keys())+12;first<Math.max(...map.keys());first++){
      const targets=[first,first+1],origin=first-2;
      const predicted=targets.map(t=>prediction(map,origin,t,'previous_year'));
      const issued=releases.get(origin);
      if(!issued||issued>=qdate(first)||predicted.some(x=>x===undefined)||targets.some(t=>!map.has(t)||!releases.get(t-4)||releases.get(t-4)!>issued))continue;
      const loads=predicted as number[],actual=targets.map(t=>map.get(t)!);
      const caps=[input.capacity,input.capacity-input.repairLoss];
      const peak=loads[1]-caps[1]>loads[0]-caps[0]?1:0;
      const reserve=caps.map((c,i)=>c+(i===peak?input.reserve:0));
      const plans=[caps,reserve,...(input.allowMove?[[input.capacity-input.repairLoss,input.capacity]]:[])];
      const chosen=plans.reduce((best,p,i)=>sum(gap(loads,p))<sum(gap(loads,plans[best]))-1e-9?i:best,0);
      baseTotal+=sum(gap(actual,caps));reserveTotal+=sum(gap(actual,reserve));selectedTotal+=sum(gap(actual,plans[chosen]));selectedReserveCount+=Number(chosen===1);windows++;
    }
    return {basin,label:BASINS[basin],base:windows?round(baseTotal/windows):0,forecastChoice:windows?round(selectedTotal/windows):0,alwaysReserve:windows?round(reserveTotal/windows):0,windows,selectedReserveCount,alwaysReserveCount:windows,reservePlacementUsesForecast:true};
  });
}
export function actionSet(loads:number[],periods:string[],input:ScenarioInput):ActionResult[]{
  const caps=[input.capacity,input.capacity-input.repairLoss],peak=loads[1]-caps[1]>loads[0]-caps[0]?1:0;
  const reserveDeadline=minusDays(qdate(qi(periods[peak])),input.reserveLeadDays),moveDeadline=minusDays(qdate(qi(periods[0])),input.repairLeadDays);
  const reserveAvailable=!input.calendarEnabled||input.asOf<=reserveDeadline;
  const moveAvailable=input.allowMove&&(!input.calendarEnabled||input.asOf<=moveDeadline);
  const make=(id:ActionId,label:string,capacities:number[],available:boolean,deadline:string|null,reason:string|null):ActionResult=>{const gaps=gap(loads,capacities);return {id,label,capacities,gaps,totalGap:round(sum(gaps)),available,deadline,reason}};
  return [make('base','Исходный план',caps,true,null,null),{...make('reserve','Резерв в пиковом квартале',caps.map((c,i)=>round(c+(i===peak?input.reserve:0))),reserveAvailable,reserveDeadline,reserveAvailable?null:`Срок заказа резерва истёк ${reserveDeadline}.`),reservePeriod:periods[peak]},make('move','Перенос ремонта на первый квартал',[input.capacity-input.repairLoss,input.capacity],moveAvailable,moveDeadline,!input.allowMove?'Перенос ремонта отключён во входных условиях.':moveAvailable?null:`Срок согласования переноса истёк ${moveDeadline}.`)];
}
export function choose(actions:ActionResult[]):ActionResult|undefined{return actions.filter(a=>a.available).reduce<ActionResult|undefined>((best,a)=>!best||a.totalGap<best.totalGap-1e-9?a:best,undefined)}

export function calculateScenario(dataset:HistoricalDataset,raw:ScenarioInput):ScenarioResult {
  const input=validateInput(raw),history=observations(dataset.basins[input.basin],input.asOf);
  if(!history.length)throw new Error('На выбранную дату ещё нет опубликованных квартальных данных. Выберите более позднюю дату.');
  const last=history[history.length-1],lastQ=qi(last.period),byQuarter=new Map(history.map(r=>[qi(r.period),r]));
  const projections=Array.from({length:4},(_,i)=>{const target=lastQ+i+1,ref=byQuarter.get(target-4);return ref?{period:qlabel(target),base:ref.value,scenario:round(ref.value*(1+input.shockPercent/100)),referencePeriod:ref.period,referenceValue:ref.value,sourceUrl:ref.sourceUrl,publishedOn:ref.publishedOn,lead:i+1}:null}).filter(p=>p!==null);
  const decisionQ=Number(input.asOf.slice(0,4))*4+Math.floor((Number(input.asOf.slice(5,7))-1)/3);
  const planPeriods=[qlabel(decisionQ+1),qlabel(decisionQ+2)],plan=planPeriods.map(p=>projections.find(f=>f.period===p));
  const planningAvailable=plan.every(p=>p!==undefined);
  const missingReferences=planPeriods.map(p=>qi(p)-4).filter(q=>!byQuarter.has(q)).map(qlabel);
  const planningUnavailableReason=planningAvailable?null:`Для плана ${planPeriods.join(', ')} не хватает опубликованной истории. ${missingReferences.length?`Загрузите данные за ${missingReferences.join(', ')}. `:''}Расчёт ограничен проверенным горизонтом 1–4 квартала от последнего опубликованного среза; рекурсивное продолжение прогноза не выполняется.`;
  const baseLoads=planningAvailable?plan.map(p=>p!.base):[],planLoads=planningAvailable?plan.map(p=>p!.scenario):[];
  const actions:ActionResult[]=planningAvailable?actionSet(planLoads,planPeriods,input):(['base','reserve','move'] as ActionId[]).map((id)=>({id,label:{base:'Исходный план',reserve:'Резерв в пиковом квартале',move:'Перенос ремонта на первый квартал'}[id],capacities:[],gaps:[],totalGap:0,available:false,deadline:null,reason:planningUnavailableReason}));
  const chosen=choose(actions),residualGap=chosen?.totalGap??0,byPeriod=actions[0].gaps;
  const backtest=evaluation(history),metrics=backtest.methods.find(m=>m.id==='previous_year'&&m.horizon===input.horizon)!;
  const previous=byQuarter.get(lastQ-1),yearAgo=byQuarter.get(lastQ-4);
  const percent=(old:Observation|undefined)=>old&&old.value>0?round(100*(last.value/old.value-1)):null;
  const recommendation={title:chosen?`${chosen.label}: ${residualGap>0?'остаётся превышение':'превышение закрыто'}`:'Расчёт плана пока недоступен',detail:chosen?`Минимальное суммарное превышение среди доступных действий: ${residualGap.toFixed(2)} млн т. ${residualGap>0?'Нужен дополнительный план: резерв по кварталам, изменение окна ремонта или подтверждённые мощности.':'При заданных условных мощностях превышения нет.'} ${input.calendarEnabled?'Действия проверены по срокам согласования.':'Сравнение предполагает, что действия согласованы заранее.'} Стоимость мер не задана; экономическая оптимальность не оценивалась.`:planningUnavailableReason!,residualGap,fullyCovered:!!chosen&&residualGap<=1e-8,needsAdditionalPlan:!chosen||residualGap>1e-8};
  const stress=planningAvailable?[-10,-5,0,5,10].map(shock=>{const a=actionSet(baseLoads.map(x=>round(x*(1+shock/100))),planPeriods,input),c=choose(a);return {shock,baseGap:a[0].totalGap,bestGap:c?.totalGap??0,recommendedId:c?.id??null,fullyCovered:!!c&&c.totalGap<=1e-8}}):[];
  const warnings=[...dataset.warnings];
  if(!input.calendarEnabled)warnings.push('Режим заранее согласованных действий: календарные запреты отключены.');
  if(metrics.n<6)warnings.push(`Для оценки точности доступно ${metrics.n} из шести контрольных кварталов.`);
  warnings.push('Бассейновая перевалка — агрегат фактического потока. Это не наблюдаемые заявки, очередь или мощность отдельного терминала.');
  if(byPeriod.filter(x=>x>1e-8).length>1)warnings.push('Потребность в резерве относится к каждому кварталу отдельно. Сумма не означает, что один ресурс можно произвольно переносить между кварталами.');
  const explanationSteps=[`Источник: опубликованные до ${input.asOf} данные; последний квартал ${last.period}.`,`Базовый прогноз каждого будущего квартала равен факту того же квартала прошлого года (Y(q−4)).`,`Сценарная поправка ${input.shockPercent}% применяется к прогнозу; фактическая история сохраняется.`,`План: ${planPeriods.join(' и ')} — два полных квартала после даты решения.`,`Превышение = max(прогноз − доступная мощность, 0); суммы считаются по двум кварталам.`,`Резерв ${input.reserve} млн т назначается одному кварталу с наибольшим исходным превышением.`,`Выбор минимизирует превышение среди доступных действий; равные результаты сохраняют более простое действие.`];
  const memo=[`Сценарная записка: ${BASINS[input.basin]}`,`Дата решения: ${input.asOf}; срез данных: ${last.period} (${last.publishedOn}).`,`Мощность ${input.capacity}; потеря при ремонте ${input.repairLoss}; резерв ${input.reserve} млн т; поправка ${input.shockPercent}%.`,`Периоды: ${planPeriods.join(', ')}.`,...actions.map(a=>`${a.label}: ${a.available?'доступно':'недоступно'}, гипотетическое превышение ${a.totalGap.toFixed(2)} млн т${a.deadline?`; срок ${a.deadline}`:''}${a.reason?`; ${a.reason}`:''}.`),recommendation.detail,'Мощности, ремонт и резерв — условные входные параметры. Показатель превышения не является денежным эффектом.'].join('\n');
  return {input,calculatedAt:input.asOf+'T00:00:00+03:00',basinLabel:BASINS[input.basin],unit:'млн т',snapshot:{...dataset.snapshot,lastPeriod:last.period,publicationDate:last.publishedOn},history,monthlyHistory:dataset.monthly[input.basin].filter(r=>r.publishedOn<=input.asOf).map(r=>({...r})),sources:dataset.sources.filter(s=>s.publishedOn<=input.asOf).map(s=>({...s})),forecast:projections.slice(0,input.horizon),planPeriods,baseLoads,planLoads,planningAvailable,planningUnavailableReason,actions,recommendedId:chosen?.id??null,recommendation,requiredReserve:{byPeriod:[...byPeriod],total:round(sum(byPeriod)),assignedPeriod:actions[1].reservePeriod??null,singleSlotEnough:planningAvailable&&byPeriod.filter(x=>x>1e-8).length<=1},metrics,backtest,policyComparison:policies(dataset,input.asOf,input),lastObservedComparison:{period:last.period,value:last.value,previousPeriod:previous?.period??null,previousValue:previous?.value??null,qoqPercent:percent(previous),yearAgoPeriod:yearAgo?.period??null,yearAgoValue:yearAgo?.value??null,yoyPercent:percent(yearAgo)},stress,explanationSteps,memo,warnings};
}
