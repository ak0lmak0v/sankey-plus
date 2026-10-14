import {positionColumns} from "./columnSpacing.js";
import {groups, sum, min, max} from "d3";

export function adjustSankeySize(
  inputGraph,
  useManualScale,
  nodePadding,
  nodeWidth,
  scaleDomain,
  scaleRange,
  circularLinkPortionTopBottom,
  circularLinkPortionLeftRight,
  scale,
  baseRadius,
  columnSpacing
) {
  let graph = inputGraph;

  let columns = 
    groups(graph.nodes, (d) => d.column)
    .sort((a, b) => a[0] - b[0])
    .map((d) => d[1]);

  if (true) {
    graph.py = nodePadding;

    // Reset any previously computed port-gap state
    graph.nodes.forEach(function(n) {
      n._circularPortGapPx = 0;
    });
    graph.circularPortGapPx = 0;

    // Compute ky from available vertical space.
    //
    // IMPORTANT: virtual nodes are routing helpers and should NOT consume padding budget.
    // Counting virtual nodes in (nodes.length - 1) can make ky go negative on shorter charts
    // (e.g. height 550), which breaks the whole layout (negative link widths, inverted nodes).
    //
    // Therefore we compute the padding term using ONLY non-virtual (real) nodes.
    var ky = min(columns, function (nodes) {
      const realCount = nodes.reduce((acc, d) => acc + (d && d.virtual ? 0 : 1), 0);
      const gapCount = Math.max(0, realCount - 1);
      const sumVal = sum(nodes, function (d) {
        return d && d.virtual ? 0 : d.value;
      });
      if (!sumVal || sumVal <= 0) return 0;
      const available = (graph.y1 - graph.y0);
      // If chart is too short to accommodate the requested padding, allow padding to compress.
      // This keeps ky >= 0 and avoids catastrophic layout failures.
      const pyEff = gapCount > 0 ? Math.min(graph.py, available / gapCount) : 0;
      const numer = available - gapCount * pyEff;
      return numer > 0 ? (numer / sumVal) : 0;
    });

    let maxColumnSum = max(columns, function (nodes) {
      const realCount = nodes.reduce((acc, d) => acc + (d && d.virtual ? 0 : 1), 0);
      const gapCount = Math.max(0, realCount - 1);
      let sumNodesValue =
        sum(nodes, function (d) {
          return d && d.virtual ? 0 : d.value;
        }) +
        gapCount * graph.py;
      return sumNodesValue;
    });

    let ky1 = (graph.y1 - graph.y0) / maxColumnSum;

    // calculate the widths of the links
    // Guard: ky must be finite and non-negative
    graph.ky = (Number.isFinite(ky) && ky > 0 ? ky : 0) * scale;

    graph.links.forEach(function (link) {
      link.width = link.value * graph.ky;
    });

    //determine how much to scale down the chart, based on circular links

    var totalTopLinksWidth = 0,
      totalBottomLinksWidth = 0,
      totalRightLinksWidth = 0,
      totalLeftLinksWidth = 0;

    var maxColumn = max(graph.nodes, function (node) {
      return node.column;
    });

    graph.links.forEach(function (link) {
      if (link.circular) {
        if (link.circularLinkType == "top") {
          totalTopLinksWidth = totalTopLinksWidth + link.width;
        } else {
          totalBottomLinksWidth = totalBottomLinksWidth + link.width;
        }

        if (link.target.column == 0) {
          totalLeftLinksWidth = totalLeftLinksWidth + link.width;
        }

        if (link.source.column == maxColumn) {
          totalRightLinksWidth = totalRightLinksWidth + link.width;
        }
      }
    });

    //account for radius of curves and padding between links
    totalTopLinksWidth =
      totalTopLinksWidth > 0
        ? totalTopLinksWidth + baseRadius
        : totalTopLinksWidth;
    totalBottomLinksWidth =
      totalBottomLinksWidth > 0
        ? totalBottomLinksWidth + baseRadius
        : totalBottomLinksWidth;
    totalRightLinksWidth =
      totalRightLinksWidth > 0
        ? totalRightLinksWidth + baseRadius
        : totalRightLinksWidth;
    totalLeftLinksWidth =
      totalLeftLinksWidth > 0
        ? totalLeftLinksWidth + baseRadius
        : totalLeftLinksWidth;

    var margin = {
      top: totalTopLinksWidth,
      bottom: totalBottomLinksWidth,
      left: totalLeftLinksWidth,
      right: totalRightLinksWidth,
    };

    positionColumns(graph, nodeWidth, columnSpacing);
  }

  return graph;
}
