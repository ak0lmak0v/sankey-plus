// Preserve the target bundles established before per-column shelf compaction.
// A shared source column can return to several target columns. Compacting those
// columns independently must not turn their bundles into alternating shelves.
export function preserveReturnBundleGroups(graph, gap, baseRadius = 5) {
  const byTarget = new Map();
  for (const link of graph.links) {
    if (!link.circular || link.isVirtual || link.circularLinkType !== 'bottom' ||
        !link.circularPathData || link.source.column <= link.target.column) continue;
    if (!byTarget.has(link.target.column)) byTarget.set(link.target.column, []);
    byTarget.get(link.target.column).push(link);
  }
  const bySource = new Map();
  for (const links of byTarget.values()) {
    const source = links[0].source.column;
    // Multi-column source corridors have their own nesting constraints. Keep
    // this consolidation to whole bundles sharing a single source column.
    if (links.length < 2 || links.some(link => link.source.column !== source)) continue;
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(links);
  }
  const half = link => Math.max(link.width || 0, 1) / 2;
  for (const bundles of bySource.values()) {
    if (bundles.length < 2) continue;
    const members = bundles.flat();
    const runCount = coordinate => {
      const ordered = members.slice().sort((a, b) => coordinate(a) - coordinate(b));
      const runs = [];
      for (const link of ordered)
        if (runs.at(-1) !== link.target.column) runs.push(link.target.column);
      return runs.length;
    };
    if (runCount(l => l.circularPathData.verticalFullExtent) === bundles.length &&
        runCount(l => l.circularPathData.rightFullExtent) === bundles.length) continue;
    // Same origin column: nearer target columns form the inner bundles,
    // matching calcVerticalBuffer's initial target-column order.
    bundles.sort((a, b) => b[0].target.column - a[0].target.column);
    const sharedX = members.every(link => Math.abs(link.circularPathData.sourceX -
      members[0].circularPathData.sourceX) < 1e-6 &&
      !link.circularPathData.sourcePortWrap && !link.circularPathData.mirroredSourceRadius);
    let outerEdge = -Infinity, rightEdge = -Infinity, rightPrevious;
    for (const bundle of bundles) {
      bundle.sort((a, b) => a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent);
      if (!sharedX) {
        // Staggered departures have additional constraints; translate their
        // shelves together instead of changing their established turn slots.
        const innerEdge = Math.min(...bundle.map(link =>
          link.circularPathData.verticalFullExtent - half(link)));
        const shift = Math.max(0, outerEdge + gap - innerEdge);
        for (const link of bundle) {
          const c = link.circularPathData;
          c.verticalFullExtent += shift;
          c.verticalRightInnerExtent += shift;
          c.verticalLeftInnerExtent += shift;
          if (Number.isFinite(c.verticalBuffer)) c.verticalBuffer += shift;
        }
      } else {
        let previous;
        for (const link of bundle) {
          const c = link.circularPathData, h = half(link), oldShelf = c.verticalFullExtent;
          const clearance = previous ? half(previous) + h + gap : 0;
          // Slot radii must be recomputed along with slot coordinates. Keeping
          // radii inherited from interleaved bundles leaves artificial holes.
          // Neighboring target bundles share the same lower source-side turn.
          // Carry its radius across the boundary instead of restarting a small
          // corner inside the preceding bundle's large quarter-circle.
          const radius = rightPrevious ? rightPrevious.circularPathData.rightLargeArcRadius +
            half(rightPrevious) + h + gap : baseRadius + h;
          const axis = Math.max(c.sourceX + (c.rightNodeBuffer || 0) + radius,
            previous ? previous.circularPathData.rightFullExtent + clearance : rightEdge + gap + h);
          const small = Math.min(radius, Math.max(baseRadius + h, c.rightSmallArcRadius));
          const departure = axis - small, shelfEnd = axis - radius;
          let shelf = Math.max(c.sourceY + small + radius + gap,
            c.targetY + c.leftSmallArcRadius + c.leftLargeArcRadius + gap,
            outerEdge + gap + h);
          if (previous) {
            const pc = previous.circularPathData;
            shelf = Math.max(shelf, pc.verticalFullExtent + Math.max(clearance,
              c.leftLargeArcRadius - pc.leftLargeArcRadius, radius - pc.rightLargeArcRadius));
          } else if (!Number.isFinite(outerEdge)) shelf = Math.max(shelf, oldShelf);
          const left = Math.min(c.leftInnerExtent, shelfEnd), right = Math.max(c.leftInnerExtent, shelfEnd);
          for (const node of graph.nodes || []) {
            if (node.virtual || node === link.source || node === link.target ||
                node.x1 <= left || node.x0 >= right) continue;
            shelf = Math.max(shelf, node.y1 + h + gap);
          }
          for (const other of graph.links) {
            const oc = other.circularPathData;
            if (members.includes(other) || !other.circular || other.isVirtual ||
                other.circularLinkType !== 'bottom' || !oc || oc.verticalFullExtent > oldShelf + 1e-6 ||
                oc.rightFullExtent <= left || oc.leftFullExtent >= right) continue;
            shelf = Math.max(shelf, oc.verticalFullExtent + half(other) + h + gap);
          }
          c.rightFullExtent = axis;
          c.rightSmallArcRadius = small;
          c.rightSourceLargeArcRadius = small;
          c.rightLargeArcRadius = radius;
          c.rightInnerExtent = shelfEnd;
          c.rightDepartureInnerExtent = departure;
          c.rightShelfInnerExtent = shelfEnd;
          c.verticalFullExtent = shelf;
          c.verticalRightInnerExtent = shelf - radius;
          c.verticalLeftInnerExtent = shelf - c.leftLargeArcRadius;
          if (Number.isFinite(c.verticalBuffer)) c.verticalBuffer += shelf - oldShelf;
          previous = link;
          rightPrevious = link;
        }
      }
      outerEdge = Math.max(...bundle.map(link =>
        link.circularPathData.verticalFullExtent + half(link)));
      rightEdge = Math.max(...bundle.map(link => link.circularPathData.rightFullExtent + half(link)));
    }
  }
}


