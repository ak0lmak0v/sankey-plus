const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
async function moduleFrom(name) {
  return import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8')).toString('base64'));
}
const runs = (links, key) => {
  const ordered = links.slice().sort((a, b) => a.circularPathData[key] - b.circularPathData[key]);
  return ordered.filter((l, i) => i === 0 || l.target !== ordered[i - 1].target).length;
};

// Independent synthetic lane frames; targets deliberately share a column.
// A second source column also returns to one of them.
test('bottom return families stay contiguous by target node in a shared column', async () => {
  const {preserveReturnBundleGroups} = await moduleFrom('returnBundleGroups.js');
  const source = {column: 4}, foreign = {column: 3};
  const first = {column: 1}, second = {column: 1};
  const make = (origin, target, slot) => ({source: origin, target, circular: true,
    circularLinkType: 'bottom', width: 4, circularPathData: {
      sourceX: 300, sourceY: 20, targetX: 100, targetY: 30,
      rightNodeBuffer: 5, leftInnerExtent: 95, rightInnerExtent: 305,
      rightFullExtent: 315 + slot * 7, leftFullExtent: 85,
      rightLargeArcRadius: 10 + slot * 7, rightSmallArcRadius: 7,
      leftLargeArcRadius: 10, leftSmallArcRadius: 7,
      verticalFullExtent: 100 + slot * 7,
      verticalRightInnerExtent: 90, verticalLeftInnerExtent: 90
    }});
  const links = [make(source, first, 0), make(source, second, 1),
    make(source, first, 2), make(source, second, 3)];
  const graph = {links: [...links, make(foreign, first, 0)]};
  const ports = links.map(l => [l.circularPathData.sourceX, l.circularPathData.sourceY,
    l.circularPathData.targetX, l.circularPathData.targetY]);
  preserveReturnBundleGroups(graph, 1);
  for (const key of ['rightFullExtent', 'verticalFullExtent']) {
    assert.equal(runs(links, key), 2, 'Every target must occupy one contiguous family on ' + key);
    const ordered = links.slice().sort((a,b) => a.circularPathData[key]-b.circularPathData[key]);
    for (let i=1;i<ordered.length;i++) assert.ok(
      ordered[i].circularPathData[key]-ordered[i-1].circularPathData[key] >= 5-1e-6,
      'Adjacent painted strokes must retain their gap');
  }
  assert.deepEqual(links.map(l => [l.circularPathData.sourceX,l.circularPathData.sourceY,
    l.circularPathData.targetX,l.circularPathData.targetY]), ports);
  const once = JSON.stringify(graph);
  preserveReturnBundleGroups(graph, 1);
  assert.equal(JSON.stringify(graph), once, 'Finalization must be stable');
});

test('opposite-band legs use separate lanes without moving ports', async () => {
  const {separateCircularLegs} = await moduleFrom('circularLegClearance.js');
  const source = {column: 3}, target = {column: 1};
  const make = (side, y, shelf) => ({source, target, circular: true,
    circularLinkType: side, width: 8, circularPathData: {
      sourceX: 300, sourceY: y, targetX: 100, targetY: y,
      rightFullExtent: 325, rightInnerExtent: 305,
      leftFullExtent: 75, leftInnerExtent: 95,
      rightLargeArcRadius: 20, rightSmallArcRadius: 10,
      leftLargeArcRadius: 20, leftSmallArcRadius: 10,
      verticalFullExtent: shelf,
      verticalRightInnerExtent: shelf + (side === 'top' ? 20 : -20),
      verticalLeftInnerExtent: shelf + (side === 'top' ? 20 : -20)
    }});
  const links = [make('top', 120, 0), make('bottom', 40, 180)];
  const original = links.map(l => [l.circularPathData.sourceX,l.circularPathData.sourceY,
    l.circularPathData.targetX,l.circularPathData.targetY]);
  separateCircularLegs({links}, 1);
  for (const key of ['rightFullExtent','leftFullExtent']) assert.ok(
    Math.abs(links[1].circularPathData[key]-links[0].circularPathData[key]) >= 9-1e-6,
    'Opposite-band painted legs need stroke-width clearance');
  assert.deepEqual(links.map(l => [l.circularPathData.sourceX,l.circularPathData.sourceY,
    l.circularPathData.targetX,l.circularPathData.targetY]),original);
});

