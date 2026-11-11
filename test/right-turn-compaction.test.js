const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/rightTurnCompaction.js'), 'utf8');
const helper = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function draw(link) {
  const c = link.circularPathData;
  const departure = c.rightDepartureInnerExtent ?? c.rightInnerExtent;
  const radius = c.rightSourceLargeArcRadius ?? c.rightLargeArcRadius;
  return `M${c.sourceX} ${c.sourceY}L${departure} ${c.sourceY}` +
    `A${radius} ${c.rightSmallArcRadius} 0 0 0 ${c.rightFullExtent} ${c.sourceY - c.rightSmallArcRadius}` +
    `L${c.rightFullExtent} ${c.verticalRightInnerExtent}` +
    `A${c.rightLargeArcRadius} ${c.rightLargeArcRadius} 0 0 0 ${c.rightShelfInnerExtent ?? c.rightInnerExtent} ${c.verticalFullExtent}` +
    `L50 ${c.verticalFullExtent}`;
}

function family() {
  const target = {column: 0};
  function route(sourceY, shelf, radius) {
    const link = {source: {column: 1}, target, circular: true, circularLinkType: 'top', width: 4,
      circularPathData: {sourceX: 100, sourceY, rightInnerExtent: 104, rightFullExtent: 104 + radius,
        rightSmallArcRadius: radius, rightLargeArcRadius: radius, verticalFullExtent: shelf,
        verticalRightInnerExtent: shelf + radius}};
    link.path = draw(link);
    return link;
  }
  return [route(80, 15, 6), route(120, 10, 18)];
}

test('right legs close an empty slot without widening the family or misaligning the shelf bend', async () => {
  const {compactRightTurnGaps} = await helper;
  const [inner, outer] = family();
  compactRightTurnGaps({links: [inner, outer], nodes: []}, 1, draw);
  const a = inner.circularPathData, b = outer.circularPathData;
  assert.equal(a.rightFullExtent, 117);
  assert.equal(b.rightFullExtent, 122);
  assert.equal(a.verticalFullExtent, 15);
  assert.equal(a.verticalRightInnerExtent, b.verticalRightInnerExtent);
  assert.equal(a.rightShelfInnerExtent, b.rightInnerExtent);
  assert.equal(a.sourceY, 80);
});

test('right-leg compaction yields to a stroke in the candidate lane', async () => {
  const {compactRightTurnGaps} = await helper;
  const [inner, outer] = family();
  const obstacle = {path: 'M117 40L117 60', width: 2};
  compactRightTurnGaps({links: [inner, outer, obstacle], nodes: []}, 1, draw);
  assert.equal(inner.circularPathData.rightFullExtent, 110);
  assert.equal(outer.circularPathData.rightFullExtent, 122);
});
