const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
let displayCommentHighlights, clearChartSelection;
test.before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/displayCommentHighlights.js'), 'utf8');
  ({displayCommentHighlights, clearChartSelection} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')));
});
function fixture(t, supported = true) {
  const dom = new JSDOM('<body><p>Report context</p><svg><text class="sankey-comment-anchor"><tspan>Stage</tspan><tspan>alpha</tspan></text><text class="sankey-comment-anchor">Stage beta</text></svg><svg><text class="sankey-comment-anchor">Elsewhere</text></svg></body>');
  const doc = dom.window.document, svg = doc.querySelector('svg');
  const registry = new Map(), updates = [];
  let tick, clears = 0;
  if (supported) Object.defineProperty(dom.window, 'CSS', {value: {highlights: registry}});
  dom.window.setInterval = fn => { tick = fn; return 1; };
  dom.window.clearInterval = () => { clears++; };
  const adapter = displayCommentHighlights(svg, state => updates.push(state));
  const range = element => { const r = doc.createRange(); r.selectNodeContents(element); return r; };
  t.after(() => { adapter.dispose(); dom.window.close(); });
  return {dom, doc, svg, registry, updates, adapter, range, tick: () => tick?.(), clears: () => clears};
}

test('reads multiline ranges without changing the native registry and emits only changed states', t => {
  const f = fixture(t), text = f.svg.querySelector('text'), spans = text.querySelectorAll('tspan');
  const range = f.doc.createRange();
  range.setStart(spans[0].firstChild, 1); range.setEnd(spans[1].firstChild, 3);
  const highlight = new Set([range]);
  f.registry.set('display-comment-anchor', highlight); f.adapter.refresh();
  assert.deepEqual([...f.updates[0].annotated], [text]);
  f.adapter.refresh(); assert.equal(f.updates.length, 1);
  assert.equal(f.registry.get('display-comment-anchor'), highlight);
  f.registry.clear(); f.registry.set('display-comment-anchor-focused-resolved', highlight); f.adapter.refresh();
  assert.equal(f.updates[1].focused, text);
  assert.ok(f.updates[1].focusChanged);
});

test('ignores unrelated highlights, other charts, collapsed and cross-element ranges', t => {
  const f = fixture(t), labels = f.svg.querySelectorAll('text');
  const collapsed = f.range(labels[0]); collapsed.collapse(true);
  const crossing = f.doc.createRange();
  crossing.setStart(labels[0].firstChild.firstChild, 0); crossing.setEnd(labels[1].firstChild, 3);
  f.registry.set('display-comment-anchor', new Set([collapsed, crossing, f.range(f.doc.querySelector('p')),
    f.range(f.doc.querySelectorAll('svg')[1].querySelector('text'))]));
  f.registry.set('unrelated-highlight', new Set([f.range(labels[0])]));
  f.adapter.refresh(); assert.equal(f.updates.length, 0);
});

test('polling pauses while hidden and disposes when a chart is detached', t => {
  const f = fixture(t);
  Object.defineProperty(f.doc, 'visibilityState', {configurable: true, value: 'hidden'});
  f.registry.set('display-comment-anchor', new Set([f.range(f.svg.querySelector('text'))]));
  f.tick(); assert.equal(f.updates.length, 0);
  Object.defineProperty(f.doc, 'visibilityState', {configurable: true, value: 'visible'});
  f.tick(); assert.equal(f.updates.length, 1);
  f.svg.remove(); f.tick(); assert.equal(f.clears(), 1);
  f.registry.clear(); f.adapter.refresh(); assert.equal(f.updates.length, 1);
});

test('unsupported browsers preserve ordinary chart operation without a polling timer', t => {
  const f = fixture(t, false);
  f.adapter.refresh(); f.tick(); assert.equal(f.updates.length, 0);
});

test('selection dismissal is scoped to this chart, preserving unrelated report quotes', t => {
  const f = fixture(t), selection = f.dom.window.getSelection();
  selection.addRange(f.range(f.doc.querySelector('p')));
  clearChartSelection(f.svg); assert.equal(selection.toString(), 'Report context');
  selection.removeAllRanges(); selection.addRange(f.range(f.svg.querySelector('text')));
  clearChartSelection(f.svg); assert.equal(selection.rangeCount, 0);
});