test('a return enclosing a local loop also encloses its shelf when source ports permit nesting', async () => {
  const {separateCircularLegs} = await moduleFrom('circularLegClearance.js');
  const column = {column: 2}, earlier = {column: 1};
  const make = (target, sourceY, left, right, shelf) => ({source: column, target,
    circular: true, circularLinkType: 'top', width: 4,
    circularPathData: {sourceX: 200, sourceY, targetX: target === column ? 185 : 100,
      targetY: 150, leftFullExtent: left, rightFullExtent: right,
      leftInnerExtent: left + 20, rightInnerExtent: right - 20,
      leftLargeArcRadius: 20, leftSmallArcRadius: 20,
      rightLargeArcRadius: 20, rightSmallArcRadius: 20,
      verticalFullExtent: shelf, verticalLeftInnerExtent: shelf + 20,
      verticalRightInnerExtent: shelf + 20}});
  const local = make(column, 40, 160, 240, 0);
  const enclosing = make(earlier, 100, 60, 260, 5);
  separateCircularLegs({links: [local, enclosing]}, 1);
  assert.ok(enclosing.circularPathData.verticalFullExtent <= local.circularPathData.verticalFullExtent - 5,
    'An outer shelf must pass outside the local turn rather than along its arc');
});

test('a crossing lower family wraps around an intermediate column as a group', async () => {
  const {separateCircularLegs} = await moduleFrom('circularLegClearance.js');
  const target = {column: 0}, start = {column: 2}, localA = {column: 1}, localB = {column: 1};
  function route(source, target, {left, right, shelf, sourceY, targetY, radius}) {
    return {source, target, circular: true, circularLinkType: 'bottom', width: 4,
      circularPathData: {sourceY, targetY, leftFullExtent: left, rightFullExtent: right,
        leftInnerExtent: left + radius, rightInnerExtent: right - radius,
        leftSmallArcRadius: radius, leftLargeArcRadius: radius,
        rightSmallArcRadius: radius, rightLargeArcRadius: radius,
        verticalFullExtent: shelf, verticalLeftInnerExtent: shelf - radius,
        verticalRightInnerExtent: shelf - radius}};
  }
  const inner = route(localA, localB, {left: 110, right: 200, shelf: 210,
    sourceY: 30, targetY: 40, radius: 10});
  const first = route(start, target, {left: 30, right: 300, shelf: 170,
    sourceY: 40, targetY: 50, radius: 10});
  const second = route(start, target, {left: 25, right: 305, shelf: 180,
    sourceY: 35, targetY: 45, radius: 15});
  separateCircularLegs({links: [inner, first, second]}, 1);
  assert.equal(first.circularPathData.verticalFullExtent, 215);
  assert.equal(second.circularPathData.verticalFullExtent, 220);
  assert.equal(second.circularPathData.verticalRightInnerExtent,
    first.circularPathData.verticalRightInnerExtent);
});

test('a lone lower departure yields to a compact upper family', async () => {
  const {separateCircularLegs} = await moduleFrom('circularLegClearance.js');
  const source = {column: 3}, target = {column: 1}, otherTarget = {column: 2};
  function route(target, band, axis, sourceY, shelf, left) {
    const sign = band === 'top' ? -1 : 1;
    return {source, target, circular: true, circularLinkType: band, width: 6,
      circularPathData: {sourceY, targetY: sourceY, rightFullExtent: axis, leftFullExtent: left,
        leftInnerExtent: left + 10, rightInnerExtent: axis - 10,
        leftSmallArcRadius: 10, leftLargeArcRadius: 10, rightSmallArcRadius: 10,
        rightLargeArcRadius: 10, verticalFullExtent: shelf,
        verticalLeftInnerExtent: shelf - sign * 10, verticalRightInnerExtent: shelf - sign * 10}};
  }
  const first = route(target, 'top', 330, 150, 0, 70);
  const second = route(target, 'top', 337, 170, -7, 63);
  const lower = route(otherTarget, 'bottom', 334, 100, 240, 150);
  separateCircularLegs({links: [first, second, lower]}, 1);
  assert.equal(second.circularPathData.rightFullExtent - first.circularPathData.rightFullExtent, 7);
  assert.ok(lower.circularPathData.rightFullExtent >= second.circularPathData.rightFullExtent + 7);
});