// Target ports touch at the node, whereas parallel shelves have an explicit
// gap. Giving both axes of every arrival ellipse that gap forces twice the
// intended shelf spacing. Tighten the vertical arrival axis with the shelf;
// keep the horizontal lane, port positions and shelf-corner radius intact.
export function compactTopReturnShelves(graph, gap, baseRadius = 5) {
  const groups = new Map();
  for (const link of graph.links) {
    const c = link.circularPathData;
    if (!link.circular || link.isVirtual || link.circularLinkType !== 'top' ||
        link.source === link.target || link.source.column < link.target.column || !c ||
        c.sourcePortWrap || c.mirroredSourceRadius || c.leftShelfArcRadius ||
        c.localPortBridgeRadius || c.localForwardRadius) continue;
    if (!groups.has(link.target)) groups.set(link.target, []);
    groups.get(link.target).push(link);
  }
  const half = link => (link.width || 0) / 2;
  const shelf = c => [c.leftInnerExtent, c.rightShelfInnerExtent ?? c.rightInnerExtent];
  function turnCeiling(link, group, minSmall) {
    const c = link.circularPathData;
    let ceiling = Math.min(c.targetY - c.leftLargeArcRadius - minSmall,
      c.sourceY - c.rightSmallArcRadius - c.rightLargeArcRadius);
    const [x0, x1] = shelf(c);
    for (const node of graph.nodes || []) {
      if (node.virtual || node === link.source || node === link.target ||
        node.x1 <= x0 || node.x0 >= x1) continue;
      ceiling = Math.min(ceiling, node.y0 - half(link) - gap);
    }
    for (const other of graph.links) {
      const oc = other.circularPathData;
      if (group.includes(other) || !other.circular || other.isVirtual ||
        other.circularLinkType !== 'top' || !oc ||
        oc.verticalFullExtent <= c.verticalFullExtent + 1e-6) continue;
      const [ox0, ox1] = shelf(oc);
      if (ox1 <= x0 || ox0 >= x1) continue;
      ceiling = Math.min(ceiling, oc.verticalFullExtent - half(other) - half(link) - gap);
    }
    return ceiling;
  }
  // Preserve the already adjacent whole-bundle chain before any inner
  // shelves move. Dependencies can cross target columns: a later enclosing
  // frame must follow its inner neighbor regardless of where it terminates.
  const frames = Array.from(groups.values(), group => {
    group.sort((a, b) => b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent);
    return {group, inner: group[0], outer: group[group.length - 1], dependencies: []};
  }).sort((a, b) => b.inner.circularPathData.verticalFullExtent - a.inner.circularPathData.verticalFullExtent);
  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i], c = frame.inner.circularPathData;
    for (let j = 0; j < i; j++) {
      const prev = frames[j], pc = prev.outer.circularPathData;
      const clearance = half(prev.outer) + half(frame.inner) + gap;
      const [x0, x1] = shelf(c), [px0, px1] = shelf(pc);
      if (x1 <= px0 || px1 <= x0 ||
          Math.abs(pc.verticalFullExtent - c.verticalFullExtent - clearance) > 1e-5) continue;
      frame.dependencies.push({inner: prev.outer, clearance});
    }
  }
  for (const group of groups.values()) {
    for (let i = 1; i < group.length; i++) {
      const link = group[i], c = link.circularPathData;
      const prev = group[i - 1], pc = prev.circularPathData;
      const clearance = half(prev) + half(link) + gap;
      // Only compact nested target turns. Separate lane frames retain their
      // existing constraints rather than being pulled through one another.
      if (c.targetY < pc.targetY || Math.abs(c.leftInnerExtent - pc.leftInnerExtent) > 1e-6 ||
          c.leftLargeArcRadius < pc.leftLargeArcRadius + clearance - 1e-6) continue;
      const minSmall = Math.min(c.leftSmallArcRadius,
        Math.max(baseRadius + half(link), c.leftLargeArcRadius / 2));
      const ceiling = Math.min(pc.verticalFullExtent - Math.max(clearance,
        c.leftLargeArcRadius - pc.leftLargeArcRadius), turnCeiling(link, group, minSmall));
      const shift = ceiling - c.verticalFullExtent;
      if (!(shift > 1e-6)) continue;
      c.leftSmallArcRadius = Math.min(c.leftSmallArcRadius,
        c.targetY - ceiling - c.leftLargeArcRadius);
      c.verticalFullExtent = ceiling;
      c.verticalLeftInnerExtent += shift;
      c.verticalRightInnerExtent += shift;
      if (Number.isFinite(c.verticalBuffer)) c.verticalBuffer -= shift;
    }
  }
  // Process from inner to outer so a shift reaches every following frame
  // in one pass. Move the complete bundle, retaining its internal radii and
  // spacing, and cap the shift by all node, turn and unrelated-shelf bounds.
  for (const {group, inner, dependencies} of frames) {
    let shift = 0;
    for (const dependency of dependencies)
      shift = Math.max(shift, dependency.inner.circularPathData.verticalFullExtent -
        inner.circularPathData.verticalFullExtent - dependency.clearance);
    if (!(shift > 1e-5)) continue;
    for (const link of group)
      shift = Math.min(shift, turnCeiling(link, group, link.circularPathData.leftSmallArcRadius) -
        link.circularPathData.verticalFullExtent);
    if (!(shift > 1e-5)) continue;
    for (const link of group) {
      const c = link.circularPathData;
      c.verticalFullExtent += shift;
      c.verticalLeftInnerExtent += shift;
      c.verticalRightInnerExtent += shift;
      if (Number.isFinite(c.verticalBuffer)) c.verticalBuffer -= shift;
    }
  }
}

