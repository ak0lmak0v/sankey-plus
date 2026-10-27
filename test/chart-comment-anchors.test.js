const test = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
globalThis.self = globalThis;
const {SankeyChart} = require('../dist/sankeyPlus.js');

function fixture(t, highlights = false) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="chart"></div><button id="comments">Comments</button></body>',
    {pretendToBeVisual: true});
  const registry = new Map(), polls = new Map();
  let nextPoll = 0;
  if (highlights) {
    Object.defineProperty(dom.window, 'CSS', {value: {highlights: registry}});
    dom.window.setInterval = callback => { polls.set(++nextPoll, callback); return nextPoll; };
    dom.window.clearInterval = id => polls.delete(id);
  }
  const previous = {window: globalThis.window, document: globalThis.document};
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const chart = new SankeyChart({id: n => n.name, align: 'left', width: 1200, height: 700,
    scale: 0.3, nodes: {data: [{name: 'origin', horizontalSort: 0},
      {name: 'target', horizontalSort: 1}, {name: 'sink', horizontalSort: 2}], horizontalSort: true, width: 15},
    links: {data: [{source: 'origin', target: 'target', value: 37},
      {source: 'target', target: 'sink', value: 23}, {source: 'target', target: 'target', value: 17},
      {source: 'sink', target: 'origin', value: 13}], circularGap: 1, baseRadius: 5},
    arrows: {enabled: false}});
  chart.process(); chart.draw('chart');
  const doc = dom.window.document;
  const event = (element, type) => element.dispatchEvent(new dom.window.MouseEvent(type, {bubbles: true, button: 0}));
  const click = element => { event(element, 'mouseup'); event(element, 'click'); };
  t.after(() => { chart._disposeLabelSelection(); dom.window.close(); Object.assign(globalThis, previous); });
  const annotate = (element, name = 'display-comment-anchor') => {
    const range = doc.createRange(); range.selectNodeContents(element);
    registry.set(name, new Set([range]));
    return range;
  };
  const poll = () => { for (const callback of [...polls.values()]) callback(); };
  return {chart, doc, dom, event, click, registry, annotate, poll, polls};
}

test('node click exposes a real quote before document mouseup and keeps it on click', t => {
  const {doc, dom, click} = fixture(t);
  const label = doc.getElementById('chart-node-label-target');
  let hostQuote;
  doc.addEventListener('mouseup', () => { hostQuote = dom.window.getSelection().toString(); });
  click(label.parentElement.querySelector('rect'));
  assert.equal(hostQuote, 'target');
  assert.equal(dom.window.getSelection().toString(), 'target');
  assert.equal(doc.querySelectorAll('#chart-node-label-target').length, 1);
});

for (const kind of ['forward', 'return', 'self']) test(kind + ' link click selects its persistent percentage', t => {
  const {doc, dom, chart, click} = fixture(t);
  const link = chart.graph.links.find(l => kind === 'self' ? l.source === l.target :
    kind === 'return' ? l.source.name === 'sink' : l.source.name === 'origin');
  const path = [...doc.querySelectorAll('.sankey-link')].find(e => e.__data__ === link);
  click(path);
  const selection = dom.window.getSelection();
  assert.equal(selection.toString(), link.value + '%');
  const selected = selection.getRangeAt(0).commonAncestorContainer;
  const text = selected.nodeType === 1 ? selected : selected.parentElement;
  assert.ok(text.id.startsWith(`chart-link-${link.index}-`));
  assert.equal(dom.window.getComputedStyle(text).visibility, 'visible');
  assert.equal(text.parentElement.style.opacity, '1');
});

