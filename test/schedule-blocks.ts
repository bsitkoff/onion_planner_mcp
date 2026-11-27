import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRegions } from '../src/template.js';
import { composeAiSvg, type LineInput } from '../src/svg.js';
const regions = parseRegions(`<svg><g id="region-schedule" data-region="schedule" data-start-hour="7" data-rows-per-hour="1" transform="translate(56,378)"><rect width="289" height="778"/>${Array.from({length:15},(_,i)=>`<line x1="0" x2="289" y1="${i*52}" y2="${i*52}"/>`).join('')}</g></svg>`);
// Edges are exact-minute (unrounded, app parity); compare with a small tolerance.
const near=(a:number,b:number,tol=0.01)=>assert.ok(Math.abs(a-b)<=tol,`${a} !~ ${b}`);
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
  near(a.y,52); near(a.h,17.333); near(b.y,73.667); near(b.h,52);
  assert.ok(a.y+a.h<b.y); near(a.x,b.x); assert.equal(a.w,b.w);
});
test('back-to-back off-half-hour conferences touch without overlap',()=>{
  const {rects:[a,b]}=draw([{text:'A',time:'13:15',durationMin:30},{text:'B',time:'13:45',durationMin:30}]);
  near(a.y,325); near(a.h,26); near(a.y+a.h,b.y); assert.equal(a.w,b.w);
});
test('real overlaps use separate lanes; later events regain full width',()=>{
  const {rects:[a,b,c]}=draw([{text:'A',time:'18:00',endTime:'18:55'}, {text:'B',time:'18:30',endTime:'19:30'}, {text:'C',time:'20:00',endTime:'21:00'}]);
  assert.ok(a.x+a.w<b.x); near(a.y,572); near(a.h,47.667); near(b.y,598); near(b.h,52);
  assert.ok(c.w>a.w); near(c.x,a.x);
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
  near(r.rects[0].h,4.333);
  assert.ok(r.warningDetails.some(w=>w.code==='washi_block_label_overflow'));
});

// --- Scope of the app-parity placement (48/20, timed line at 48): schedule + agenda only. ---
const tpl = (name: string, gutter: number) =>
  parseRegions(`<svg><g id="region-${name}" data-region="${name}" data-start-hour="7" data-rows-per-hour="1" transform="translate(56,378)"><rect width="289" height="778"/>${Array.from({length:15},(_,i)=>`<line x1="${gutter}" x2="289" y1="${i*52}" y2="${i*52}"/>`).join('')}</g></svg>`);
function drawIn(name: string, gutter: number, lines: LineInput[]) {
  const regs = tpl(name, gutter);
  const result = composeAiSvg([1024,1366], [{region:name,lines}], regs);
  const rect = /<rect\b[^>]*fill-opacity="[^"]+"[^>]*\/>/.exec(result.svg);
  const n=(s:string,key:string)=>Number(new RegExp(`\\b${key}="([^"]+)"`).exec(s)?.[1]);
  const texts=[...result.svg.matchAll(/<text\b([^>]*)>/g)].map(m=>({x:n(m[1],'x'),y:n(m[1],'y')}));
  return {result, width: regs[0].width!, rect: rect ? {x:n(rect[0],'x'),w:n(rect[0],'width')} : null, texts};
}
test('non-schedule region keeps the generic 24/24 block inset and 12px label pad',()=>{
  const {rect,width,texts}=drawIn('morning',0,[{text:'Hike',time:'09:00',endTime:'10:00'}]);
  near(rect!.x,24); near(rect!.w,width-24-24); near(texts[0].x,24+12);
});
test('agenda region blocks and plain timed lines both sit at x 48 (app draws both at 48)',()=>{
  for(const gutter of [0,34]){
    const {rect,width,texts}=drawIn('agenda',gutter,[{text:'Hike',time:'09:00',endTime:'10:00'},{text:'Call',time:'11:00'}]);
    near(rect!.x,48); near(rect!.w,width-48-20); near(texts[0].x,56);
    const call=texts.find(t=>t.y>texts[0].y)!;
    near(call.x,48);
  }
});
test('schedule: plain timed line x is 48 (F6), explicit x wins',()=>{
  const {texts}=drawIn('schedule',34,[{text:'Call',time:'09:00'},{text:'Pin',time:'10:00',x:70}]);
  near(texts[0].x,48); near(texts[1].x,70);
});
test('schedule: zero-duration block fallback line sits at x 48',()=>{
  const {texts,result}=drawIn('schedule',34,[{text:'Edge',time:'21:00',endTime:'21:00'}]);
  assert.ok(result.warningDetails.some(w=>w.code==='washi_block_zero_duration'));
  near(texts[0].x,48);
});
test('wrapped label pitch is the unrounded size*1.3 = 19.5 (F5)',()=>{
  // Baselines are emitted rounded, so assert on the span: N-1 pitches of 19.5 (a rounded
  // pitch of 20 would add 0.5 per gap, exceeding the +/-1 rounding slack from 4 lines on).
  const text='Robotics team meeting with the whole club plus parents and many many more guests joining us for a long afternoon';
  const {texts}=drawIn('schedule',34,[{text,time:'09:00',endTime:'13:00',size:15}]);
  const n=texts.length;
  assert.ok(n>=4,`expected >=4 wrapped lines, got ${n}`);
  near(texts[n-1].y-texts[0].y,(n-1)*19.5,1);
});

