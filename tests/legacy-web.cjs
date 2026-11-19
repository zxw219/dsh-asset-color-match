// Run: node 资产光影匹配工具_自检.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(code);
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(ids.length, new Set(ids).size, 'Duplicate DOM ids');
assert(!/<script[^>]+src=|<link[^>]+href=|\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/.test(html), 'Keep runtime offline');

// A small DOM/canvas double checks wiring and pixel data without launching a browser.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.value = ''; this.children = []; this.style = {};
    this.dataset = {}; this.handlers = {}; this.checked = false; this.innerHTML = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  removeChild(child) { this.children = this.children.filter(item => item !== child); }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  setAttribute(name, value) { this[name] = value; }
  querySelectorAll(selector) {
    if (selector !== 'input') return [];
    return [...this.innerHTML.matchAll(/<input\b([^>]+)>/g)].map(match => {
      const input = new Element('input');
      for (const attribute of match[1].matchAll(/data-([\w-]+)="([^"]*)"/g)) input.dataset[attribute[1]] = attribute[2];
      return input;
    });
  }
  getBoundingClientRect() { return {left: 0, top: 0, width: 1200, height: 800}; }
  getContext() {
    if (this.context) return this.context;
    const canvas = this;
    this.context = {
      drawImage(image) { if (image.pixels) canvas.pixels = new Uint8ClampedArray(image.pixels); },
      getImageData() { return {data: new Uint8ClampedArray(canvas.pixels || canvas.width * canvas.height * 4)}; },
      putImageData(image) { canvas.pixels = new Uint8ClampedArray(image.data); },
      fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}, fillText() {}, strokeRect() {}
    };
    return this.context;
  }
  toBlob(callback) { callback({width: this.width, height: this.height, pixels: this.pixels}); }
  click() { if (this.handlers.click) return this.handlers.click({target: this}); }
}
const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
elements.ccBand.value = 'master';
elements.exportSuffix.value = '_测试';
const sandbox = {
  console, Blob, URL, Uint8ClampedArray, Uint8Array, Float32Array,
  ImageData: class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } },
  document: {
    activeElement: null, body: new Element('body'),
    getElementById(id) { assert(elements[id], 'Missing DOM id ' + id); return elements[id]; },
    createElement(tag) { return new Element(tag); },
    querySelectorAll(selector) {
      if (selector === '.mode-btn') return ['costume','portrait','tint'].map(mode => { const el = new Element('button'); el.dataset.mode = mode; return el; });
      return [];
    }
  },
  window: {addEventListener() {}}, navigator: {},
  localStorage: {getItem() { return null; }, setItem() {}},
  setTimeout(callback, ms) { if (ms === 0) queueMicrotask(callback); return 1; }, clearTimeout() {}, requestAnimationFrame(callback) { callback(); }
};
vm.createContext(sandbox);
const names = 'defaultGrade,defaultQuick,defaultKeyer,defaultCC,copyKeyer,copyCC,normalizePreset,computeEffectiveGrade,precomputeGradeCoeffs,applyPixelGrade,keyerValue,prepareCC,applyCC,preparePipeline,applyPixelNodes,computeGradedPreviewBytes,renderFullResBlob,applyPresetToAsset,applyNamedPresets,presetForAsset,saveBlob,makeExportName,buildNukeSnippet,linToSrgbByteExact,SRGB_TO_LIN,state,el,syncUIFromActive,updateButtons';
vm.runInContext(code.replace(/\}\)\(\);\s*$/, 'globalThis.api = {' + names + '};})();'), sandbox, {timeout: 3000});
const f = sandbox.api;
let checks = 0;
const equal = (actual, expected, tolerance = 1e-8) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert(Math.abs(value - expected[i]) <= tolerance, JSON.stringify({actual, expected})));
  checks++;
};
function asset(name = '角色_夏仁.png') {
  return {id: name, name, width: 2, height: 1, prevW: 2, prevH: 1,
    grade: f.defaultGrade(), quick: f.defaultQuick(), keyer: f.defaultKeyer(), cc: f.defaultCC(), gradeMask: false, mode: 'portrait',
    img: {pixels: new Uint8ClampedArray([128,100,80,255,240,220,200,128])},
    linRGB: new Float32Array([128,100,80,240,220,200].map(value => f.SRGB_TO_LIN[value])),
    alpha: new Uint8Array([255,128]), origBytes: new Uint8ClampedArray([128,100,80,255,240,220,200,128])};
}
const neutral = asset();
equal(f.applyPixelNodes(0.1,0.2,0.3,f.preparePipeline(neutral)).slice(0,3), [0.1,0.2,0.3]);
const negative = f.defaultGrade(); negative.blackClamp = false; negative.offset = [-0.3,-0.3,-0.3];
equal(f.applyPixelGrade(0.2,0.2,0.2,f.precomputeGradeCoeffs(f.computeEffectiveGrade(negative,f.defaultQuick()))), [-0.1,-0.1,-0.1]);
const high = f.defaultGrade(); high.multiply = [10,10,10]; high.gamma = [2,2,2];
equal(f.applyPixelGrade(0.2,0.2,0.2,f.precomputeGradeCoeffs(f.computeEffectiveGrade(high,f.defaultQuick()))), [1.5,1.5,1.5]);

