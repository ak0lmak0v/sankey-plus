// Approximate a drawn path with short segments, and use their bounds to
// reject distant pieces before measuring clearance. The layout emits
// absolute SVG commands with axis-aligned turns.
const samples = 16;
const tolerance = 0.2;

function segment(x0, y0, x1, y1, straight = false) {
  return {
    x0, y0, x1, y1,
    left: Math.min(x0, x1), right: Math.max(x0, x1),
    top: Math.min(y0, y1), bottom: Math.max(y0, y1),
    vertical: straight && x0 === x1, horizontal: straight && y0 === y1
  };
}

const svgCommands = path => path.match(/[A-DF-Za-df-z][^A-DF-Za-df-z]*/g) || [];

function segments(path, detail = samples) {
  if (!path) return [];
  const commands = svgCommands(path);
  const boxes = [];
  let x = 0, y = 0;
  for (const command of commands) {
    const values = (command.slice(1).match(/[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/gi) || []).map(Number);
    if (values.length < 2 || !values.every(Number.isFinite)) return null;
    const [endX, endY] = values.slice(-2);
    if (command[0] === 'L') boxes.push(segment(x, y, endX, endY, true));
    else if (command[0] === 'C') {
      const [x1, y1, x2, y2] = values;
      let px = x, py = y;
      for (let i = 1; i <= detail; i++) {
        const t = i / detail, u = 1 - t;
        const nx = u ** 3 * x + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * endX;
        const ny = u ** 3 * y + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * endY;
        boxes.push(segment(px, py, nx, ny));
        px = nx;
        py = ny;
      }
    } else if (command[0] === 'A') {
      const [rx, ry, rotation, large, sweep] = values;
      if (!(rx > 0 && ry > 0) || rotation || large || Math.abs(Math.abs(x - endX) - rx) > 1e-5 ||
          Math.abs(Math.abs(y - endY) - ry) > 1e-5) return null;
      // The layout uses quarter ellipses with an axis-aligned radius.
      const forward = (x - endX) * (y - endY) > 0 ? !sweep : sweep;
      const cx = forward ? endX : x, cy = forward ? y : endY;
      const start = Math.atan2((y - cy) / ry, (x - cx) / rx);
      let px = x, py = y;
      for (let i = 1; i <= detail; i++) {
        const theta = start + (sweep ? 1 : -1) * Math.PI * i / (2 * detail);
        const nx = cx + rx * Math.cos(theta), ny = cy + ry * Math.sin(theta);
        boxes.push(segment(px, py, nx, ny));
        px = nx;
        py = ny;
      }
    } else if (command[0] !== 'M') return null;
    x = endX;
    y = endY;
  }
  return boxes;
}

function rightTurn(path) {
  const commands = svgCommands(path);
  if (commands.slice(0, 5).map(command => command[0]).join('') !== 'MLALA') return null;
  return segments('M' + commands[1].slice(1) + commands.slice(2, 5).join(''));
}

function clearance(a, b) {
  return Math.hypot(Math.max(0, a.left - b.right, b.left - a.right),
    Math.max(0, a.top - b.bottom, b.top - a.bottom));
}

function pointDistance(x, y, segment) {
  const dx = segment.x1 - segment.x0, dy = segment.y1 - segment.y0;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((x - segment.x0) * dx + (y - segment.y0) * dy) / length)) : 0;
  return Math.hypot(x - (segment.x0 + t * dx), y - (segment.y0 + t * dy));
}

function turnSide(segment, x, y) {
  return (segment.x1 - segment.x0) * (y - segment.y0) - (segment.y1 - segment.y0) * (x - segment.x0);
}

function outline(pieces) {
  if (!pieces) return null;
  return {
    pieces,
    bounds: {
      left: Math.min(...pieces.map(p => p.left)), right: Math.max(...pieces.map(p => p.right)),
      top: Math.min(...pieces.map(p => p.top)), bottom: Math.max(...pieces.map(p => p.bottom))
    }
  };
}