test('hover, dismissal, and redraw retain quote text and its surrounding context', t => {
  const {doc, dom, chart, click} = fixture(t);
  const allText = doc.body.textContent;
  const labels = [...doc.querySelectorAll('.sankey-comment-anchor')];
  const originalTextNodes = new Map(labels.map(e => [e, e.firstChild]));
  for (const rect of doc.querySelectorAll('.nodes rect')) click(rect);
  for (const path of doc.querySelectorAll('.sankey-link')) click(path);
  dom.window.getSelection().removeAllRanges();
  click(doc.querySelector('svg'));
  assert.equal(doc.body.textContent, allText, 'Annotation context must not depend on which element is hovered');
  for (const [element, textNode] of originalTextNodes) {
    assert.equal(element.firstChild, textNode, 'Keep live Range endpoints connected instead of replacing textContent');
    if (element.parentElement.classList.contains('link-label-group'))
      assert.equal(element.style.pointerEvents, 'none', 'Unpainted percentages must not intercept clicks');
    assert.notEqual(element.style.visibility, 'hidden', 'Annotation tools must still be able to resolve the quote');
  }
  const quotes = labels.map(e => [e.id, e.textContent]);
  chart.draw('chart');
  assert.equal(doc.body.textContent, allText, 'The same graph must retain the same quote context after redraw');
  for (const [id, quote] of quotes) assert.equal(doc.getElementById(id).textContent, quote);
});

test('accessible descriptions do not add invisible duplicate node names and values to quote text', t => {
  const {doc} = fixture(t);
  assert.equal(doc.querySelectorAll('svg title').length, 0,
    'Hidden SVG title text makes short quotes resolve to an invisible duplicate');
  assert.equal(doc.querySelector('#chart-node-label-target').parentElement.getAttribute('aria-label'), 'target');
  assert.ok([...doc.querySelectorAll('.links g')].every(e => /Value:/.test(e.getAttribute('aria-label'))));
});


test('existing node comment keeps its native highlight and suppresses a new quote', t => {
  const {doc, dom, click, annotate, poll} = fixture(t, true);
  const label = doc.getElementById('chart-node-label-target');
  annotate(label); poll();
  assert.ok(label.classList.contains('sankey-commented'));
  let delivered = 0;
  doc.addEventListener('click', () => delivered++);
  click(label);
  assert.equal(dom.window.getSelection().toString(), '', 'No selection means no duplicate host Comment pill');
  assert.equal(delivered, 1, 'Keep the native existing-thread click available to the host');
  assert.equal(label.parentElement.querySelector('rect').style.opacity, '1');
});

test('existing link comment remains painted at rest and blocks a new quote at either endpoint', t => {
  const {doc, dom, chart, click, annotate, poll} = fixture(t, true);
  const link = chart.graph.links.find(l => l.source.name === 'origin');
  const text = doc.getElementById(`chart-link-${link.index}-target-percent`);
  const path = [...doc.querySelectorAll('.sankey-link')].find(e => e.__data__ === link);
  annotate(text); poll();
  assert.equal(text.style.opacity, '1');
  assert.equal(text.parentElement.style.opacity, '1');
  assert.equal(text.style.pointerEvents, 'visiblePainted');
  click(path);
  assert.equal(dom.window.getSelection().toString(), '', 'A comment on either label belongs to the entire link');
  click(doc.querySelector('svg'));
  assert.equal(text.style.opacity, '1', 'Dismissal must not hide annotated percentages');
  click(text);
  assert.equal(dom.window.getSelection().toString(), '');
  assert.equal(path.style.strokeOpacity, String(chart.config.links.opacity));
});

test('focusing a host link comment applies the same emphasis as clicking its ribbon', t => {
  const {doc, dom, chart, click, annotate, registry, poll} = fixture(t, true);
  const link = chart.graph.links.find(l => l.source.name === 'origin');
  const path = [...doc.querySelectorAll('.sankey-link')].find(e => e.__data__ === link);
  const text = doc.getElementById(`chart-link-${link.index}-target-percent`);
  const opacities = () => [...doc.querySelectorAll('.sankey-link,.nodes rect')]
    .map(e => [e.style.strokeOpacity, e.style.opacity]);
  click(path);
  const expected = opacities();
  dom.window.getSelection().removeAllRanges(); click(doc.querySelector('svg'));
  annotate(text, 'display-comment-anchor-focused-open'); poll();
  assert.deepEqual(opacities(), expected);
  assert.equal(dom.window.getSelection().toString(), '', 'Opening an existing thread must not offer a new comment');
  registry.clear(); poll();
  assert.ok([...doc.querySelectorAll('.sankey-link')].every(e => e.style.strokeOpacity === String(chart.config.links.opacity)));
});