// These Keyer expectations were measured against a one-pixel Nuke 17.1 Keyer.
const key = {...f.defaultKeyer(), enabled: true};
const expected = {red:0.8,green:0.3,blue:0.1,redscreen:0.5,greenscreen:1,bluescreen:1,luminance:0.39183,saturation:0.875,max:0.8,min:0.1};
for (const [operation, value] of Object.entries(expected)) equal([f.keyerValue(0.8,0.3,0.1,{...key,operation})], [value]);
const band = {...key, operation:'red', range:[0.2,0.4,0.6,0.8]};
for (const [input, output] of [[0.1,0],[0.2,0],[0.3,0.5],[0.4,1],[0.5,1],[0.6,1],[0.7,0.5],[0.8,0],[0.9,0]]) {
  equal([f.keyerValue(input,0,0,band)], [output]);
  equal([f.keyerValue(input,0,0,{...band,invert:true})], [1-output]);
}
const cc = f.defaultCC(); cc.enabled = true;
for (const value of [0,0.02,0.2,0.8,1]) equal(f.applyCC([value,value/2,value/3],f.prepareCC(cc)), [value,value/2,value/3]);
cc.master.gain = [2,1,0.5];
equal(f.applyCC([0.2,0.4,0.6],f.prepareCC(cc)), [0.4,0.4,0.3]);
cc.master.gain = [1,1,1]; cc.master.saturation = [0,0,0];
equal(f.applyCC([0.8,0.3,0.1],f.prepareCC(cc)), [0.39183,0.39183,0.39183]);
const ranges = f.defaultCC(); ranges.enabled = true; ranges.shadows.offset = [0.1,0.1,0.1]; ranges.highlights.gain = [2,2,2];
equal(f.applyCC([0,0,0],f.prepareCC(ranges)), [0.1,0.1,0.1]);
equal(f.applyCC([0.2,0.2,0.2],f.prepareCC(ranges)), [0.2,0.2,0.2]);
equal(f.applyCC([1,1,1],f.prepareCC(ranges)), [2,2,2]);
const nativeCC = f.defaultCC(); nativeCC.enabled = true;
nativeCC.master.gamma = [0.9,1.1,1]; nativeCC.master.contrast = [1.05,0.95,1.1];
nativeCC.master.gain = [0.9,1,1.1]; nativeCC.master.offset = [0.01,-0.005,0.02];
nativeCC.shadows.gain = [0.8,0.9,1.1]; nativeCC.midtones.saturation = [0.8,0.9,1]; nativeCC.highlights.gamma = [1.1,1,0.9];
for (const [input, expected] of [
  [[0.02,0.01,0.005],[0.018302779644727707,0.01069323718547821,0.024209916591644287]],
  [[0.8,0.3,0.1],[0.6830070614814758,0.33064520359039307,0.12372070550918579]],
  [[0.9,0.8,0.7],[0.8808891773223877,0.7582364082336426,0.8873008489608765]]
]) equal(f.applyCC(input,f.prepareCC(nativeCC)),expected,1e-5);
const masked = asset(); masked.keyer = band; masked.gradeMask = true; masked.grade.multiply = [2,2,2];
equal(f.applyPixelNodes(0.1,0.2,0.3,f.preparePipeline(masked)).slice(0,3), [0.1,0.2,0.3]);
equal(f.applyPixelNodes(0.5,0.2,0.3,f.preparePipeline(masked)).slice(0,3), [1,0.4,0.6]);
masked.gradeMask = false; masked.grade = f.defaultGrade(); masked.cc.enabled = true; masked.cc.useKeyer = true; masked.cc.master.gain = [2,2,2];
equal(f.applyPixelNodes(0.1,0.2,0.3,f.preparePipeline(masked)).slice(0,3), [0.1,0.2,0.3]);
equal(f.applyPixelNodes(0.5,0.2,0.3,f.preparePipeline(masked)).slice(0,3), [1,0.4,0.6]);

