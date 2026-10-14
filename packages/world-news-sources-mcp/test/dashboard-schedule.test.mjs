import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Run the shipped display helper against recorded schedules, without transport or a browser.
const app=readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8');
const start=app.indexOf('function appendCollectionSchedule(');
const end=app.indexOf('function countryAssessment(',start);
assert.ok(start>=0&&end>start,'the shipped schedule display helper must be present');
const code=app.slice(start,end);

function element(tag='td',className='',textContent=''){
  return {tag,className,textContent,children:[],append(...children){this.children.push(...children);},get childElementCount(){return this.children.length;}};
}
function display(country,{date='2026-10-14',inputDate=date}={}){
  const cell=element(),metric=element('div','metric','64.2%');
  cell.append(metric);
  const context=vm.createContext({
    state:{overview:{date}},$:()=>({value:inputDate}),node:element,
    valueText:value=>new Intl.NumberFormat('ko-KR').format(value),
    timeText:value=>`formatted:${value}`
  });
  vm.runInContext(`'use strict';\n${code}\nthis.display=appendCollectionSchedule;`,context);
  context.display(cell,country);
  assert.equal(cell.children[0],metric,'the existing coverage metric must be retained');
  assert.equal(metric.textContent,'64.2%','schedule metadata must not replace the coverage percentage');
  return cell;
}
const schedule=Object.freeze({policy:'daily_all_active',as_of:'2026-10-14T09:00:00.000Z',cycle_status:'completed',deferred_endpoints:2,unattempted_unrestricted_endpoints:3,next_recheck_at:'2026-10-14T14:00:00.000Z'});

test('unavailable, old-policy and differently dated schedules add no display claims',()=>{
  for(const value of [undefined,null,{...schedule,policy:'due_only'},{...schedule,as_of:null},{...schedule,as_of:'invalid'},{...schedule,as_of:'2026-10-13T09:00:00.000Z'}]){
    assert.equal(display({collection_schedule:value}).children.length,1);
  }
  assert.equal(display({date:'2026-10-13',collection_schedule:schedule}).children.length,1);
});

test('zero, missing and nonnumeric counts do not add noisy schedule labels',()=>{
  for(const value of [0,-1,undefined,null,'3',NaN,Infinity]){
    const cell=display({collection_schedule:{...schedule,deferred_endpoints:value,unattempted_unrestricted_endpoints:value}});
    assert.equal(cell.children.length,1);
  }
});

test('recorded server deferrals and unrestricted omissions retain separate counts and timestamps',()=>{
  const country=Object.freeze({collection_schedule:schedule,metrics:Object.freeze({attempt_coverage:Object.freeze({value:64.2,numerator:163,denominator:254})})});
  const cell=display(country),notes=cell.children[1];
  assert.equal(notes.className,'collection-schedule');
  assert.equal(notes.childElementCount,2);
  assert.equal(notes.children[0].textContent,'서버 대기 2');
  assert.equal(notes.children[1].textContent,'미검사 3');
  assert.match(notes.children[0].title,/다음 재검사 formatted:2026-10-14T14:00:00\.000Z/);
  assert.match(notes.children[0].title,/확인 formatted:2026-10-14T09:00:00\.000Z/);
  assert.match(notes.children[1].title,/아직 검사 기록이 없는/);
  assert.equal(country.metrics.attempt_coverage.value,64.2);
  assert.equal(country.metrics.attempt_coverage.numerator,163);
  assert.equal(country.metrics.attempt_coverage.denominator,254);
});

test('a running cycle labels remaining work as pending inspection',()=>{
  const cell=display({collection_schedule:{...schedule,cycle_status:'running',deferred_endpoints:0}});
  const notes=cell.children[1];
  assert.equal(notes.childElementCount,1);
  assert.equal(notes.children[0].textContent,'검사 전 3');
  assert.match(notes.children[0].title,/이번 회차 검사를 기다리는/);
});

const noteCode=app.slice(app.indexOf('function observationNote('),app.indexOf('function renderCountries('));
function observationNote(items,date='2026-10-14'){
  const context=vm.createContext({});vm.runInContext(noteCode+'\nthis.describe=observationNote;',context);
  return context.describe({date,items});
}
test('completed explicit-address probes never appear as completed country collection cycles',()=>{
  const items=Array.from({length:73},(_,i)=>({country:`country-${i}`,period:{run_completion:i<16?'completed':'not_recorded',observation_window_closed:false},
    completed_cycle_baseline:{state:i<16?'incomplete_or_explicit_cycle':'completion_not_recorded',current:null}}));
  const text=observationNote(items);assert.match(text,/완료 회차 기록 없음/);assert.ok(!text.includes('16/73'));
});
test('the backend country cohort assessment takes precedence over ambiguous whole-run status',()=>{
  const items=[
    {period:{run_completion:'partial'},completed_cycle_baseline:{state:'insufficient_completed_cycle_history',current:{attempt_coverage:100,success_rate:0}}},
    {period:{run_completion:'completed'},completed_cycle_baseline:{state:'comparable_completed_cycles',current:{attempt_coverage:100,success_rate:95}}},
    {period:{run_completion:'completed'},completed_cycle_baseline:{state:'incomplete_or_explicit_cycle',current:null}},
    {period:{run_completion:'running'},completed_cycle_baseline:{state:'incomplete_or_explicit_cycle',current:null}},
    {period:{run_completion:'failed'},completed_cycle_baseline:{state:'incomplete_or_explicit_cycle',current:null}},
    {period:{run_completion:'partial'},completed_cycle_baseline:{state:'insufficient_completed_cycle_history',current:{attempt_coverage:75,success_rate:95}}},
  ];
  assert.match(observationNote(items),/완료 회차 기록 2\/6개국/);
});
test('legacy completion is unavailable without a proven full production due cohort',()=>{
  const cohort={run_completion:'completed',lane:'production',scope:'due_endpoints',eligible_endpoints:4,planned_endpoints:4,attempted_endpoints:4};
  const items=[{period:{run_completion:'completed'}},{period:{...cohort,scope:'explicit_endpoints'}},{period:{...cohort,lane:'inspection'}},{period:{...cohort,attempted_endpoints:3}},{period:cohort}];
  assert.match(observationNote(items),/완료 회차 기록 1\/5개국/);
});

