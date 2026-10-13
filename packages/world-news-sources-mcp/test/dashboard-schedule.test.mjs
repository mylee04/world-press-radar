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