// Reuse source-column slots as whole target families after per-node routing.
// Local loops and wrapped departures own separate frames and are left intact.
export function groupTopSourceLegs(graph, gap, baseRadius = 5) {
  const columns = new Map();
  for (const link of graph.links) {
    if (!link.circular || link.isVirtual || link.circularLinkType !== 'top') continue;
    if (!columns.has(link.source.column)) columns.set(link.source.column, []);
    columns.get(link.source.column).push(link);
  }
  for (const links of columns.values()) {
    if (links.some(l => l.source.column <= l.target.column || !l.circularPathData ||
        l.circularPathData.sourcePortWrap || l.circularPathData.mirroredSourceRadius ||
        l.circularPathData.localPortBridgeRadius || l.circularPathData.localForwardRadius ||
        Math.abs(l.circularPathData.sourceX - links[0].circularPathData.sourceX) > 1e-6)) continue;
    const targets = new Map();
    for (const link of links) {
      if (!targets.has(link.target)) targets.set(link.target, []);
      targets.get(link.target).push(link);
    }
    if (targets.size < 2) continue;
    const ordered = links.slice().sort((a, b) => a.circularPathData.rightFullExtent - b.circularPathData.rightFullExtent);
    const runs = ordered.filter((l, i) => i === 0 || l.target !== ordered[i - 1].target);
    if (runs.length === targets.size) continue;
    const bundles = Array.from(targets.values());
    bundles.forEach(group => group.sort((a, b) => b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent));
    bundles.sort((a, b) => b[0].circularPathData.verticalFullExtent - a[0].circularPathData.verticalFullExtent);
    const origin = links[0].circularPathData.sourceX + Math.max(...links.map(l => l.circularPathData.rightNodeBuffer || 0));
    let radius, previous;
    for (const link of bundles.flat()) {
      const c = link.circularPathData, half = (link.width || 0) / 2;
      radius = previous ? radius + ((previous.width || 0) + (link.width || 0)) / 2 + gap : baseRadius + half;
      const small = Math.min(radius, Math.max(baseRadius + half, c.rightSmallArcRadius));
      c.rightFullExtent = origin + radius;
      c.rightLargeArcRadius = radius;
      c.rightSmallArcRadius = c.rightSourceLargeArcRadius = small;
      c.rightInnerExtent = c.rightShelfInnerExtent = origin;
      c.rightDepartureInnerExtent = c.rightFullExtent - small;
      c.verticalRightInnerExtent = c.verticalFullExtent + radius;
      previous = link;
    }
  }
}

