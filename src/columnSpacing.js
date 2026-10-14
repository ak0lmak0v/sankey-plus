// Reserve space at backlink turns, rather than across their straight shelves.
// The total drawing width remains fixed; quieter gaps donate room to busy ones.
export function positionColumns(graph, nodeWidth, options = {}) {
  const maxColumn = Math.max(0, ...graph.nodes.map(node => node.column));
  const span = Math.max(0, graph.x1 - graph.x0 - nodeWidth);
  if (maxColumn === 0) {
    graph.nodes.forEach(node => { node.x0 = graph.x0; node.x1 = node.x0 + nodeWidth; });
    return;
  }
  const uniformStep = span / maxColumn;
  const gapWidth = Math.max(0, span - maxColumn * nodeWidth);
  const loads = Array(maxColumn).fill(0);
  if (options.adaptive) {
    graph.links.forEach(link => {
      if (!link.circular || link.isVirtual || link.source.column <= link.target.column) return;
      const room = Math.max(link.width || 0, 1) + Math.max(options.gap || 0, 0) +
        2 * Math.max(options.radius || 0, 0);
      // Source turns lie to the right; target turns lie to the left.
      if (link.source.column < maxColumn) loads[link.source.column] += room;
      if (link.target.column > 0) loads[link.target.column - 1] += room;
    });
  }
  const adaptive = options.adaptive && loads.some(load => load > 0) && gapWidth > 0;
  const minimum = Math.min(120, gapWidth / maxColumn * 0.6);
  const remaining = gapWidth - minimum * maxColumn;
  const strength = Number.isFinite(options.strength) ? Math.max(0, options.strength) : 1;
  const weights = loads.map(load => 1 + load / 40 * strength);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const positions = [graph.x0];
  for (let i = 0; i < maxColumn; i++) {
    const step = adaptive ? nodeWidth + minimum + remaining * weights[i] / total : uniformStep;
    positions.push(positions[i] + step);
  }
  graph.nodes.forEach(node => {
    node.x0 = positions[node.column];
    node.x1 = node.x0 + nodeWidth;
  });
}