// --- Non-schedule regions render exactly as on baseline a1cbcb1 (rounded edges/pitch). ---
function drawFull(name: string, lines: LineInput[]) {
  const regs = tpl(name, 0);
  const result = composeAiSvg([1024,1366], [{region:name,lines}], regs);
  const rect = /<rect\b[^>]*fill-opacity="[^"]+"[^>]*\/>/.exec(result.svg);
  const n=(s:string,key:string)=>Number(new RegExp(`\\b${key}="([^"]+)"`).exec(s)?.[1]);
  const texts=[...result.svg.matchAll(/<text\b([^>]*)>/g)].map(m=>({x:n(m[1],'x'),y:n(m[1],'y')}));
  return {result, rect: rect ? {y:n(rect[0],'y'),h:n(rect[0],'height')} : null, texts};
}
test('non-schedule region: sub-row block edges are rounded, label on the rounded baseline',()=>{
  const {rect,texts}=drawFull('morning',[{text:'Class',time:'08:25',endTime:'09:25',size:15}]);
  assert.equal(rect!.y,74); assert.equal(rect!.h,52); assert.equal(texts[0].y,105);
});
test('non-schedule region: wrapped label uses round(size*1.3) pitch and overflows as on baseline',()=>{
  const {result,texts}=drawFull('morning',[{text:'Robotics team meeting with everyone',time:'08:00',endTime:'08:45',size:15}]);
  assert.ok(texts.length>=2);
  assert.equal(texts[1].y-texts[0].y,20);
  assert.ok(result.warningDetails.some(w=>w.code==='washi_block_label_overflow'));
});
test('schedule and agenda: timed line baseline stays the baseline value round(rule + round(0.4*52)) = rule + 21 (F7 split out)',()=>{
  // Pins the split: the app's row + size*0.78 is a follow-up PR with a collision fix.
  for(const name of ['schedule','agenda']){
    const {texts}=drawIn(name,34,[{text:'Call',time:'09:00',size:15}]);
    assert.equal(texts[0].y,125);
  }
});
test('schedule: last-rule zero-duration fallback baseline is the baseline value',()=>{
  const {texts}=drawIn('schedule',34,[{text:'Edge',time:'21:00',endTime:'21:00',size:15}]);
  assert.equal(texts[0].y,749);
});
test('non-schedule region: timed line baseline keeps round(rule + round(0.4*52)) = rule + 21',()=>{
  const {texts}=drawFull('morning',[{text:'Call',time:'09:00',size:15}]);
  assert.equal(texts[0].y,125);
});

test('schedule label wrap width is block width - 16 (F2), scoped to schedule/agenda',()=>{
  // Region 289 wide. Schedule block: x 48, right inset 20 -> width 221, inner 221-16 = 205
  // (the generic 12px pad would give 197). Mulish 10px: width per char = round(n*10*0.52).
  const label=(n:number)=>'x'.repeat(n);
  const est=(n:number)=>Math.round(n*10*0.52);
  assert.ok(est(39)>197&&est(39)<=205,`est(39)=${est(39)}`);   // between the two inner widths
  assert.ok(est(41)>205&&est(41)<=217,`est(41)=${est(41)}`);   // over app width, under generic 289-24-24-24=217
  const lines=(name:string,n:number)=>{
    const r=drawIn(name,0,[{text:label(n),time:'09:00',endTime:'12:00',size:10}]).result;
    assert.match(r.svg,/font-family="Mulish"/);
    return [...r.svg.matchAll(/<text\b/g)].length;
  };
  assert.equal(lines('schedule',39),1);   // fails if the schedule inner width regresses to 197
  assert.equal(lines('agenda',39),1);
  assert.equal(lines('schedule',41),2);   // wraps past 205
  assert.equal(lines('morning',41),1);    // non-schedule keeps inner width 217 (24/24 insets, 12px pad)
});
