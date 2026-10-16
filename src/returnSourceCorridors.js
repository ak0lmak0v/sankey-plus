// Reserve nested source corridors before the final circular paths are built.
// Node and port translations preserve thickness and input link ordering.
export function prepareReturnSourceCorridors(graph, gap, baseRadius) {
  graph.links.forEach(link => { delete link._returnSourceAxis; });
  const returns = graph.links.filter(link => link.circular && !link.isVirtual &&
    link.source.column > link.target.column);
  const groups = new Map();
  const axes = new Map();
  const original = new Map(graph.nodes.map(node => [node, node.y0]));
  const offsets = new Map(graph.links.map(link => [link, link.y0 - link.source.y0]));
  const nodeBuffer = 5;
  const half = link => Math.max(link.width || 0, 1) / 2;
  const clearance = (a, b) => half(a) + half(b) + gap;
  returns.forEach(link => {
    const key = link.source.column + '|' + link.circularLinkType;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(link);
  });
  groups.forEach(group => {
    const bottom = group[0].circularLinkType === 'bottom';
    group.sort((a, b) => a.source._staggeredReturnSource && b.source._staggeredReturnSource && a.source !== b.source ?
      a.source.x1 - b.source.x1 : bottom ? b.y0 - a.y0 : a.y0 - b.y0);
    let previous;
    for (const link of group) {
      let radius = baseRadius + half(link);
      if (previous && (!link.source._staggeredReturnSource || previous.source === link.source))
        radius = Math.max(radius, axes.get(previous) - previous.source.x1 - nodeBuffer + clearance(previous, link));
      for (const loop of link.source.sourceLinks) {
        if (!loop.circular || loop.isVirtual || loop.source !== loop.target ||
            loop.circularLinkType !== link.circularLinkType) continue;
        radius = Math.max(radius, baseRadius + half(link) + (loop.width || 0) + gap);
      }
      axes.set(link, link.source.x1 + nodeBuffer + radius);
      previous = link;
    }
  });

  // Target port order defines the nesting of their shared shelf corridor.
  // A source in an earlier column may need a longer straight departure to
  // put its outer shelf outside a later source's inner shelf.
  const targetGroups = new Map();
  returns.forEach(link => {
    if (link.circularLinkType !== 'bottom') return;
    const key = link.target.column;
    if (!targetGroups.has(key)) targetGroups.set(key, []);
    targetGroups.get(key).push(link);
  });
  let changed = false;
  targetGroups.forEach(group => {
    group.sort((a, b) => b.y1 - a.y1);
    for (let i = 1; i < group.length; i++) {
      const outer = group[i];
      for (let j = 0; j < i; j++) {
        const inner = group[j];
        const needed = axes.get(inner) + clearance(outer, inner);
        if (axes.get(outer) >= needed - 1e-6) continue;
        axes.set(outer, needed);
        outer._returnSourceAxis = needed;
        changed = true;
      }
    }
  });
  if (!changed) return;

  // Resolve straight departure/vertical-leg conflicts as difference
  // constraints on source node positions. Horizontally staggered nodes may
  // overlap in Y; nodes whose bodies overlap in X retain their vertical order.
  const constraints = [];
  const add = (before, after, distance) => {
    if (before !== after) constraints.push({before, after, distance});
  };
  for (const a of returns) {
    const end = axes.get(a) - baseRadius - half(a);
    for (const b of returns) {
      if ((!Number.isFinite(a._returnSourceAxis) && !Number.isFinite(b._returnSourceAxis)) || a === b || axes.get(b) <= a.source.x1 + clearance(a, b) ||
          axes.get(b) >= end + clearance(a, b)) continue;
      const delta = offsets.get(a) - offsets.get(b);
      if (b.circularLinkType === 'bottom') add(a.source, b.source, delta + clearance(a, b));
      else add(b.source, a.source, -delta + clearance(a, b));
    }
    for (const node of graph.nodes) {
      if (node.virtual || node === a.source || node.x1 <= a.source.x1 || node.x0 >= end) continue;
      const crossed = returns.filter(b => b.source === node &&
        axes.get(b) > a.source.x1 + clearance(a, b) && axes.get(b) < end + clearance(a, b));
      const hasBottom = crossed.some(b => b.circularLinkType === 'bottom');
      const hasTop = crossed.some(b => b.circularLinkType === 'top');
      const above = hasBottom !== hasTop ? hasBottom : a.y0 <= (node.y0 + node.y1) / 2;
      let top = 0, bottom = node.y1 - node.y0;
      for (const loop of node.sourceLinks) {
        const c = loop.circularPathData;
        if (!loop.circular || loop.isVirtual || loop.source !== loop.target || !c) continue;
        const shelf = loop.y0 - node.y0 + c.verticalFullExtent - c.sourceY;
        top = Math.min(top, shelf - half(loop));
        bottom = Math.max(bottom, shelf + half(loop));
      }
      if (above)
        add(a.source, node, offsets.get(a) - top + half(a) + gap);
      else add(node, a.source, bottom - offsets.get(a) + half(a) + gap);
    }
  }
  const nodes = graph.nodes.filter(node => !node.virtual).sort((a, b) => a.y0 - b.y0);
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    if (a.x0 < b.x1 && b.x0 < a.x1)
      add(a, b, a.y1 - a.y0 + Math.max(0, b.y0 - a.y1));
  }
  const positions = new Map(original);
  let stable = false;
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    stable = true;
    for (const {before, after, distance} of constraints) {
      const next = positions.get(before) + distance;
      if (next <= positions.get(after) + 1e-6) continue;
      positions.set(after, next);
      stable = false;
    }
    if (stable) break;
  }
  // A positive constraint cycle needs a different corridor embedding. Do not
  // leave a partly translated graph when that embedding is infeasible.
  if (!stable) {
    graph.links.forEach(link => { delete link._returnSourceAxis; });
    return;
  }
  graph.nodes.forEach(node => {
    const delta = positions.get(node) - original.get(node);
    node.y0 += delta; node.y1 += delta;
  });
  graph.links.forEach(link => {
    link.y0 += positions.get(link.source) - original.get(link.source);
    link.y1 += positions.get(link.target) - original.get(link.target);
  });
}
