import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRegions } from '../src/template.js';
import { composeAiSvg, type LineInput } from '../src/svg.js';
const regions = parseRegions(`<svg><g id="region-schedule" data-region="schedule" data-start-hour="7" data-rows-per-hour="1" transform="translate(56,378)"><rect width="289" height="778"/>${Array.from({length:15},(_,i)=>`<line x1="0" x2="289" y1="${i*52}" y2="${i*52}"/>`).join('')}</g></svg>`);
function draw(lines: LineInput[]) {
  const result = composeAiSvg([1024,1366], [{region:'schedule',lines}], regions);
  const rects = [...result.svg.matchAll(/<rect\b[^>]*fill-opacity="[^"]+"[^>]*\/>/g)].map(m => {
    const n=(key:string)=>Number(new RegExp(`\\b${key}="([^"]+)"`).exec(m[0])?.[1]);
    return {x:n('x'),y:n('y'),w:n('width'),h:n('height')};
  });
  return {...result, rects};
}
test('20-minute meeting ends before 8:25 class, with neither endpoint snapped',()=>{
  const {rects:[a,b]}=draw([{text:'Meeting',time:'08:00',endTime:'08:20',size:13},{text:'Class',time:'08:25',endTime:'09:25',size:13}]);
  assert.equal(a.y,52); assert.equal(a.h,17); assert.equal(b.y,74); assert.equal(b.h,52);
  assert.ok(a.y+a.h<b.y); assert.equal(a.x,b.x); assert.equal(a.w,b.w);
});
test('back-to-back off-half-hour conferences touch without overlap',()=>{
  const {rects:[a,b]}=draw([{text:'A',time:'13:15',durationMin:30},{text:'B',time:'13:45',durationMin:30}]);
  assert.equal(a.y,325); assert.equal(a.h,26); assert.equal(a.y+a.h,b.y); assert.equal(a.w,b.w);
});
test('real overlaps use separate lanes; later events regain full width',()=>{
  const {rects:[a,b,c]}=draw([{text:'A',time:'18:00',endTime:'18:55'}, {text:'B',time:'18:30',endTime:'19:30'}, {text:'C',time:'20:00',endTime:'21:00'}]);
  assert.ok(a.x+a.w<b.x); assert.equal(a.y,572); assert.equal(a.h,48); assert.equal(b.y,598); assert.equal(b.h,52);
  assert.ok(c.w>a.w); assert.equal(c.x,a.x);
});
test('unsorted nested and chained overlaps do not share a painted lane',()=>{
  const {rects}=draw([{text:'C',time:'09:30',endTime:'10:30'}, {text:'A',time:'08:00',endTime:'10:00'}, {text:'B',time:'08:30',endTime:'09:00'}, {text:'D',time:'08:45',endTime:'09:15'}]);
  for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++) {
    const a=rects[i],b=rects[j];
    if(a.y<b.y+b.h&&b.y<a.y+a.h)assert.ok(a.x+a.w<=b.x||b.x+b.w<=a.x);
  }
});
test('tiny events retain real duration and warn when even one text line cannot fit',()=>{
  const r=draw([{text:'Brief',time:'08:05',durationMin:5,size:13}]);
  assert.equal(r.rects[0].h,5);
  assert.ok(r.warningDetails.some(w=>w.code==='washi_block_label_overflow'));
});