// A flattened arrival ellipse can pinch its inner stroke. Reserve a little
// more shelf height for that whole target family, retaining round arrival
// corners and the family's existing gaps. Outward pressure follows the
// original shelf order so neighboring frames cannot be crossed by the repair.
export function roundPinchedTopArrivals(graph, gap, baseRadius = 5) {
  const top = graph.links.filter(l => l.circular && !l.isVirtual && l.circularLinkType === 'top' && l.circularPathData);
  const oldShelf = new Map(top.map(l => [l, l.circularPathData.verticalFullExtent]));
  const groups = new Map();
  const simple = link => {
    const c = link.circularPathData;
    return !c.sourcePortWrap && !c.mirroredSourceRadius && !c.leftShelfArcRadius &&
      !c.localPortBridgeRadius && !c.localForwardRadius && !c.localDownwardRadius;
  };
  for (const link of top) {
    if (!simple(link)) continue;
    const key = link.source === link.target ? link : link.target;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(link);
  }
  const half = l => (l.width || 0) / 2;
  const overlaps = (a, b) => {
    const ac = a.circularPathData, bc = b.circularPathData;
    return Math.min(ac.rightShelfInnerExtent ?? ac.rightInnerExtent, bc.rightShelfInnerExtent ?? bc.rightInnerExtent) >
      Math.max(ac.leftInnerExtent, bc.leftInnerExtent);
  };
  const frames = Array.from(groups.values()).sort((a, b) =>
    Math.max(...b.map(l => oldShelf.get(l))) - Math.max(...a.map(l => oldShelf.get(l))));
  for (const group of frames) {
    let round = group.length > 1 && group.every(l => l.source !== l.target) && group.some(l => {
      const c = l.circularPathData;
      return c.leftSmallArcRadius * c.leftSmallArcRadius / c.leftLargeArcRadius < baseRadius + half(l) - 1e-5;
    });
    let shift = 0;
    if (round) for (const link of group) {
      const c = link.circularPathData;
      shift = Math.min(shift, c.targetY - 2 * c.leftLargeArcRadius - c.verticalFullExtent);
    }
    // A special route's shelf is fixed by its own routing model. Do not pull
    // a family through it in order to obtain a round corner.
    if (round && top.some(other => !simple(other) && group.some(link =>
      overlaps(link, other) && oldShelf.get(other) < oldShelf.get(link) &&
      oldShelf.get(link) + shift < oldShelf.get(other) + half(other) + half(link) + gap))) {
      round = false; shift = 0;
    }
    if (round) for (const link of group) link.circularPathData.leftSmallArcRadius = link.circularPathData.leftLargeArcRadius;
    for (const link of group) {
      const c = link.circularPathData;
      // Source-slot regrouping can enlarge a turn independently of rounding.
      shift = Math.min(shift, c.sourceY - c.rightSmallArcRadius - c.rightLargeArcRadius - c.verticalFullExtent);
      for (const other of top) {
        if (group.includes(other) || !overlaps(link, other) || oldShelf.get(other) <= oldShelf.get(link) + 1e-5) continue;
        shift = Math.min(shift, other.circularPathData.verticalFullExtent - half(other) - half(link) - gap - c.verticalFullExtent);
      }
    }
    if (!(shift < -1e-5)) continue;
    for (const link of group) {
      const c = link.circularPathData;
      c.verticalFullExtent += shift;
      c.verticalLeftInnerExtent += shift;
      c.verticalRightInnerExtent += shift;
      if (Number.isFinite(c.verticalBuffer)) c.verticalBuffer -= shift;
    }
  }
}
