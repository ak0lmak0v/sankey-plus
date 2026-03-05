import { getNodeID } from "./nodeAttributes.js";
import { linkPerpendicularYToLinkSource, linkPerpendicularYToLinkTarget, selfLinking } from "./linkAttributes.js";


// sort ascending links by their source vertical position, y0
export function sortLinkSourceYAscending(link1, link2) {
    return link1.y0 - link2.y0;
}

// sort descending links by their source vertical position, y0
export function sortLinkSourceYDescending(link1, link2) {
    return link2.y0 - link1.y0;
}

// sort ascending links by their target vertical position, y1
export function sortLinkTargetYAscending(link1, link2) {
    return link1.y1 - link2.y1;
}

// sort descending links by their target vertical position, y1
export function sortLinkTargetYDescending(link1, link2) {
    return link2.y1 - link1.y1;
}

// sort links' breadth (ie top to bottom in a column), based on their source nodes' breadths
// For links coming from different columns, use slope-based comparison to minimize crossings
export function ascendingSourceBreadth(a, b) {
    // If both links come from different columns, compare by slope
    if (a.source.column !== b.source.column && !a.circular && !b.circular) {
        var targetCol = a.target.column;
        var targetY = (a.target.y0 + a.target.y1) / 2;
        
        // Calculate source Y centers
        var aSourceY = (a.source.y0 + a.source.y1) / 2;
        var bSourceY = (b.source.y0 + b.source.y1) / 2;
        
        // Calculate slopes (vertical change per column traveled)
        var aSlope = (targetY - aSourceY) / (targetCol - a.source.column);
        var bSlope = (targetY - bSourceY) / (targetCol - b.source.column);
        
        // Sort by slope: links with smaller slope should be on top
        return aSlope - bSlope;
    }
    // For links from the same column, sort by source y0 ASCENDING  
    // Links coming from upper nodes enter at top, links from lower nodes enter at bottom
    return a.source.y0 - b.source.y0 || a.index - b.index;
}

// Helper to get the "final" target y0 - for virtual links, use the real target node
function getFinalTargetY0(link) {
    // If target is virtual, find the real final target via replacedLink reference
    if (link.target.virtual && link.target.replacedLink !== undefined) {
        // The replacedLink is stored as parentLink on the link itself
        // But we need to look at the virtual node's replacedLink to find the actual target
        // For now, just use the immediate target since we can't easily traverse
        return link.target.y0;
    }
    return link.target.y0;
}

// sort links' breadth (ie top to bottom in a column), based on their target nodes' breadths
// For links going to different columns, use slope-based comparison to minimize crossings
export function ascendingTargetBreadth(a, b) {
    // If both links go to different columns, compare by slope (vertical change per column)
    // This determines which link should exit from top to minimize Bezier curve crossings
    if (a.target.column !== b.target.column && !a.circular && !b.circular) {
        var sourceCol = a.source.column;
        var sourceY = (a.source.y0 + a.source.y1) / 2;
        
        // Calculate target Y centers
        var aTargetY = (a.target.y0 + a.target.y1) / 2;
        var bTargetY = (b.target.y0 + b.target.y1) / 2;
        
        // Calculate slopes (vertical change per column traveled)
        var aSlope = (aTargetY - sourceY) / (a.target.column - sourceCol);
        var bSlope = (bTargetY - sourceY) / (b.target.column - sourceCol);
        
        // Sort by slope: links with smaller slope (going more upward/horizontal) should be on top
        return aSlope - bSlope;
    }
    // For links in the same column, sort by target y0 ASCENDING
    // Links going to upper nodes exit from top, links going to lower nodes exit from bottom
    // This minimizes visual crossings
    return getFinalTargetY0(a) - getFinalTargetY0(b) || a.index - b.index;
}

