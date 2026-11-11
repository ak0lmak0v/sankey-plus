const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const read = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
const moduleSource = read('circularCorridorCompaction.js')
  .replace("'./rightTurnCompaction.js'", JSON.stringify(dataUrl(read('rightTurnCompaction.js'))));
const helper = import(dataUrl(moduleSource));

function draw(link) {
  const c = link.circularPathData;
  const bottom = link.circularLinkType === 'bottom';
  const sign = bottom ? 1 : -1, sweep = bottom ? 1 : 0;
  const departure = c.rightDepartureInnerExtent ?? c.rightInnerExtent;
  const sourceRadius = c.rightSourceLargeArcRadius ?? c.rightLargeArcRadius;
  return `M${c.sourceX} ${c.sourceY}L${departure} ${c.sourceY}` +
    `A${sourceRadius} ${c.rightSmallArcRadius} 0 0 ${sweep} ${c.rightFullExtent} ${c.sourceY + sign * c.rightSmallArcRadius}` +
    `L${c.rightFullExtent} ${c.verticalRightInnerExtent}` +
    `A${c.rightLargeArcRadius} ${c.rightLargeArcRadius} 0 0 ${sweep} ${c.rightInnerExtent} ${c.verticalFullExtent}` +
    `L${c.leftInnerExtent} ${c.verticalFullExtent}` +
    `A${c.leftLargeArcRadius} ${c.leftLargeArcRadius} 0 0 ${sweep} ${c.leftFullExtent} ${c.verticalLeftInnerExtent}` +
    `L${c.leftFullExtent} ${c.targetY + sign * c.leftSmallArcRadius}` +
    `A${c.leftLargeArcRadius} ${c.leftSmallArcRadius} 0 0 ${sweep} ${c.leftInnerExtent} ${c.targetY}` +
    `L${c.targetX} ${c.targetY}`;
}

function returnLink({side = 'top', sx, sy, tx, ty, right, left, shelf, radius = 10}) {
  const sign = side === 'bottom' ? 1 : -1;
  const link = {source: {column: 2}, target: {column: 1}, width: 4,
    circular: true, circularLinkType: side,
    circularPathData: {sourceX: sx, sourceY: sy, targetX: tx, targetY: ty,
      rightFullExtent: right, rightInnerExtent: right - radius, leftFullExtent: left,
      leftInnerExtent: left + radius, rightSmallArcRadius: radius, rightLargeArcRadius: radius,
      leftSmallArcRadius: radius, leftLargeArcRadius: radius, verticalFullExtent: shelf,
      verticalRightInnerExtent: shelf - sign * radius, verticalLeftInnerExtent: shelf - sign * radius}};
  link.path = draw(link);
  return link;
}

test('adjacent top shelves with different targets close unused space without moving the ports', async () => {
  const {compactCircularCorridorGaps} = await helper;
  const outer = returnLink({sx: 200, sy: 100, tx: 100, ty: 130, right: 220, left: 80, shelf: 20});
  const inner = returnLink({sx: 160, sy: 75, tx: 120, ty: 90, right: 180, left: 105, shelf: 38});
  compactCircularCorridorGaps({links: [outer, inner], nodes: []}, 1, draw);
  assert.equal(inner.circularPathData.verticalFullExtent - outer.circularPathData.verticalFullExtent, 5);
  assert.equal(inner.circularPathData.sourceY, 75);
  assert.equal(inner.circularPathData.targetY, 90);
  assert.equal(inner.circularPathData.verticalRightInnerExtent, inner.circularPathData.verticalFullExtent + 10);
});

test('bottom right legs close a gap between targets while retaining an already packed pair', async () => {
  const {compactCircularCorridorGaps} = await helper;
  const inner = returnLink({side: 'bottom', sx: 180, sy: 110, tx: 115, ty: 115, right: 205, left: 100, shelf: 235});
  const middle = returnLink({side: 'bottom', sx: 180, sy: 105, tx: 115, ty: 110, right: 210, left: 95, shelf: 240});
  const outer = returnLink({side: 'bottom', sx: 180, sy: 80, tx: 115, ty: 90, right: 240, left: 70, shelf: 260});
  compactCircularCorridorGaps({links: [inner, middle, outer], nodes: []}, 1, draw);
  assert.equal(middle.circularPathData.rightFullExtent - inner.circularPathData.rightFullExtent, 5);
  assert.equal(outer.circularPathData.rightFullExtent - middle.circularPathData.rightFullExtent, 5);
  assert.equal(inner.circularPathData.verticalFullExtent, 235);
});

test('left legs can reclaim empty space where upper and lower turns share a column', async () => {
  const {compactCircularCorridorGaps} = await helper;
  const upper = returnLink({sx: 220, sy: 100, tx: 140, ty: 240, right: 250, left: 80, shelf: 30});
  const lower = returnLink({side: 'bottom', sx: 160, sy: 95, tx: 140, ty: 70,
    right: 200, left: 105, shelf: 200});
  compactCircularCorridorGaps({links: [upper, lower], nodes: []}, 1, draw);
  assert.equal(lower.circularPathData.leftFullExtent - upper.circularPathData.leftFullExtent, 5);
  assert.equal(upper.circularPathData.verticalFullExtent, 30);
  assert.equal(lower.circularPathData.verticalFullExtent, 200);
  assert.equal(upper.circularPathData.targetY, 240);
  assert.equal(lower.circularPathData.targetY, 70);
});

test('neighboring lower shelves reclaim empty space between separate return groups', async () => {
  const {compactCircularCorridorGaps} = await helper;
  const inner = returnLink({side: 'bottom', sx: 160, sy: 95, tx: 140, ty: 90,
    right: 190, left: 105, shelf: 150});
  const outer = returnLink({side: 'bottom', sx: 160, sy: 75, tx: 140, ty: 70,
    right: 210, left: 80, shelf: 175});
  compactCircularCorridorGaps({links: [inner, outer], nodes: []}, 1, draw);
  assert.equal(outer.circularPathData.verticalFullExtent - inner.circularPathData.verticalFullExtent, 5);
  assert.equal(inner.circularPathData.targetY, 90);
  assert.equal(outer.circularPathData.targetY, 70);
});
