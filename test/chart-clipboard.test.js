const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
let copyChartText, chartElementText;
test.before(async () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/chartClipboard.js'), 'utf8');
  ({copyChartText, chartElementText} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')));
});
function fixture(t) {
  const dom = new JSDOM('<body><svg><text>Original quote</text></svg></body>');
  const doc = dom.window.document, svg = doc.querySelector('svg');
  const range = doc.createRange(); range.selectNodeContents(doc.querySelector('text'));
  const selection = dom.window.getSelection(); selection.addRange(range);
  t.after(() => dom.window.close());
  let value, calls = 0;
  doc.execCommand = command => {
    assert.equal(command, 'copy'); calls++;
    const event = new dom.window.Event('copy', {cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: {setData(type, text) {
      assert.equal(type, 'text/plain'); value = text;
    }}});
    doc.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return {doc, dom, svg, selection, range, contents: () => value, calls: () => calls};
}
for (const mode of ['unavailable', 'rejects', 'throws'])
  test('legacy copy when clipboard API ' + mode + ' preserves comment text, focus and native range', async t => {
    const f = fixture(t), context = f.doc.body.textContent, focus = f.doc.activeElement;
    if (mode !== 'unavailable') Object.defineProperty(f.dom.window.navigator, 'clipboard', {value: {
      writeText() { if (mode === 'throws') throw new Error('Unavailable'); return Promise.reject(new Error('Unavailable')); }
    }});
    assert.equal(await copyChartText(f.svg, 'alpha → beta'), true);
    assert.equal(f.contents(), 'alpha → beta'); assert.equal(f.calls(), 1);
    assert.equal(f.selection.getRangeAt(0), f.range);
    assert.equal(f.selection.toString(), 'Original quote');
    assert.equal(f.doc.body.textContent, context);
    assert.equal(f.doc.activeElement, focus);
    // The scoped copy listener must not affect any subsequent manual copy.
    assert.equal(f.doc.dispatchEvent(new f.dom.window.Event('copy', {cancelable: true})), true);
  });

test('successful modern clipboard writes once and leaves the legacy API untouched', async t => {
  const f = fixture(t), values = [];
  Object.defineProperty(f.dom.window.navigator, 'clipboard', {value: {writeText: text => {values.push(text); return Promise.resolve();}}});
  assert.ok(await copyChartText(f.svg, 'alpha'));
  assert.deepEqual(values, ['alpha']); assert.equal(f.calls(), 0);
  assert.equal(f.selection.toString(), 'Original quote');
});

test('a failed copy does not throw into diagram or host comment handling', async t => {
  const f = fixture(t); f.doc.execCommand = () => { throw new Error('No support'); };
  assert.equal(await copyChartText(f.svg, 'alpha'), false);
  assert.equal(f.selection.toString(), 'Original quote');
  delete f.doc.execCommand;
  assert.equal(await copyChartText(f.svg, 'alpha'), false);
});

test('legacy node and route formatting uses full ids, including self links', () => {
  assert.equal(chartElementText({name: 'post_alpha'}), 'post_alpha');
  assert.equal(chartElementText({source: {name: 'alpha'}, target: {name: 'alpha'}}, true), 'alpha → alpha');
  assert.equal(chartElementText({source: 'alpha', target: 'beta'}, true), 'alpha → beta');
});