test('focusing a host node comment matches node click and preserves other annotated names', t => {
  const {doc, dom, click, annotate, registry, poll} = fixture(t, true);
  const target = doc.getElementById('chart-node-label-origin');
  const other = doc.getElementById('chart-node-label-sink');
  const opacities = () => [...doc.querySelectorAll('.sankey-link,.nodes rect')]
    .map(e => [e.style.strokeOpacity, e.style.opacity]);
  click(target.parentElement.querySelector('rect')); const expected = opacities();
  dom.window.getSelection().removeAllRanges(); click(doc.querySelector('svg'));
  annotate(other); annotate(target, 'display-comment-anchor-focused-open'); poll();
  assert.deepEqual(opacities(), expected);
  assert.equal(other.style.opacity, '1', 'Native comment highlighting must remain visible');
  registry.clear(); poll();
  click(target.parentElement.querySelector('rect'));
  assert.equal(dom.window.getSelection().toString(), 'origin', 'Without a comment, ordinary new-comment behavior returns');
});

test('host highlight transfers do not change anchor text or recreate ranges', t => {
  const {doc, chart, annotate, registry, poll, polls} = fixture(t, true);
  const label = doc.getElementById('chart-node-label-target');
  const textNode = label.firstChild, context = doc.body.textContent;
  const range = annotate(label); poll();
  registry.clear(); registry.set('display-comment-anchor-hover-open', new Set([range])); poll();
  assert.ok(label.classList.contains('sankey-commented'));
  registry.clear(); registry.set('display-comment-anchor-focused-open', new Set([range])); poll();
  assert.equal(label.firstChild, textNode);
  assert.equal(range.startContainer, label);
  assert.equal(doc.body.textContent, context);
  chart.draw('chart');
  assert.equal(polls.size, 1, 'Redraw must dispose the previous registry poller');
  poll();
  assert.equal(doc.querySelectorAll('.sankey-commented').length, 0, 'Ignore detached ranges until the host reanchors them');
  chart._disposeLabelSelection(); assert.equal(polls.size, 0);
});


test('direct node text click reaches the host before any new selection or chart emphasis', async t => {
  const {doc, dom, click} = fixture(t);
  const label = doc.getElementById('chart-node-label-target');
  let hostClick = false;
  doc.addEventListener('click', event => {
    if (event.target === label) {
      hostClick = true;
      assert.equal(dom.window.getSelection().isCollapsed, true,
        'The native host ignores existing-comment clicks while a new quote is selected');
      assert.equal(doc.querySelector('.sankey-link').style.strokeOpacity, '',
        'Do not move or dim chart elements before native hit testing');
    }
  });
  click(label);
  assert.ok(hostClick, 'Text clicks must bubble even when host highlight inspection is unavailable');
  await Promise.resolve();
  assert.equal(dom.window.getSelection().toString(), '');
  assert.equal(label.parentElement.querySelector('rect').style.opacity, '1');
});

test('percentage click keeps its original coordinates until the host handles the existing thread', async t => {
  const {doc, chart, click, annotate, poll} = fixture(t, true);
  const link = chart.graph.links.find(l => l.source.name === 'origin');
  const label = doc.getElementById(`chart-link-${link.index}-target-percent`);
  annotate(label); poll();
  const y = label.getAttribute('y');
  let delivered = false;
  doc.addEventListener('click', event => {
    if (event.target === label) {
      delivered = true;
      assert.equal(label.getAttribute('y'), y);
      assert.equal(doc.querySelector('.sankey-link').style.strokeOpacity, '');
    }
  });
  click(label); assert.ok(delivered);
  await Promise.resolve();
  assert.ok([...doc.querySelectorAll('.sankey-link')].some(e => e.style.strokeOpacity === '0.1'));
});
