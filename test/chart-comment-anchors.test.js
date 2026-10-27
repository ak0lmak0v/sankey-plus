const test = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
globalThis.self = globalThis;
const {SankeyChart} = require('../dist/sankeyPlus.js');

function fixture(t) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="chart"></div><button id="comments">Comments</button></body>',
    {pretendToBeVisual: true});
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
  return {chart, doc, dom, event, click};
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