// sort nodes' breadth (ie top to bottom in a column)
// if both nodes have circular links, or both don't have circular links, then sort by the top (y0) of the node
// else push nodes that have top circular links to the top, and nodes that have bottom circular links to the bottom
export function ascendingBreadth(a, b) {
    if (a.partOfCycle === b.partOfCycle) {
      return a.y0 - b.y0;
    } else {
      if (a.circularLinkType === 'top' || b.circularLinkType === 'bottom') {
        return -1;
      } else {
        return 1;
      }
    }
  }


   // sort links based on the distance between the source and tartget node columns
  // if the same, then use Y position of the source node
  export function sortLinkColumnAscending(link1, link2) {
    // For bottom circular links:
    if (link1.circularLinkType == 'bottom' && link2.circularLinkType == 'bottom') {
      var dist1 = Math.abs(linkColumnDistance(link1));
      var dist2 = Math.abs(linkColumnDistance(link2));
      
      // Get max span for each link's target group (set by calcVerticalBuffer)
      var maxSpan1 = link1._targetGroupMaxSpan || dist1;
      var maxSpan2 = link2._targetGroupMaxSpan || dist2;
      
      // Primary: Sort GROUPS by their max span (shorter max span = higher = first)
      // This prevents groups with long spans from overlapping groups with short spans
      if (link1.target.column !== link2.target.column) {
        if (maxSpan1 !== maxSpan2) {
          return maxSpan1 - maxSpan2; // shorter group max span first
        }
        // Same max span - fall back to target column
        return link1.target.column - link2.target.column;
      }
      
      // Secondary: Within same target group, sort by individual span distance
      // Shorter spans first = closer sources higher
      if (dist1 !== dist2) {
        return dist1 - dist2;
      }
      
      // Tertiary: Same target, same span - sort by source column
      if (link1.source.column !== link2.source.column) {
        return link2.source.column - link1.source.column;
      }
      
      return sortLinkSourceYDescending(link1, link2);
    }
    // For top circular links:
    // We want Shortest Distance First (Inner, Lower Buffer) -> Longest Distance Last (Outer, Higher Buffer).
    // This ensures Long links arc OVER Short links without crossing vertical segments.
    // Since top links can be backward (negative distance) or forward (positive distance),
    // we must sort by Absolute Distance.
    if (Math.abs(linkColumnDistance(link1)) == Math.abs(linkColumnDistance(link2))) {
      return sortLinkSourceYAscending(link1, link2);
    } else {
      return Math.abs(linkColumnDistance(link1)) - Math.abs(linkColumnDistance(link2));
    }
  }

  function linkColumnDistance(link) {
    return link.target.column - link.source.column;
  }



  // sort and set the links' y0 for each node