function closest(a, b, limit, rectangles = false) {
  let nearest = limit;
  for (const x of a) for (const y of b) {
    const lowerBound = clearance(x, y);
    if (lowerBound >= nearest) continue;
    if (rectangles) {
      nearest = lowerBound;
    } else {
      if (lowerBound === 0 &&
          turnSide(x, y.x0, y.y0) * turnSide(x, y.x1, y.y1) <= 0 &&
          turnSide(y, x.x0, x.y0) * turnSide(y, x.x1, x.y1) <= 0) return 0;
      nearest = Math.min(nearest, pointDistance(x.x0, x.y0, y), pointDistance(x.x1, x.y1, y),
        pointDistance(y.x0, y.y0, x), pointDistance(y.x1, y.y1, x));
    }
    if (nearest === 0) return 0;
  }
  return nearest;
}

function parallelOverlap(a, b, margin) {
  let overlap = 0;
  for (const x of a) for (const y of b) {
    if (x.vertical && y.vertical && Math.abs(x.left - y.left) < margin - tolerance)
      overlap = Math.max(overlap, Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top));
    if (x.horizontal && y.horizontal && Math.abs(x.top - y.top) < margin - tolerance)
      overlap = Math.max(overlap, Math.min(x.right, y.right) - Math.max(x.left, y.left));
  }
  return overlap;
}

const halfWidth = link => Math.max(1, link.width || 0) / 2;
const canMove = link => {
  const c = link.circularPathData;
  return c && !c.sourcePortWrap && !c.mirroredSourceRadius && !c.localPortBridgeRadius &&
    !c.localForwardRadius && !c.localDownwardRadius;
};
function leg(link) {
  const c = link.circularPathData;
  const start = c.sourceY + (link.circularLinkType === 'bottom' ? 1 : -1) * c.rightSmallArcRadius;
  return [Math.min(start, c.verticalRightInnerExtent), Math.max(start, c.verticalRightInnerExtent)];
}

// Move only the inner right turn toward its neighbor. The shelf height,
// source port and arrival stay fixed, and the family's total width cannot grow.
export function compactRightTurnGaps(graph, gap, drawCircular) {
  const links = graph.links.filter(link => !link.isVirtual && link.path);
  const groups = new Map();
  for (const link of links) {
    if (!link.circular || link.source === link.target || !canMove(link)) continue;
    if (!groups.has(link.target)) groups.set(link.target, new Map());
    const byCorridor = groups.get(link.target);
    const key = link.source.column + ':' + link.circularLinkType;
    if (!byCorridor.has(key)) byCorridor.set(key, []);
    byCorridor.get(key).push(link);
  }
  let outlines;
  const right = link => link.circularPathData.rightFullExtent;
  for (const corridors of groups.values()) for (const family of corridors.values()) {
    family.sort((a, b) => right(a) - right(b));
    for (let i = family.length - 2; i >= 0; i--) {
      const link = family[i], outer = family[i + 1];
      const old = link.circularPathData;
      const distance = right(outer) - right(link) - halfWidth(outer) - halfWidth(link) - gap;
      const [a, b] = leg(link), [c, d] = leg(outer);
      if (distance <= 1 || Math.min(b, d) - Math.max(a, c) < Math.max(8, halfWidth(link) + halfWidth(outer)) ||
          Math.abs(old.sourceX - outer.circularPathData.sourceX) > 1e-6) continue;
      if (!outlines) outlines = new Map(links.map(l => [l, outline(segments(l.path))]));
      if ([...outlines.values()].some(boxes => !boxes)) return;
      const next = {...old};
      for (const key of ['rightFullExtent', 'rightInnerExtent', 'rightDepartureInnerExtent', 'rightShelfInnerExtent'])
        if (Number.isFinite(next[key])) next[key] += distance;
      const outerData = outer.circularPathData;
      const start = old.rightDepartureInnerExtent ?? old.rightInnerExtent;
      const shelf = old.rightShelfInnerExtent ?? old.rightInnerExtent;
      const outerShelf = outerData.rightShelfInnerExtent ?? outerData.rightInnerExtent;
      // Keep already aligned shelf bends concentric while reclaiming a lane.
      if (Math.abs(shelf - outerShelf) < 1e-6) {
        const sign = link.circularLinkType === 'bottom' ? 1 : -1;
        const tangent = old.verticalRightInnerExtent - sign * distance;
        if (sign * (tangent - old.sourceY) < old.rightSmallArcRadius) continue;
        next.rightInnerExtent = next.rightShelfInnerExtent = shelf;
        next.rightDepartureInnerExtent = start + distance;
        next.rightSourceLargeArcRadius = old.rightSourceLargeArcRadius ?? old.rightLargeArcRadius;
        next.rightLargeArcRadius = old.rightLargeArcRadius + distance;
        next.verticalRightInnerExtent = tangent;
      }
      const candidate = drawCircular({...link, circularPathData: next});
      const before = rightTurn(link.path), after = rightTurn(candidate);
      if (!before || !after) continue;
      after.push(segment(start, old.sourceY, start + distance, old.sourceY, true));
      if (Math.abs(shelf - outerShelf) >= 1e-6)
        after.push(segment(shelf, old.verticalFullExtent, shelf + distance, old.verticalFullExtent, true));
      const changed = outline(after);
      const collides = [...outlines].some(([other, obstacle]) => {
        if (other === link) return false;
        const margin = halfWidth(link) + halfWidth(other);
        if (clearance(changed.bounds, obstacle.bounds) >= margin) return false;
        return closest(after, obstacle.pieces, margin) + tolerance < closest(before, obstacle.pieces, margin) ||
          parallelOverlap(after, obstacle.pieces, margin) > parallelOverlap(before, obstacle.pieces, margin) + tolerance;
      });
      if (collides || graph.nodes.some(node => {
        if (node.virtual || node === link.source || node === link.target) return false;
        const box = [segment(node.x0, node.y0, node.x1, node.y1)];
        return closest(after, box, halfWidth(link), true) + tolerance < closest(before, box, halfWidth(link), true);
      })) continue;
      link.circularPathData = next;
      link.path = candidate;
      outlines.set(link, outline(segments(candidate)));
    }
  }
}