const inventoryCode=app.slice(app.indexOf('function registryHistoryView('),app.indexOf('const registryEventLabels'));
function registryHistoryView(data){const context=vm.createContext({});vm.runInContext(inventoryCode+'\nthis.view=registryHistoryView;',context);return context.view(data);}
const observedSource=(id,extra={})=>({source_id:id,country:'US',name:id,kind:'registration_observed',occurred_at:null,registration_created_at:null,
  previous_observed_at:'2026-10-13T23:00:00.000Z',observed_at:'2026-10-14T01:00:00.000Z',...extra});
const history=(events)=>({date:'2026-10-14',baseline_observed_at:'2026-10-13T23:00:00.000Z',latest_registry_observed_at:'2026-10-14T01:00:00.000Z',per_country:[{country:'US',observed_additions:events.length}],observed_registry_changes:events});
test('real dated operator additions supersede duplicate observation events and preserve validation/provenance',()=>{
  const additions=Array.from({length:33},(_,i)=>({source_id:`source-${i}`,country:i<20?'US':'GB',name:`Registered ${i}`,recorded_at:'2026-10-14T00:30:00.000Z',recorded_at_basis:'operator_initial_registration',
    endpoints:[{type:'rss',url:`https://publisher.example/feed-${i}`,latest_validation:{checked_at:'2026-10-14T00:45:00.000Z',status:'working_nonempty',http_status:200},provenance:[{kind:'official_html_feed_link',source_url:'https://publisher.example/'}]}]}));
  const data={date:'2026-10-14',history:history(additions.map(source=>observedSource(source.source_id))),
    new_sources:[observedSource('wrong-precedence')],inventory_changes:{date:'2026-10-14',recorded_events_only:true,history_complete:false,additions,
      per_country:[{country:'US',additions:20,deactivations:0,reactivations:0,deletions:null,net_change:null},{country:'GB',additions:13,deactivations:0,reactivations:0,deletions:null,net_change:null}]}};
  const view=registryHistoryView(data);assert.equal(view.mode,'actual');assert.equal(view.events.length,33);assert.equal(view.observations.length,0);
  assert.equal(view.rows.reduce((total,row)=>total+row.additions,0),33);assert.equal(view.events[0].recorded_at_basis,'operator_initial_registration');
  assert.equal(view.events[0].endpoints[0].latest_validation.http_status,200);assert.equal(view.events[0].endpoints[0].provenance[0].kind,'official_html_feed_link');
  assert.ok(view.rows.every(row=>row.deletions===null&&row.net_change===null));
});
test('mixed evidence preserves unknown observation intervals without adding them to actual registration counts',()=>{
  const known={source_id:'known',country:'US',recorded_at:'2026-10-14T00:30:00.000Z',recorded_at_basis:'operator_initial_registration'};
  const unknown=observedSource('unknown');
  const view=registryHistoryView({date:'2026-10-14',history:history([observedSource('known'),unknown]),inventory_changes:{date:'2026-10-14',recorded_events_only:true,additions:[known],per_country:[{country:'US',additions:1,deletions:null,net_change:null}]}});
  assert.equal(view.mode,'actual');assert.equal(view.events.length,1);assert.equal(view.observations.length,1);assert.equal(view.rows[0].additions,1);
  assert.equal(view.observations[0].source_id,'unknown');assert.equal(view.observations[0].registration_created_at,null);assert.equal(view.observations[0].occurred_at,null);
  assert.equal(view.observations[0].previous_observed_at,'2026-10-13T23:00:00.000Z');assert.equal(view.observations[0].observed_at,'2026-10-14T01:00:00.000Z');
});
test('recorded addition date is its UTC instant; observations and validation dates do not become registration dates',()=>{
  const changes={recorded_events_only:true,per_country:[{country:'US',additions:1}],additions:[
    {source_id:'utc-same-day',recorded_at:'2026-10-13T20:00:00-05:00'},
    {source_id:'utc-prior-day',recorded_at:'2026-10-14T00:30:00+09:00'},
    {source_id:'not-a-registration',observed_at:'2026-10-14T01:00:00Z',latest_validation:{checked_at:'2026-10-14T01:00:00Z'}},
  ]};
  const view=registryHistoryView({date:'2026-10-14',inventory_changes:{date:'2026-10-14',...changes}});
  assert.equal(view.mode,'actual');assert.equal(view.events.length,1);assert.equal(view.events[0].source_id,'utc-same-day');
  const mismatch=registryHistoryView({date:'2026-10-14',inventory_changes:{date:'2026-10-13',...changes}});assert.equal(mismatch.mode,'unavailable');assert.equal(mismatch.events.length,0);
});
test('zero recorded additions do not conceal observation-only changes or invent creation timestamps',()=>{
  const view=registryHistoryView({date:'2026-10-14',history:history([observedSource('unknown')]),inventory_changes:{date:'2026-10-14',recorded_events_only:true,per_country:[{country:'US',additions:0,deletions:null,net_change:null}],additions:[]}});
  assert.equal(view.mode,'observed');assert.equal(view.events.length,1);assert.equal(view.events[0].registration_created_at,null);assert.equal(view.rows[0].observed_additions,1);
});