export function sortSourceLinks(inputGraph, id, typeOrder, typeAccessor) {

  let graph = inputGraph;
  const circularPortGap = arguments.length > 4 && Number.isFinite(arguments[4]) ? Math.max(0, arguments[4]) : 0;

  graph.nodes.forEach(function(node) {
    // move any nodes up which are off the bottom
    if (node.y + (node.y1 - node.y0) > graph.y1) {
      node.y = node.y - (node.y + (node.y1 - node.y0) - graph.y1);
    }

    var nodesSourceLinks = graph.links.filter(function(l) {
      return getNodeID(l.source, id) == getNodeID(node, id);
    });

    var nodeSourceLinksLength = nodesSourceLinks.length;

    // if more than 1 link then sort
    if (nodeSourceLinksLength > 1) {

      nodesSourceLinks.sort(function(link1, link2) {
        // if both are not circular...
        if (!link1.circular && !link2.circular) {
          // Get the final target Y for each link
          // For virtual links, use the real target from replacedLinks
          var link1TargetY;
          var link2TargetY;
          
          // For virtual links, find the final target node in graph.nodes and use its y position
          // Note: replacedLinks contains clones, so we need to find the actual node by name
          if (link1.target.virtual && link1.target.replacedLink !== undefined && graph.replacedLinks) {
            var replacedLink1 = graph.replacedLinks.find(function(rl) { return rl.index === link1.target.replacedLink; });
            if (replacedLink1 && replacedLink1.target) {
              // Find the actual node in graph.nodes by name (clones don't have updated y coords)
              var targetName1 = typeof replacedLink1.target === 'string' ? replacedLink1.target : replacedLink1.target.name;
              var actualTarget1 = graph.nodes.find(function(n) { return n.name === targetName1; });
              if (actualTarget1 && actualTarget1.y0 !== undefined) {
                link1TargetY = (actualTarget1.y0 + actualTarget1.y1) / 2;
              } else {
                link1TargetY = (link1.target.y0 + link1.target.y1) / 2;
              }
            } else {
              link1TargetY = (link1.target.y0 + link1.target.y1) / 2;
            }
          } else {
            link1TargetY = (link1.target.y0 + link1.target.y1) / 2;
          }
          
          if (link2.target.virtual && link2.target.replacedLink !== undefined && graph.replacedLinks) {
            var replacedLink2 = graph.replacedLinks.find(function(rl) { return rl.index === link2.target.replacedLink; });
            if (replacedLink2 && replacedLink2.target) {
              var targetName2 = typeof replacedLink2.target === 'string' ? replacedLink2.target : replacedLink2.target.name;
              var actualTarget2 = graph.nodes.find(function(n) { return n.name === targetName2; });
              if (actualTarget2 && actualTarget2.y0 !== undefined) {
                link2TargetY = (actualTarget2.y0 + actualTarget2.y1) / 2;
              } else {
                link2TargetY = (link2.target.y0 + link2.target.y1) / 2;
              }
            } else {
              link2TargetY = (link2.target.y0 + link2.target.y1) / 2;
            }
          } else {
            link2TargetY = (link2.target.y0 + link2.target.y1) / 2;
          }
          
          // Calculate slope for each link: (targetY - sourceY) / deltaX
          // Links going UP have negative slope, links going DOWN have positive slope
          // For minimizing crossings, sort by slope:
          // - Links with most negative slope (going UP most steeply) should exit from TOP
          // - Links with most positive slope (going DOWN most steeply) should exit from BOTTOM
          var sourceY = (link1.source.y0 + link1.source.y1) / 2;
          
          // Get final target X positions for proper slope calculation
          var link1TargetX, link2TargetX;
          if (link1.target.virtual && link1.target.replacedLink !== undefined && graph.replacedLinks) {
            var rl1 = graph.replacedLinks.find(function(rl) { return rl.index === link1.target.replacedLink; });
            if (rl1 && rl1.target) {
              var tn1 = typeof rl1.target === 'string' ? rl1.target : rl1.target.name;
              var at1 = graph.nodes.find(function(n) { return n.name === tn1; });
              link1TargetX = at1 ? at1.x0 : link1.target.x0;
            } else {
              link1TargetX = link1.target.x0;
            }
          } else {
            link1TargetX = link1.target.x0;
          }
          
          if (link2.target.virtual && link2.target.replacedLink !== undefined && graph.replacedLinks) {
            var rl2 = graph.replacedLinks.find(function(rl) { return rl.index === link2.target.replacedLink; });
            if (rl2 && rl2.target) {
              var tn2 = typeof rl2.target === 'string' ? rl2.target : rl2.target.name;
              var at2 = graph.nodes.find(function(n) { return n.name === tn2; });
              link2TargetX = at2 ? at2.x0 : link2.target.x0;
            } else {
              link2TargetX = link2.target.x0;
            }
          } else {
            link2TargetX = link2.target.x0;
          }
          
          var link1DeltaX = link1TargetX - link1.source.x1;
          var link2DeltaX = link2TargetX - link2.source.x1;
          
          // Avoid division by zero
          if (link1DeltaX === 0) link1DeltaX = 1;
          if (link2DeltaX === 0) link2DeltaX = 1;
          
          var link1Slope = (link1TargetY - sourceY) / link1DeltaX;
          var link2Slope = (link2TargetY - sourceY) / link2DeltaX;
          
          // Sort by slope: smaller slope (more negative = more upward) first
          return link1Slope - link2Slope;
        }

        // if only one is circular, the move top links up, or bottom links down
        if (link1.circular && !link2.circular) {
          return link1.circularLinkType == 'top' ? -1 : 1;
        } else if (link2.circular && !link1.circular) {
          return link2.circularLinkType == 'top' ? 1 : -1;
        }

        // if both links are circular...
        if (link1.circular && link2.circular) {
          // Different loop sides: keep TOP above BOTTOM.
          if (link1.circularLinkType !== link2.circularLinkType) {
            return link1.circularLinkType === 'top' ? -1 : 1;
          }

          // Same loop side: enforce consistent ordering.
          // - self-links placement depends on band direction:
          //   - TOP band: for user clarity, self-loops should also sit at the very top (first),
          //     so they don't weave through other top backlinks near the node.
          //   - BOTTOM band assigns ports bottom->top, so self-links go FIRST (closest to node bottom)
          // - shortest span first (inner)
          // - thinner first (inner), thicker last (outer)
          var l1Self = selfLinking(link1, id);
          var l2Self = selfLinking(link2, id);
          if (l1Self !== l2Self) {
            // Self-links first for BOTH top and bottom bands.
            return l1Self ? -1 : 1;
          }

          var d1 = Math.abs(link1.target.column - link1.source.column);
          var d2 = Math.abs(link2.target.column - link2.source.column);
          if (d1 !== d2) {
            // SOURCE-side ordering for circular links:
            // Keep span ASCENDING for BOTH top and bottom bands.
            // This makes local (short-span) loops sit closest to the node consistently and
            // prevents long-span loops from stealing the first slot in the band.
            return d1 - d2;
          }

          // When span ties, always prefer ordering by target vertical position BEFORE thickness.
          //
          // This keeps ports stable and intuitive:
          // - TOP band assigns ports top->bottom => higher targets should take higher ports => targetCY ASC
          // - BOTTOM band assigns ports bottom->top => lower targets should take lower ports => targetCY DESC
          //
          // For BACKLINKS specifically this is critical; but applying it to all circular links
          // avoids cases where `width` overrides a clear vertical ordering.
          var link1TargetCY =
            link1.target && typeof link1.target.y0 === "number" && typeof link1.target.y1 === "number"
              ? (link1.target.y0 + link1.target.y1) / 2
              : 0;
          var link2TargetCY =
            link2.target && typeof link2.target.y0 === "number" && typeof link2.target.y1 === "number"
              ? (link2.target.y0 + link2.target.y1) / 2
              : 0;
          if (Math.abs(link1TargetCY - link2TargetCY) >= 1e-6) {
            if (link1.circularLinkType === "bottom") {
              return link2TargetCY - link1TargetCY; // DESC
            }
            return link1TargetCY - link2TargetCY; // ASC
          }

          var w1 = link1.width || 0;
          var w2 = link2.width || 0;
          if (w1 !== w2) {
            // Within the same span on the same loop side:
            // - TOP: thinner first (inner), thicker last (outer)
            // - BOTTOM: thicker first (keeps thin links from sitting on top and crossing)
            if (link1.circularLinkType === 'bottom') return w2 - w1;
            return w1 - w2;
          }

          return (link1.index || 0) - (link2.index || 0);
        }
      });
    }

    // Assign y0 ports using two explicit bands (no interleaving):
    // - TOP band: all non-bottom links (including top circular + non-circular)
    // - BOTTOM band: bottom circular links
    var topBand0 = [];
    var bottomBand0 = [];
    nodesSourceLinks.forEach(function (link) {
      if (link.circular && link.circularLinkType === "bottom") bottomBand0.push(link);
      else topBand0.push(link);
    });

    var ySourceTop = node.y0;
    topBand0.forEach(function (link) {
      link.y0 = ySourceTop + link.width / 2;
      ySourceTop += link.width;
    });

    var ySourceBottom = node.y1;
    bottomBand0.forEach(function (link) {
      link.y0 = ySourceBottom - link.width / 2;
      ySourceBottom -= link.width + circularPortGap;
    });
  });

  return graph;
}