function crossingCount(first, second) {
  let count = 0;
  for (const a of first) for (const b of second) {
    if (clearance(a, b) > 0) continue;
    if (turnSide(a, b.x0, b.y0) * turnSide(a, b.x1, b.y1) < -1e-8 &&
        turnSide(b, a.x0, a.y0) * turnSide(b, a.x1, a.y1) < -1e-8) count++;
  }
  return count;
}

export function circularMoveGuard(graph) {
  const shapes = new Map();
  const detail = 32, accuracy = 0.035;
  function shape(link) {
    if (shapes.get(link)?.path !== link.path)
      shapes.set(link, {path: link.path, geometry: outline(segments(link.path, detail))});
    return shapes.get(link).geometry;
  }
  return function canMoveGroup(changes) {
    const replacements = new Map(changes.map(change => [change.link, outline(segments(change.path, detail))]));
    for (const {link, before, after} of changes) {
      const previous = segments(before, detail), candidate = segments(after, detail);
      if (!previous || !candidate) return false;
      const bounds = outline(candidate).bounds;
      for (const other of graph.links) {
        if (other.isVirtual || other === link || !other.path) continue;
        const original = shape(other);
        const obstacle = replacements.get(other) ?? original;
        if (!original || !obstacle) return false;
        const margin = halfWidth(link) + halfWidth(other);
        if (clearance(bounds, obstacle.bounds) >= margin) continue;
        const parts = obstacle.pieces, oldParts = original.pieces;
        if (closest(candidate, parts, margin) + accuracy < closest(previous, oldParts, margin) ||
            parallelOverlap(candidate, parts, margin) > parallelOverlap(previous, oldParts, margin) + accuracy ||
            crossingCount(candidate, parts) > crossingCount(previous, oldParts)) return false;
      }
      for (const node of graph.nodes) {
        if (node.virtual || node === link.source || node === link.target) continue;
        const area = [segment(node.x0, node.y0, node.x1, node.y1)];
        if (closest(candidate, area, halfWidth(link), true) + accuracy <
            closest(previous, area, halfWidth(link), true)) return false;
      }
    }
    return true;
  };
}

export function circularChangedSection(path, axis) {
  const commands = svgCommands(path);
  if (commands.map(c => c[0]).join('') !== 'MLALALALAL') return null;
  if (axis === 'right') return commands.slice(0, 6).join('');
  const start = axis === 'shelf' ? 2 : 4;
  const point = commands[start].trim().split(/[ ,]+/).slice(-2).join(' ');
  return 'M' + point + ' ' + commands.slice(start + 1, axis === 'shelf' ? 8 : 10).join('');
}