const roundtrip = f.normalizePreset(JSON.parse(JSON.stringify(f.presetForAsset(masked))));
const restored = asset(); f.applyPresetToAsset(restored,roundtrip);
equal(f.applyPixelNodes(0.5,0.2,0.3,f.preparePipeline(restored)), f.applyPixelNodes(0.5,0.2,0.3,f.preparePipeline(masked)));
restored.cc.master.gain[0] = 7;
assert.equal(roundtrip.cc.master.gain[0], 2);
const oldPreset = f.normalizePreset({name:'旧预设',grade:f.defaultGrade()});
assert(!oldPreset.cc.enabled && !oldPreset.keyer.enabled);
for (const bad of [{grade:{gamma:[0,1,1]}},{grade:{gain:[Infinity,1,1]}},{grade:{},keyer:{range:[0.3,0.2,0.8,1]}},{grade:{},cc:{master:{gamma:[-1,1,1]}}}]) assert.throws(() => f.normalizePreset(bad));
checks += 6;

(async () => {
  neutral.grade.multiply = [0.7,0.8,0.9]; neutral.cc.enabled = true; neutral.cc.master.offset = [0.01,0.02,0.03];
  f.state.showKey = false;
  const preview = f.computeGradedPreviewBytes(neutral);
  const output = await f.renderFullResBlob(neutral);
  assert.equal(output.width,2); assert.equal(output.height,1);
  equal([...preview], [...output.pixels], 1);
  f.state.showKey = true;
  const normalExportWhileViewingMask = await f.renderFullResBlob(neutral);
  equal([...normalExportWhileViewingMask.pixels], [...output.pixels]);
  neutral.keyer.enabled = true; neutral.keyer.exportAlpha = true;
  const alphaExport = await f.renderFullResBlob(neutral);
  assert(alphaExport.pixels[3] < 255 && alphaExport.pixels[7] < 128);
  checks++;
  f.el.exportSuffix.value = '/';
  assert.equal(f.makeExportName('角色.png'), '角色_调色.png');
  const files = new Map([['角色_调色.png','old'],['角色_调色_1.png','older']]);
  f.state.dirHandle = {async getFileHandle(name,options) {
    if (!files.has(name) && !options?.create) { const error=new Error('missing'); error.name='NotFoundError'; throw error; }
    return {async createWritable() { return {async write(blob) {files.set(name,blob);},async close(){}}; }};
  }};
  await f.saveBlob('new', f.makeExportName('角色.png'));
  assert.equal(files.get('角色_调色.png'),'old'); assert.equal(files.get('角色_调色_1.png'),'older'); assert.equal(files.get('角色_调色_2.png'),'new');
  checks += 4;
  const left=asset('左.png'), right=asset('右.png');
  f.state.assets=[left,right]; f.state.activeId=left.id; f.state.viewMode='final';
  const named=f.normalizePreset({...f.presetForAsset(masked),files:['左.png']});
  f.state.importedPresets=[named];
  assert.equal(f.applyNamedPresets(),1); assert(left.cc.enabled); assert(!right.cc.enabled);
  assert.throws(() => f.buildNukeSnippet(left));
  assert(f.buildNukeSnippet(right).startsWith('Grade {'));
  f.el.btnReset.click(); assert(!left.cc.enabled && !left.keyer.enabled); assert(!right.cc.enabled);
  checks += 6;
  f.state.assets=[asset('重复.png'),asset('重复.png')]; f.state.activeId='重复.png';
  f.state.importedPresets=[f.normalizePreset({...f.presetForAsset(masked),files:['重复.png']})];
  assert.equal(f.applyNamedPresets(),0); assert(f.state.assets.every(a => !a.cc.enabled));
  f.state.exporting=true; f.updateButtons(); assert(f.el.btnExportOne.disabled && f.el.btnExportAll.disabled);
  f.state.exporting=false;
  const pack=JSON.parse(fs.readFileSync(path.join(__dirname,'../examples/上山前_已确认配色参数包.json'),'utf8'));
  assert.equal(pack.presets.length,4); assert(!JSON.stringify(pack).includes('大师姐'));
  f.state.assets=pack.presets.map(p => asset(p.files[0])); f.state.activeId=f.state.assets[0].id;
  f.el.presetFileInput.files=[{async text(){return JSON.stringify(pack);}}];
  await f.el.presetFileInput.handlers.change();
  for (let i=0;i<pack.presets.length;i++) {
    equal(f.state.assets[i].grade.multiply,pack.presets[i].grade.multiply);
    assert(!f.state.assets[i].cc.enabled && !f.state.assets[i].keyer.enabled);
  }
  const beforeImport=f.state.importedPresets;
  f.el.presetFileInput.files=[{async text(){return '[{"grade":{"gamma":[0,1,1]}}]';}}];
  await f.el.presetFileInput.handlers.change();
  assert.equal(f.state.importedPresets,beforeImport);
  assert(f.el.toast.textContent.includes('无效'));
  checks += 8;
  const bridge=sandbox.window.assetColorMatch;
  const first=asset('bridge-a.png'), second=asset('bridge-b.png');
  f.state.assets=[first,second]; f.state.activeId=first.id;
  bridge.setParameters([{id:first.id,grade:{multiply:[0.8,0.9,1]},cc:{enabled:true,shadows:{gain:[0.9,1,1]}}}]);
  equal(first.grade.multiply,[0.8,0.9,1]); equal(first.cc.shadows.gain,[0.9,1,1]);
  equal(first.cc.master.gamma,[1,1,1]); assert(!second.cc.enabled);
  const frozen=JSON.stringify(bridge.snapshot());
  assert.throws(()=>bridge.setParameters([{id:first.id,grade:{multiply:[0.1,0.1,0.1]}},{id:second.id,grade:{gamma:[0,1,1]}}]));
  assert.equal(JSON.stringify(bridge.snapshot()),frozen);
  assert.throws(()=>bridge.setParameters([{id:first.id},{id:first.id}]));
  const exporter=bridge.renderExports([first.id,second.id],'_输出');
  const bridgeOutput=await exporter.next();
  assert.equal(bridgeOutput.value.blob.width,2); assert.equal(bridgeOutput.value.name,'bridge-a_输出.png');
  second.grade.multiply=[0.2,0.2,0.2];
  const nextOutput=await exporter.next();
  equal(nextOutput.value.parameters.grade.multiply,[1,1,1]);
  assert.equal((await exporter.next()).done,true);
  checks+=7;
  console.log('PASS: ' + checks + ' pixel, Keyer, CC, preset, UI-wiring and safe-export checks.');
  console.log('Note: canvas and DOM are test doubles; real browser interaction is not covered.');
})().catch(error => {console.error(error);process.exitCode=1;});