// sort and set the links' y1 for each node
export function sortTargetLinks(inputGraph, id, typeOrder, typeAccessor) {
  let graph = inputGraph;
  const circularPortGap = arguments.length > 4 && Number.isFinite(arguments[4]) ? Math.max(0, arguments[4]) : 0;

  graph.nodes.forEach(function(node) {
    var nodesTargetLinks = graph.links.filter(function(l) {
      return getNodeID(l.target, id) == getNodeID(node, id);
    });

    var nodesTargetLinksLength = nodesTargetLinks.length;

    if (nodesTargetLinksLength > 1) {
      nodesTargetLinks.sort(function(link1, link2) {
        // if both are not circular, sort by the link's source y position
        if (!link1.circular && !link2.circular) {
          // Get the final source Y for each link
          // For virtual links, use the real source from replacedLinks
          var link1SourceY;
          var link2SourceY;
          
          if (link1.source.virtual && link1.source.replacedLink !== undefined && graph.replacedLinks) {
            var replacedLink1 = graph.replacedLinks.find(function(rl) { return rl.index === link1.source.replacedLink; });
            if (replacedLink1 && replacedLink1.source) {
              var sourceName1 = typeof replacedLink1.source === 'string' ? replacedLink1.source : replacedLink1.source.name;
              var actualSource1 = graph.nodes.find(function(n) { return n.name === sourceName1; });
              link1SourceY = actualSource1 && actualSource1.y0 !== undefined ? 
                (actualSource1.y0 + actualSource1.y1) / 2 : (link1.source.y0 + link1.source.y1) / 2;
            } else {
              link1SourceY = (link1.source.y0 + link1.source.y1) / 2;
            }
          } else {
            link1SourceY = (link1.source.y0 + link1.source.y1) / 2;
          }
          
          if (link2.source.virtual && link2.source.replacedLink !== undefined && graph.replacedLinks) {
            var replacedLink2 = graph.replacedLinks.find(function(rl) { return rl.index === link2.source.replacedLink; });
            if (replacedLink2 && replacedLink2.source) {
              var sourceName2 = typeof replacedLink2.source === 'string' ? replacedLink2.source : replacedLink2.source.name;
              var actualSource2 = graph.nodes.find(function(n) { return n.name === sourceName2; });
              link2SourceY = actualSource2 && actualSource2.y0 !== undefined ? 
                (actualSource2.y0 + actualSource2.y1) / 2 : (link2.source.y0 + link2.source.y1) / 2;
            } else {
              link2SourceY = (link2.source.y0 + link2.source.y1) / 2;
            }
          } else {
            link2SourceY = (link2.source.y0 + link2.source.y1) / 2;
          }
          
          // For incoming links from the SAME column, sort by source Y
          // For incoming links from DIFFERENT columns, use slope to minimize crossings
          var link1SourceCol = link1.source.column;
          var link2SourceCol = link2.source.column;
          
          // Get actual source column for virtual links
          if (link1.source.virtual && link1.source.replacedLink !== undefined && graph.replacedLinks) {
            var rl1 = graph.replacedLinks.find(function(rl) { return rl.index === link1.source.replacedLink; });
            if (rl1 && rl1.source) {
              var sn1 = typeof rl1.source === 'string' ? rl1.source : rl1.source.name;
              var as1 = graph.nodes.find(function(n) { return n.name === sn1; });
              if (as1) link1SourceCol = as1.column;
            }
          }
          if (link2.source.virtual && link2.source.replacedLink !== undefined && graph.replacedLinks) {
            var rl2 = graph.replacedLinks.find(function(rl) { return rl.index === link2.source.replacedLink; });
            if (rl2 && rl2.source) {
              var sn2 = typeof rl2.source === 'string' ? rl2.source : rl2.source.name;
              var as2 = graph.nodes.find(function(n) { return n.name === sn2; });
              if (as2) link2SourceCol = as2.column;
            }
          }
          
          if (link1SourceCol === link2SourceCol) {
            // Same column: sort by source Y position
            return link1SourceY - link2SourceY;
          } else {
            // Different columns: sort by slope
            // Links with smaller slope (more gradual) should enter from top
            var targetY = (link1.target.y0 + link1.target.y1) / 2;
            var targetCol = link1.target.column;
            
            var link1Slope = (link1SourceY - targetY) / (targetCol - link1SourceCol);
            var link2Slope = (link2SourceY - targetY) / (targetCol - link2SourceCol);
            
            return link1Slope - link2Slope;
          }
        }

        // if only one is circular, the move top links up, or bottom links down
        if (link1.circular && !link2.circular) {
          return link1.circularLinkType == 'top' ? -1 : 1;
        } else if (link2.circular && !link1.circular) {
          return link2.circularLinkType == 'top' ? 1 : -1;
        }

        // if both links are circular...
        if (link1.circular && link2.circular) {
          // Different loop sides: keep TOP above BOTTOM.
          if (link1.circularLinkType !== link2.circularLinkType) {
            return link1.circularLinkType === 'top' ? -1 : 1;
          }

          // Same loop side: same ordering policy as in sortSourceLinks.
          var l1Self = selfLinking(link1, id);
          var l2Self = selfLinking(link2, id);
          if (l1Self !== l2Self) {
            // Self-links first for BOTH top and bottom bands.
            return l1Self ? -1 : 1;
          }

          // Ordering inside a band:
          // - TOP: span ASC, then sourceY ASC, then width ASC (thin inner → thick outer).
          // - BOTTOM: span ASC, then (type-dependent) sourceY ordering, then width ASC.
          //
          // Rationale for BOTTOM:
          // bottom ports are assigned from bottom->top, so earlier links end up lower on the node.
          // We use two different mental models depending on link family:
          // - `search_loop` and `search_nearby`: preserve source vertical order at the target (sourceY DESC)
          // - others: inverted mapping used historically in this project (sourceY ASC)
          var d1 = Math.abs(link1.target.column - link1.source.column);
          var d2 = Math.abs(link2.target.column - link2.source.column);
          var s1 = (link1.source.y0 + link1.source.y1) / 2;
          var s2 = (link2.source.y0 + link2.source.y1) / 2;
          var w1 = link1.width || 0;
          var w2 = link2.width || 0;

          if (link1.circularLinkType === "bottom") {
            // When leftFullExtent is available (from a prior addCircularPathData pass),
            // sort by actual x-position of the left vertical segment to avoid crossings
            // at the target entry point. Bottom-band ports are assigned bottom→top
            // (first in array → bottommost). The innermost vertical (largest lfe, closest
            // to node) should get the bottommost port, outermost (smallest lfe) → topmost.
            // This way each vertical only rises to its own port level and horizontal
            // entries don't cross other verticals.
            var lfe1 = link1.circularPathData && link1.circularPathData.leftFullExtent;
            var lfe2 = link2.circularPathData && link2.circularPathData.leftFullExtent;
            if (typeof lfe1 === "number" && typeof lfe2 === "number" && Math.abs(lfe1 - lfe2) >= 1e-6) {
              return lfe2 - lfe1;
            }
            if (d1 !== d2) return d1 - d2;
            if (s1 !== s2) {
              return s2 - s1;
            }
            if (w1 !== w2) return w1 - w2;
          } else {
            if (d1 !== d2) return d1 - d2;
            if (s1 !== s2) return s1 - s2;
            if (w1 !== w2) return w1 - w2;
          }

          return (link1.index || 0) - (link2.index || 0);
        }
      });
    }

    // Assign y1 ports using two explicit bands (no interleaving):
    // - TOP band: all non-bottom links (including top circular + non-circular)
    // - BOTTOM band: bottom circular links
    var topBand1 = [];
    var bottomBand1 = [];
    nodesTargetLinks.forEach(function (link) {
      if (link.circular && link.circularLinkType === "bottom") bottomBand1.push(link);
      else topBand1.push(link);
    });

    var yTargetTop = node.y0;
    topBand1.forEach(function (link) {
      link.y1 = yTargetTop + link.width / 2;
      yTargetTop += link.width;
    });

    var yTargetBottom = node.y1;
    bottomBand1.forEach(function (link) {
      link.y1 = yTargetBottom - link.width / 2;
      yTargetBottom -= link.width + circularPortGap;
    });
  });

  return graph;
}

export function sortLinks(inputGraph) {
  let g = inputGraph;

  for (var iteration = 0; iteration < linkSortingIterations; iteration++) {
    g = sortSourceLinks(g);
    g = sortTargetLinks(g);
  }

  return g;
}


// test if links both slope up, or both slope down
function sameInclines(link1, link2) {
  return incline(link1) == incline(link2);
}

// returns the slope of a link, from source to target
// up => slopes up from source to target
// down => slopes down from source to target
function incline(link) {
  return link.y0 - link.y1 > 0 ? 'up' : 'down';
}