// Final compaction can put opposite-band returns in the same vertical lane.
// Move source turns as a whole and grow target turns concentrically. Keep
// port positions fixed and reserve room for both round target corners.
export function separateCircularLegs(graph, gap) {
  const links = graph.links.filter(l => l.circular && !l.isVirtual && l.circularPathData);
  const half = link => Math.max(link.width || 0, 1) / 2;
  const simple = link => {
    const c = link.circularPathData;
    return !c.sourcePortWrap && !c.mirroredSourceRadius && !c.localPortBridgeRadius &&
      !c.localForwardRadius && !c.localDownwardRadius && !c.leftShelfArcRadius;
  };
  const originalShelf = new Map(links.map(l => [l, l.circularPathData.verticalFullExtent]));
  function moveShelf(link, next) {
    const c = link.circularPathData, delta = next - c.verticalFullExtent;
    c.verticalFullExtent = next;
    c.verticalLeftInnerExtent += delta;
    c.verticalRightInnerExtent += delta;
    if (Number.isFinite(c.verticalBuffer))
      c.verticalBuffer += (link.circularLinkType === 'bottom' ? 1 : -1) * delta;
  }
  function packShelves() {
    // Minimum painted width can exceed a tiny link's layout width. Reserve
    // shelf clearance using the stroke that the renderer actually paints.
    for (const side of ['top', 'bottom']) {
      const sign = side === 'bottom' ? 1 : -1;
      const band = links.filter(l => simple(l) && l.circularLinkType === side)
        .sort((a, b) => sign * (originalShelf.get(a) - originalShelf.get(b)));
      for (let i = 1; i < band.length; i++) {
        const link = band[i], c = link.circularPathData;
        let next = sign * c.verticalFullExtent;
        for (let j = 0; j < i; j++) {
          const prev = band[j], pc = prev.circularPathData;
          const left = Math.max(c.leftFullExtent, pc.leftFullExtent);
          const right = Math.min(c.rightFullExtent, pc.rightFullExtent);
          if (right <= left) continue;
          next = Math.max(next, sign * pc.verticalFullExtent + half(link) + half(prev) + gap);
        }
        moveShelf(link, sign * next);
      }
    }
  }
  // Matching shelf and arrival-lane gaps describe concentric top turns.
  // Tighten both together to retain the same center for the shelf corners.
  const localTop = links.filter(link => simple(link) && link.circularLinkType === 'top' &&
    link.source !== link.target && link.source.column === link.target.column)
    .sort((a, b) => b.circularPathData.leftFullExtent - a.circularPathData.leftFullExtent);
  for (const link of localTop) {
    const c = link.circularPathData;
    const inner = localTop.findLast(other => other.target === link.target &&
      other.circularPathData.leftFullExtent > c.leftFullExtent &&
      other.circularPathData.verticalFullExtent > c.verticalFullExtent);
    if (!inner) continue;
    const ic = inner.circularPathData, clearance = half(link) + half(inner) + gap;
    const left = ic.leftFullExtent - c.leftFullExtent;
    const shelf = ic.verticalFullExtent - c.verticalFullExtent;
    if (Math.abs(left - shelf) > 1e-6 || Math.abs(c.leftSmallArcRadius - c.leftLargeArcRadius) > 1e-6 ||
        Math.abs(c.leftInnerExtent - ic.leftInnerExtent) > 1e-6) continue;
    let shift = Math.min(left - clearance,
      c.sourceY - c.rightSmallArcRadius - c.rightLargeArcRadius - c.verticalFullExtent - gap);
    for (const other of links) {
      if (other === link || other.circularLinkType !== 'top') continue;
      const oc = other.circularPathData, margin = half(link) + half(other) + gap;
      if (other.target.column === link.target.column && oc.leftFullExtent > c.leftFullExtent &&
          Math.min(c.targetY, Math.max(oc.targetY, oc.verticalFullExtent)) + margin >=
            Math.max(c.verticalFullExtent, Math.min(oc.targetY, oc.verticalFullExtent))) {
        shift = Math.min(shift, oc.leftFullExtent - c.leftFullExtent - margin);
      }
      if (oc.verticalFullExtent > c.verticalFullExtent &&
          oc.rightFullExtent > c.leftFullExtent && oc.leftFullExtent < c.rightFullExtent) {
        shift = Math.min(shift, oc.verticalFullExtent - c.verticalFullExtent - margin);
      }
    }
    if (shift <= 1e-6) continue;
    c.leftFullExtent += shift;
    c.leftLargeArcRadius -= shift;
    c.leftSmallArcRadius -= shift;
    moveShelf(link, c.verticalFullExtent + shift);
    c.verticalLeftInnerExtent = c.verticalFullExtent + c.leftLargeArcRadius;
  }

  packShelves();
  for (const end of ['left', 'right']) {
    const columns = new Map();
    for (const link of links.filter(simple)) {
      const column = end === 'left' ? link.target.column : link.source.column;
      if (!columns.has(column)) columns.set(column, []);
      columns.get(column).push(link);
    }
    for (const group of columns.values()) {
      const sign = end === 'left' ? -1 : 1;
      const axis = link => sign * link.circularPathData[end + 'FullExtent'];
      const range = (link, straight) => {
        const c = link.circularPathData, y = end === 'left' ? c.targetY : c.sourceY;
        if (straight && end === 'right') {
          const start = y + (link.circularLinkType === 'bottom' ? 1 : -1) * c.rightSmallArcRadius;
          return [Math.min(start, c.verticalRightInnerExtent), Math.max(start, c.verticalRightInnerExtent)];
        }
        return [Math.min(y, c.verticalFullExtent), Math.max(y, c.verticalFullExtent)];
      };
      // Keep a family on neighboring tracks before resolving conflicts with
      // the opposite band. A lone departure yields to a multi-link family.
      const targetsByBand = {top: new Set(), bottom: new Set()};
      const bundled = {top: false, bottom: false};
      for (const link of group) {
        if (link.source === link.target) continue;
        const side = link.circularLinkType;
        const targets = targetsByBand[side];
        if (targets.has(link.target)) bundled[side] = true;
        targets.add(link.target);
      }
      const first = end === 'right' && bundled.bottom && !bundled.top ? 'bottom' : 'top';
      group.sort((a, b) =>
        Number(a.circularLinkType !== first) - Number(b.circularLinkType !== first) || axis(a) - axis(b));
      for (let i = 1; i < group.length; i++) {
        const link = group[i], c = link.circularPathData;
        let next = axis(link);
        const placed = group.slice(0, i);
        placed.sort((a, b) =>
          Number(a.circularLinkType !== link.circularLinkType) - Number(b.circularLinkType !== link.circularLinkType) ||
          axis(a) - axis(b));
        for (const prev of placed) {
          const opposite = prev.circularLinkType !== link.circularLinkType;
          const [lo, hi] = range(link, opposite), [prevLo, prevHi] = range(prev, opposite);
          const margin = half(link) + half(prev) + gap;
          if (Math.min(hi, prevHi) + margin < Math.max(lo, prevLo)) continue;
          if (opposite && next + margin <= axis(prev)) continue;
          next = Math.max(next, axis(prev) + margin);
        }
        const shift = next - axis(link);
        if (shift < 1e-6) continue;
        c[end + 'FullExtent'] += sign * shift;
        if (end === 'left') {
          c.leftLargeArcRadius += shift;
          c.leftSmallArcRadius += shift;
          const direction = link.circularLinkType === 'bottom' ? 1 : -1;
          moveShelf(link, direction * Math.max(direction * c.verticalFullExtent,
            direction * c.targetY + c.leftLargeArcRadius + c.leftSmallArcRadius + gap));
          c.verticalLeftInnerExtent = c.verticalFullExtent - direction * c.leftLargeArcRadius;
        } else {
          c.rightInnerExtent += shift;
          if (Number.isFinite(c.rightShelfInnerExtent)) c.rightShelfInnerExtent += shift;
          if (Number.isFinite(c.rightDepartureInnerExtent)) c.rightDepartureInnerExtent += shift;
        }
      }
    }
  }
  packShelves();
  // A frame enclosing a local return must also enclose its shelf, provided
  // its source port permits nesting. Otherwise moving only the shelf would
  // introduce a crossing at the source. Preserve already ordered frames.
  const frames = links.filter(simple).sort((a, b) =>
    (a.circularPathData.rightFullExtent - a.circularPathData.leftFullExtent) -
    (b.circularPathData.rightFullExtent - b.circularPathData.leftFullExtent));
  for (let i = 1; i < frames.length; i++) {
    const link = frames[i], c = link.circularPathData;
    const sign = link.circularLinkType === 'bottom' ? 1 : -1;
    let shelf = sign * c.verticalFullExtent;
    for (let j = 0; j < i; j++) {
      const prev = frames[j], pc = prev.circularPathData;
      if (link.source.column <= link.target.column || prev.source.column !== prev.target.column ||
          prev.circularLinkType !== link.circularLinkType || link.source.column !== prev.source.column ||
          sign * (c.sourceY - pc.sourceY) >= 0 || c.leftFullExtent > pc.leftFullExtent ||
          c.rightFullExtent < pc.rightFullExtent ||
          sign * c.verticalFullExtent >= sign * pc.verticalFullExtent) continue;
      const clearance = Math.max(half(link) + half(prev) + gap,
        c.leftLargeArcRadius - pc.leftLargeArcRadius, c.rightLargeArcRadius - pc.rightLargeArcRadius);
      shelf = Math.max(shelf, sign * pc.verticalFullExtent + clearance);
    }
    moveShelf(link, sign * shelf);
  }

  // Remove depth left over from spacing local bottom loops. Only compact
  // routes that share a target or form a reciprocal pair, so a local loop
  // that already has its own band keeps its chosen shelf.
  const localBottom = links.filter(link => simple(link) && link.circularLinkType === 'bottom' &&
    link.source !== link.target && link.source.column === link.target.column)
    .sort((a, b) => a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent);
  for (const link of localBottom) {
    const c = link.circularPathData, h = half(link);
    if (!localBottom.some(other => other !== link &&
        other.circularPathData.verticalFullExtent < c.verticalFullExtent &&
        (other.target === link.target || (other.source === link.target && other.target === link.source)))) continue;
    let shelf = Math.max(c.targetY + c.leftSmallArcRadius + c.leftLargeArcRadius,
      c.sourceY + c.rightSmallArcRadius + c.rightLargeArcRadius) + gap;
    for (const other of links) {
      const oc = other.circularPathData;
      if (other === link || other.circularLinkType !== 'bottom' ||
          oc.verticalFullExtent >= c.verticalFullExtent ||
          oc.rightFullExtent <= c.leftFullExtent || oc.leftFullExtent >= c.rightFullExtent) continue;
      shelf = Math.max(shelf, oc.verticalFullExtent + half(other) + h + gap);
    }
    for (const node of graph.nodes || []) {
      if (node.virtual || node === link.source || node === link.target ||
          node.x1 <= c.leftFullExtent || node.x0 >= c.rightFullExtent) continue;
      shelf = Math.max(shelf, node.y1 + h + gap);
    }
    if (shelf < c.verticalFullExtent) moveShelf(link, shelf);
  }

  // Once the lanes are final, route enclosing cross-column families beyond
  // local returns inside their corridor. Keep all shelves in the family
  // together; moving only the link that crosses would split the family.
  const bottomFamilies = new Map();
  for (const link of links.filter(simple)) {
    if (link.circularLinkType !== 'bottom' || link.source.column <= link.target.column) continue;
    if (!bottomFamilies.has(link.target)) bottomFamilies.set(link.target, new Map());
    const columns = bottomFamilies.get(link.target);
    if (!columns.has(link.source.column)) columns.set(link.source.column, []);
    columns.get(link.source.column).push(link);
  }
  for (const columns of bottomFamilies.values()) for (const family of columns.values()) {
    family.sort((a, b) => a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent);
    const first = family[0], start = first.circularPathData.verticalFullExtent;
    let shelf = start;
    for (const local of links) {
      if (!simple(local) || local.source === local.target || local.source.column !== local.target.column ||
          local.circularLinkType !== 'bottom' || local.source.column <= first.target.column ||
          local.source.column >= first.source.column) continue;
      const inner = local.circularPathData;
      if (!family.every(link => {
        const c = link.circularPathData, margin = half(link) + half(local) + gap;
        return c.leftFullExtent + margin <= inner.leftFullExtent &&
          c.rightFullExtent - margin >= inner.rightFullExtent &&
          (c.rightShelfInnerExtent ?? c.rightInnerExtent) >= inner.rightFullExtent &&
          (c.leftShelfInnerExtent ?? c.leftInnerExtent) <= inner.leftFullExtent;
      })) continue;
      shelf = Math.max(shelf, inner.verticalFullExtent + half(first) + half(local) + gap);
    }
    if (shelf <= start + 1e-6) continue;
    for (let i = 0; i < family.length; i++) {
      const link = family[i], c = link.circularPathData;
      if (i > 0) {
        const prev = family[i - 1], pc = prev.circularPathData;
        shelf += Math.max(half(link) + half(prev) + gap, c.leftLargeArcRadius - pc.leftLargeArcRadius,
          c.rightLargeArcRadius - pc.rightLargeArcRadius);
      }
      moveShelf(link, shelf);
    }
  }
}
