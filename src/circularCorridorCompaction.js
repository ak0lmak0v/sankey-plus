import { circularMoveGuard, circularChangedSection } from './rightTurnCompaction.js';

const half = link => Math.max(1, link.width || 0) / 2;
const epsilon = 0.2;

function regular(link) {
  const c = link.circularPathData;
  return link.circular && !link.isVirtual && link.source !== link.target && c &&
    !c.sourcePortWrap && !c.mirroredSourceRadius && !c.localPortBridgeRadius &&
    !c.localForwardRadius && !c.localDownwardRadius && !c.leftShelfArcRadius;
}

function intervalsOverlap(a, b) {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
}

const side = link => link.circularLinkType === 'bottom' ? 1 : -1;

function span(link, axis) {
  const c = link.circularPathData;
  if (axis === 'shelf') return [c.leftShelfInnerExtent ?? c.leftInnerExtent, c.rightShelfInnerExtent ?? c.rightInnerExtent];
  const port = axis === 'left' ? c.targetY : c.sourceY;
  const turn = c[axis + 'SmallArcRadius'];
  const end = c[axis === 'left' ? 'verticalLeftInnerExtent' : 'verticalRightInnerExtent'];
  const start = port + side(link) * turn;
  return [Math.min(start, end), Math.max(start, end)];
}

function change(link, amount, axis, draw, resize = false) {
  const c = {...link.circularPathData}, direction = side(link);
  if (axis === 'shelf') {
    c.verticalFullExtent += amount;
    c.verticalLeftInnerExtent += amount;
    c.verticalRightInnerExtent += amount;
    if (Number.isFinite(c.verticalBuffer)) c.verticalBuffer += direction * amount;
  } else if (axis === 'left') {
    c.leftFullExtent += amount;
    if (resize) {
      c.leftLargeArcRadius -= amount;
      c.leftSmallArcRadius -= amount;
      c.verticalLeftInnerExtent += direction * amount;
      if (Math.min(c.leftLargeArcRadius, c.leftSmallArcRadius) < half(link) + 4) return null;
    } else {
      c.leftInnerExtent += amount;
      if (Number.isFinite(c.leftShelfInnerExtent)) c.leftShelfInnerExtent += amount;
    }
    if (c.leftInnerExtent > c.targetX ||
        (c.leftShelfInnerExtent ?? c.leftInnerExtent) > (c.rightShelfInnerExtent ?? c.rightInnerExtent)) return null;
  } else {
    for (const key of ['rightFullExtent', 'rightInnerExtent', 'rightDepartureInnerExtent', 'rightShelfInnerExtent'])
      if (Number.isFinite(c[key])) c[key] += amount;
    if (resize && amount > 0) {
      const old = link.circularPathData;
      c.rightDepartureInnerExtent = old.rightDepartureInnerExtent ?? old.rightInnerExtent;
      c.rightSourceLargeArcRadius = (old.rightSourceLargeArcRadius ?? old.rightLargeArcRadius) + amount;
      c.rightSmallArcRadius += amount;
    }
    if ((c.rightDepartureInnerExtent ?? c.rightInnerExtent) < c.sourceX ||
        (c.rightShelfInnerExtent ?? c.rightInnerExtent) < (c.leftShelfInnerExtent ?? c.leftInnerExtent)) return null;
  }
  if (direction * (c.verticalRightInnerExtent - c.sourceY) + 1e-6 < c.rightSmallArcRadius ||
      direction * (c.verticalLeftInnerExtent - c.targetY) + 1e-6 < c.leftSmallArcRadius) return null;
  const path = draw({...link, circularPathData: c});
  const before = circularChangedSection(link.path, axis), after = circularChangedSection(path, axis);
  return before && after ? {link, c, path, before, after} : null;
}

function compress(links, gap, axis, canMove, draw) {
  const shelf = axis === 'shelf';
  const coordinate = link => link.circularPathData[shelf ? 'verticalFullExtent' : axis + 'FullExtent'];
  // Moving an already packed run as one block keeps its internal gaps.
  for (let pass = 0; pass < 12; pass++) {
    const sorted = links.slice().sort((a, b) => coordinate(a) - coordinate(b));
    const groups = new Map(sorted.map(link => [link, new Set([link])]));
    const adjacent = [];
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      const [a0, a1] = span(a, axis), [b0, b1] = span(b, axis);
      const common = [Math.max(a0, b0), Math.min(a1, b1)];
      if (common[1] - common[0] < (shelf ? 12 : 20)) continue;
      if (sorted.slice(i + 1, j).some(l => intervalsOverlap(span(l, axis), common) >= 0.8 * (common[1] - common[0]))) continue;
      const space = coordinate(b) - coordinate(a) - half(a) - half(b);
      adjacent.push({a,b,space});
      if (space > gap + 1) continue;
      const merged = new Set([...groups.get(a), ...groups.get(b)]);
      for (const l of merged) groups.set(l, merged);
    }
    let changed = false;
    for (const {a,b,space} of adjacent.sort((a,b) => b.space - a.space)) {
      const distance = coordinate(b) - coordinate(a) - half(a) - half(b) - gap;
      if (distance < 0.9 || groups.get(a) === groups.get(b)) continue;
      const inward = [groups.get(a), distance], outward = [groups.get(b), -distance];
      const variants = shelf ? [outward, inward] : [inward, outward];
      const trials = shelf ? variants : [1, 0.875, 0.75, 0.5, 0.25]
        .flatMap(factor => variants.map(([group, shift]) => [group, shift * factor]));
      for (const [group, sign] of trials) {
        if (Math.abs(sign) < 0.75) continue;
        const blocked = adjacent.some(({a: left, b: right}) => group.has(left) !== group.has(right) &&
          coordinate(right) - coordinate(left) + (group.has(right) ? sign : -sign) < half(left) + half(right) + gap - epsilon);
        if (blocked) continue;
        const options = axis === 'left' || (axis === 'right' && sign > 0) ? [false, true] : [false];
        for (const resizeTurn of options) {
          const changes = [...group].map(link => change(link, sign, axis, draw, resizeTurn));
          if (changes.some(x => !x) || !canMove(changes)) continue;
          for (const {link,c,path} of changes) {
            link.circularPathData = c;
            link.path = path;
          }
          changed = true;
          break;
        }
        if (changed) break;
      }
      if (changed) break;
    }
    if (!changed) break;
  }
}

export function compactCircularCorridorGaps(graph, gap, draw) {
  const canMove = circularMoveGuard(graph);
  const links = graph.links.filter(regular);
  compress(links.filter(l => l.circularLinkType === 'top'), gap, 'shelf', canMove, draw);
  const columns = new Map();
  for (const link of links) {
    if (link.circularLinkType !== 'bottom') continue;
    const column = link.source.column;
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(link);
  }
  for (const group of columns.values()) compress(group, gap, 'right', canMove, draw);
  const arrivals = new Map();
  for (const link of links) {
    const column = link.target.column;
    if (!arrivals.has(column)) arrivals.set(column, []);
    arrivals.get(column).push(link);
  }
  for (const group of arrivals.values()) compress(group, gap, 'left', canMove, draw);
  compress(links.filter(l => l.circularLinkType === 'bottom'), gap, 'shelf', canMove, draw);
}
