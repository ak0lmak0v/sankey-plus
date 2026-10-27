const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let linkLabelSelection, selectCommentText;
test.before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/linkLabelSelection.js'), 'utf8');
  ({linkLabelSelection, selectCommentText} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')));
});

// Minimal native event/selection boundary: no chart/customer fixture required.
function fixture() {
  let selected = null, holdCount = 0, cancelCount = 0;
  const element = parent => {
    const node = new EventTarget();
    node.parent = parent;
    node.contains = child => { for (; child; child = child.parent) if (child === node) return true; return false; };
    return node;
  };
  const svg = element(), layer = element(svg), label = element(layer), name = element(svg);
  const toolbar = element(), background = element(svg);
  label.textContent = '17%'; name.textContent = 'Stage';
  const selection = {
    get isCollapsed() { return !selected; },
    get rangeCount() { return selected ? 1 : 0; },
    removeAllRanges() { selected = null; },
    addRange(range) { selected = range; },
    getRangeAt() { return selected; },
    toString() { return selected?.element.textContent || ''; }
  };
  const document = {
    defaultView: {getSelection: () => selection},
    createRange: () => ({
      selectNodeContents(node) { this.element = node; },
      intersectsNode(node) { return node.contains(this.element); }
    })
  };
  svg.ownerDocument = label.ownerDocument = name.ownerDocument = document;
  const guard = () => linkLabelSelection(svg, layer, () => holdCount++, () => cancelCount++);
  return {svg, layer, label, name, toolbar, background, selection, guard,
    counts: () => ({holdCount, cancelCount})};
}

test('native ranges select a percentage or the full node name', () => {
  const f = fixture();
  assert.ok(selectCommentText(f.label));
  assert.equal(f.selection.toString(), '17%');
  assert.ok(selectCommentText(f.name));
  assert.equal(f.selection.toString(), 'Stage');
  assert.equal(f.selection.rangeCount, 1, 'Replace the previous quote rather than accumulating ranges');
});

test('empty / unavailable labels do not destroy an existing selection', () => {
  const f = fixture();
  selectCommentText(f.name);
  assert.equal(selectCommentText(null), false);
  f.label.textContent = '  ';
  assert.equal(selectCommentText(f.label), false);
  assert.equal(f.selection.toString(), 'Stage');
  f.label.ownerDocument.defaultView.getSelection = () => null;
  assert.equal(selectCommentText(f.name), false);
});

test('percentage text remains available when moving to the host comment editor', () => {
  const f = fixture(), guard = f.guard();
  f.layer.dispatchEvent(new Event('mouseover'));
  f.layer.dispatchEvent(new Event('pointerdown'));
  assert.ok(guard.active());
  assert.deepEqual(f.counts(), {holdCount: 1, cancelCount: 2});
  // Clicking the host editor may collapse the browser selection first.
  f.selection.removeAllRanges();
  assert.ok(guard.keepOnClick({target: f.toolbar}));
  assert.equal(guard.keepOnClick({target: f.background}), false);
  guard.release();
  assert.equal(guard.active(), false);
  assert.equal(guard.keepOnClick({target: f.toolbar}), false);
  guard.dispose();
});

test('selection guards preserve native mouse events needed by host comments', () => {
  const f = fixture(), guard = f.guard();
  const event = new Event('pointerdown', {cancelable: true});
  let delivered = false;
  f.layer.addEventListener('pointerdown', () => { delivered = true; });
  f.layer.dispatchEvent(event);
  assert.ok(delivered);
  assert.equal(event.defaultPrevented, false);
  assert.ok(guard.keepOnClick({target: f.label}));
  guard.dispose();
});

test('an active browser quote protects percentage text even without a pointer event', () => {
  const f = fixture(), guard = f.guard();
  selectCommentText(f.label);
  assert.ok(guard.keepOnClick({target: f.toolbar}));
  f.selection.removeAllRanges();
  assert.equal(guard.keepOnClick({target: f.toolbar}), false);
  guard.dispose();
});

test('redraw disposal detaches old label handlers', () => {
  const f = fixture(), guard = f.guard();
  guard.hold();
  guard.dispose();
  f.layer.dispatchEvent(new Event('mouseover'));
  f.layer.dispatchEvent(new Event('pointerdown'));
  assert.equal(guard.active(), false);
  assert.deepEqual(f.counts(), {holdCount: 1, cancelCount: 1});
});
