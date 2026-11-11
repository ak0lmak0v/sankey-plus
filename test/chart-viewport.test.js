const test = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
globalThis.self = globalThis;
const {SankeyChart} = require('../dist/sankeyPlus.js');

test('painted bounds fit the viewport after centering at the original scale', t => {
  const dom = new JSDOM('<!DOCTYPE html><div id="chart"></div>');
  const previous = {window: globalThis.window, document: globalThis.document};
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const box = {x: -30, y: -50, width: 330, height: 460};
  dom.window.SVGElement.prototype.getBBox = () => box;
  const chart = new SankeyChart({id: n => n.name, width: 290, height: 400,
    nodes: {data: [{name: 'a'}, {name: 'b'}]},
    links: {data: [{source: 'a', target: 'b', value: 10}, {source: 'b', target: 'a', value: 8}]},
    arrows: {enabled: false}});
  t.after(() => {
    chart._disposeLabelSelection?.();
    dom.window.close();
    Object.assign(globalThis, previous);
  });
  chart.process();
  chart.draw('chart');
  const svg = dom.window.document.querySelector('svg');
  const [x, y, width, height] = (svg.getAttribute('viewBox') || '0 0 290 400').split(' ').map(Number);
  const translation = svg.querySelector('g').getAttribute('transform');
  const shift = Number(translation.match(/translate\(0,([^)]*)\)/)[1]);
  const halfStroke = Math.max(1, ...chart.graph.links.map(link => link.width)) / 2;
  assert.equal(width, Number(svg.getAttribute('width')));
  assert.equal(height, Number(svg.getAttribute('height')));
  assert.ok(box.x - halfStroke >= x && box.x + box.width + halfStroke <= x + width);
  assert.ok(box.y + shift - halfStroke >= y && box.y + shift + box.height + halfStroke <= y + height);
});
