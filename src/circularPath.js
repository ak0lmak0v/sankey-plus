import {min, linkHorizontal} from "d3";

import { selfLinking, onlyCircularLink } from "./linkAttributes.js";

import {
  sortLinkSourceYAscending,
  sortLinkSourceYDescending,
  sortLinkTargetYAscending,
  sortLinkTargetYDescending,
  sortLinkColumnAscending,
} from "./sortGraph.js";

export function addCircularPathData(
  inputGraph,
  id,
  circularLinkGap,
  baseRadius,
  verticalMargin
) {
  let graph = inputGraph;

  var buffer = 5;

  var minY = min(graph.links, function (link) {
    return link.source.y0;
  });

  // create object for circular Path Data
  graph.links.forEach(function (link) {
    if (link.circular) {
      link.circularPathData = {};
    }
  });

  // calc vertical offsets per top/bottom links
  var topLinks = graph.links.filter(function (l) {
    return l.circularLinkType == "top";
  });

  calcVerticalBuffer(topLinks, graph.nodes, id, circularLinkGap, graph, verticalMargin);

  var bottomLinks = graph.links.filter(function (l) {
    return l.circularLinkType == "bottom";
  });

  calcVerticalBuffer(bottomLinks, graph.nodes, id, circularLinkGap, graph, verticalMargin);

  // Precompute which nodes have a BOTTOM self-loop.
  // We use this to keep links entering such nodes more compact (avoid large, unnecessary baseOffset gaps).
  var bottomSelfLoopNodeIds = new Set();
  graph.links.forEach(function(l) {
    if (!l || !l.circular) return;
    if (l.circularLinkType !== "bottom") return;
    if (!selfLinking(l, id)) return;
    try {
      bottomSelfLoopNodeIds.add(String(id(l.source)));
    } catch (e) {
      // ignore
    }
  });

  // add the base data for each link (radii/extents only; we assign `link.path` after post-passes)
  graph.links.forEach(function (link) {
    if (link.circular) {
      link.circularPathData.arcRadius = link.width + baseRadius;
      link.circularPathData.rightNodeBuffer = buffer;
      link.circularPathData.leftNodeBuffer = buffer;
      link.circularPathData.sourceWidth = link.source.x1 - link.source.x0;
      link.circularPathData.sourceX =
        link.source.x0 + link.circularPathData.sourceWidth;
      link.circularPathData.targetX = link.target.x0;
      link.circularPathData.sourceY = link.y0;
      link.circularPathData.targetY = link.y1;

      // for self linking paths - always use compact layout close to the node
      if (selfLinking(link, id)) {
        var selfLinkRadius = baseRadius + link.width / 2;
        link.circularPathData.rightSmallArcRadius = selfLinkRadius;
        link.circularPathData.rightLargeArcRadius = selfLinkRadius;
        link.circularPathData.leftSmallArcRadius = selfLinkRadius;
        link.circularPathData.leftLargeArcRadius = selfLinkRadius;

        // Margin for self-links: keep them compact and close to the node, but enforce a minimum
        // so the loop doesn't collapse into the node stroke.
        // NOTE: "closer to node" means smaller verticalFullExtent for bottom loops (and larger for top loops).
        var minSelfLoopMargin = Math.max(12, selfLinkRadius + 4);
        var selfLoopMarginFactor = 1.2;
        var selfLinkMargin = Math.max(
          minSelfLoopMargin,
          selfLinkRadius * selfLoopMarginFactor + link.width * 0.2
        );
        // For self-loops we intentionally do NOT inflate vBuf here; vBuf is used for stacking.
        // We want self-loops to stay "inner" and push others instead.
        var vBuf = link.circularPathData.verticalBuffer || 0;
        
        // IMPORTANT: keep self-loops compact by NOT applying the generic `baseOffset`
        // that we use for other circular links. Self-loops are handled by:
        // - their own small `selfLinkMargin`, and
        // - `verticalBuffer` stacking, plus
        // - the global bottom-band minimum-gap pass later in this function.
        // Setting baseOffset to 0 makes them smaller and avoids "too tall" self-loops.
        var extMinY = link.source.y0;
        var extMaxY = link.source.y1;
        link.circularPathData.baseOffset = 0;

        if (link.circularLinkType == "bottom") {
          link.circularPathData.verticalFullExtent =
            extMaxY + selfLinkMargin + vBuf;
          link.circularPathData.verticalRightInnerExtent =
            link.circularPathData.verticalFullExtent - selfLinkRadius;
          link.circularPathData.verticalLeftInnerExtent =
            link.circularPathData.verticalFullExtent - selfLinkRadius;
        } else {
          // top links
          link.circularPathData.verticalFullExtent =
            extMinY - selfLinkMargin - vBuf;
          link.circularPathData.verticalRightInnerExtent =
            link.circularPathData.verticalFullExtent + selfLinkRadius;
          link.circularPathData.verticalLeftInnerExtent =
            link.circularPathData.verticalFullExtent + selfLinkRadius;
        }
      } else {
        // else calculate normally
        // add right extent coordinates, based on links with same source column and circularLink type
        // (column-level grouping is needed to avoid vertical-leg overlaps for different nodes in same column)
        var thisColumn = link.source.column;
        var thisCircularLinkType = link.circularLinkType;
        var sameColumnLinks = graph.links.filter(function (l) {
          return (
            l.circular &&
            l.source.column == thisColumn &&
            l.circularLinkType == thisCircularLinkType
          );
        });

        // SOURCE-side (right) radii ordering for a whole SOURCE COLUMN.
        //
        // Goal: outgoing backlinks that go to the same target (or target column) should be
        // adjacent ("grouped") and ordered by how close the target is:
        // - span ASC (closest target column first),
        // - within the same target column: target.y0 ASC (for TOP links: lower target => later => more-right exit),
        // - then target height ASC, then source.y0 ASC as a stable tie-break.
        sameColumnLinks.sort(function(a, b) {
          // 1) Span (distance in columns): closer first
          var ad = Math.abs((a.source.column || 0) - (a.target.column || 0));
          var bd = Math.abs((b.source.column || 0) - (b.target.column || 0));
          if (ad !== bd) return ad - bd;

          // Special case: same-column circulars (span=0) are extremely local. Prefer thinner links more inner
          // so we don't push small cycles outward unnecessarily (e.g. listing ○→filter should not end up
          // outside the listing ○ self-loop just because another thicker span=0 link exists in the column).
          if (ad === 0) {
            var aw = a.width || 0;
            var bw = b.width || 0;
            if (aw !== bw) return aw - bw;
          }

          // 2) Group by target node position (keeps links to same target region together).
          // Special case: bottom *backlinks* should route local (lower) targets closer to the node
          // and push upper targets farther (outer radius) to avoid near-node braiding.
          var aTgtY0 = a.target && typeof a.target.y0 === "number" ? a.target.y0 : 0;
          var bTgtY0 = b.target && typeof b.target.y0 === "number" ? b.target.y0 : 0;
          var aIsBottomBacklink =
            a.circularLinkType === "bottom" && (a.target.column || 0) < (a.source.column || 0);
          var bIsBottomBacklink =
            b.circularLinkType === "bottom" && (b.target.column || 0) < (b.source.column || 0);
          // NOTE: For BOTTOM circular links we generally want "lower target => more inner" ordering,
          // because those links share the bottom shelf and should exit the column in a consistent stack.
          // The original rule applied only to "backlinks", but in practice we also want it for bottom
          // forward cycles within the same column to avoid cases where a higher target exits earlier.
          if (
            a.circularLinkType === "bottom" &&
            b.circularLinkType === "bottom" &&
            Math.abs(aTgtY0 - bTgtY0) >= 1e-6
          ) {
            // Descending y0: lower targets first (inner), upper targets last (outer).
            return bTgtY0 - aTgtY0;
          }
          if (aIsBottomBacklink && bIsBottomBacklink) {
            // Descending y0: lower targets first (inner), upper targets last (outer).
            if (Math.abs(aTgtY0 - bTgtY0) >= 1e-6) return bTgtY0 - aTgtY0;
          } else {
            if (Math.abs(aTgtY0 - bTgtY0) >= 1e-6) return aTgtY0 - bTgtY0;
          }

          var aTgtH =
            a.target && typeof a.target.y1 === "number" && typeof a.target.y0 === "number"
              ? a.target.y1 - a.target.y0
              : 0;
          var bTgtH =
            b.target && typeof b.target.y1 === "number" && typeof b.target.y0 === "number"
              ? b.target.y1 - b.target.y0
              : 0;
          if (aTgtH !== bTgtH) return aTgtH - bTgtH;

          // 3) Stable-ish: keep exits aligned with source port ordering.
          // TOP band assigns ports top->bottom => higher sources first (ASC).
          // BOTTOM band assigns ports bottom->top => lower sources first (DESC).
          var aSrcY0 = a.source && typeof a.source.y0 === "number" ? a.source.y0 : 0;
          var bSrcY0 = b.source && typeof b.source.y0 === "number" ? b.source.y0 : 0;
          if (Math.abs(aSrcY0 - bSrcY0) >= 1e-6) {
            return (a.circularLinkType === "bottom") ? (bSrcY0 - aSrcY0) : (aSrcY0 - bSrcY0);
          }

          // 4) Preserve nesting vs stacking order when everything else ties
          var av = a.circularPathData ? a.circularPathData.verticalBuffer : 0;
          var bv = b.circularPathData ? b.circularPathData.verticalBuffer : 0;
          if (av !== bv) return av - bv;

          return (a.circularLinkID || 0) - (b.circularLinkID || 0);
        });

        // SOURCE-side (right) lane assignment:
        //
        // We need a stable left-to-right ordering for all circular links in a source column (per band),
        // even if their right-leg segments don't overlap in Y, because their long top/bottom arcs can still
        // intersect later in the diagram.
        //
        // However, the old algorithm over-spaced because it summed FULL widths and then also added `i*circularGap`,
        // effectively double-counting stroke widths for neighbors.
        //
        // New rule: between adjacent "lanes", centerlines should be separated by:
        //   (prevWidth/2 + currWidth/2) + circularGap
        // i.e. we accumulate half-widths + gap, then add the current half-width.
        var radiusOffset = 0;
        sameColumnLinks.forEach(function (l) {
          if (l.circularLinkID == link.circularLinkID) {
            var r = baseRadius + link.width / 2 + radiusOffset;
            link.circularPathData.rightSmallArcRadius = r;
            link.circularPathData.rightLargeArcRadius = r;
          }
          radiusOffset = radiusOffset + (l.width || 0) / 2 + circularLinkGap;
        });

        // add left extent coordinates.
        //
        // IMPORTANT: for backlinks (target is left of source), we must group by the *target node*,
        // not just the target column. Otherwise, radii spacing gets \"shared\" across different nodes
        // in the same column and can shrink enough that multiple thick links end up with near-identical
        // left vertical-leg X positions => visible overlap at node entry.
        thisColumn = link.target.column;
        var linkIsSelfLoop = selfLinking(link, id);
        sameColumnLinks = graph.links.filter(function (l) {
          if (!(l && l.circular && l.circularLinkType == thisCircularLinkType)) return false;
          // Always group by target node identity on the LEFT side.
          //
          // Rationale:
          // - Grouping by target column shares cumulative-width spacing across different nodes in the same
          //   column, which can create large, unintuitive left-leg offsets between unrelated links (e.g.
          //   same-column cycles like filter↔listing ○).
          // - Any *actual* horizontal collisions between different target nodes are still handled by the
          //   left-leg clearance post-pass (which checks vertical overlap and enforces `circularLinkGap`).
          //
          // Do NOT group by `type`: users may change types; geometry must remain stable.
          //
          // IMPORTANT: self-loops should NOT consume left-side radius budget for other links.
          // Otherwise, a large self-loop on the target node can shift unrelated incoming circular
          // links far to the left even if we don't actually need self-loop clearance.
          if (!linkIsSelfLoop && selfLinking(l, id)) return false;
          return id(l.target) === id(link.target);
        });
        // Target side radii: cluster by TARGET node first to avoid horizontal alternating,
        // then use span/vBuf for consistent nesting.
        sameColumnLinks.sort(function(a, b) {
          var aTgtY0 = a.target && typeof a.target.y0 === "number" ? a.target.y0 : 0;
          var bTgtY0 = b.target && typeof b.target.y0 === "number" ? b.target.y0 : 0;
          var aIsBottomBacklink =
            a.circularLinkType === "bottom" && (a.target.column || 0) < (a.source.column || 0);
          var bIsBottomBacklink =
            b.circularLinkType === "bottom" && (b.target.column || 0) < (b.source.column || 0);
          if (aIsBottomBacklink && bIsBottomBacklink) {
            // Descending y0: lower targets first (inner), upper targets last (outer).
            if (Math.abs(aTgtY0 - bTgtY0) >= 1e-6) return bTgtY0 - aTgtY0;
          } else {
            if (Math.abs(aTgtY0 - bTgtY0) >= 1e-6) return aTgtY0 - bTgtY0;
          }

          var aTgtH =
            a.target && typeof a.target.y1 === "number" && typeof a.target.y0 === "number"
              ? a.target.y1 - a.target.y0
              : 0;
          var bTgtH =
            b.target && typeof b.target.y1 === "number" && typeof b.target.y0 === "number"
              ? b.target.y1 - b.target.y0
              : 0;
          if (aTgtH !== bTgtH) return aTgtH - bTgtH;

          // For backlinks into the SAME target node, the \"3rd turn\" horizontal order at node entry
          // should follow the same principles as port sorting:
          // 1) primary key: span (distance from source column) — farther sources are more outer (further left)
          // 2) if span ties (=> same source column), lower source nodes should be more inner (more right)
          //    than higher source nodes.
          var sameTargetNode = (a.target === b.target);
          var ad = Math.abs((a.source.column || 0) - (a.target.column || 0));
          var bd = Math.abs((b.source.column || 0) - (b.target.column || 0));
          if (aIsBottomBacklink && bIsBottomBacklink && sameTargetNode) {
            if (ad !== bd) return ad - bd; // nearer (smaller span) first => more inner (right)
            // span tie => same source column: lower source should be more inner (right) => earlier in radius list
            var aSrcY = (a.source.y0 + a.source.y1) / 2;
            var bSrcY = (b.source.y0 + b.source.y1) / 2;
            if (Math.abs(aSrcY - bSrcY) >= 1e-6) return bSrcY - aSrcY; // lower first
          } else {
            if (ad !== bd) return ad - bd;
          }

          var av = a.circularPathData ? a.circularPathData.verticalBuffer : 0;
          var bv = b.circularPathData ? b.circularPathData.verticalBuffer : 0;
          if (av !== bv) return av - bv;

          return (a.circularLinkID || 0) - (b.circularLinkID || 0);
        });

        var radiusOffset = 0;
        sameColumnLinks.forEach(function (l, i) {
          if (l.circularLinkID == link.circularLinkID) {
            // Use cumulative-width spacing so adjacent links have enough separation for their stroke widths.
            // For the left side we keep small==large to create a clean, non-bulging bundle near the target.
            var r = baseRadius + link.width / 2 + radiusOffset;
            link.circularPathData.leftSmallArcRadius = r;
            link.circularPathData.leftLargeArcRadius = r;
          }
          // Add explicit gap as well; without this, very thin links can end up too close to thicker ones,
          // causing visible overlap at node entry.
          // Apply `circularLinkGap` exactly once between neighbors. Extra gap caused a \"double spacing\" look.
          radiusOffset = radiusOffset + l.width + circularLinkGap;
        });

        // Baseline extents (where the link "escapes" from).
        //
        // Key tradeoff:
        // - Some *local* circular links (especially BOTTOM span<=1) must stay compact and should NOT inherit
        //   the baseline of long links in the same target column (that creates huge depth).
        // - But for TOP bundles, using per-link baselines for span<=1 can make a link "drift" out of its
        //   target-column bundle (different baselineMinY => different VFE), i.e. it looks \"out of group\".
        //
        // Rule:
        // - same-column circulars: always per-link baseline (very local geometry).
        // - span<=1:
        //   - bottom band: per-link baseline (compactness is critical).
        //   - top band: group baseline (bundle coherence), except for `search_nearby` which we keep compact.
        // - span>1: group baseline when available.
        var sameColumnCircular = link.source && link.target && link.source.column === link.target.column;
        var span = Math.abs((link.source.column || 0) - (link.target.column || 0));
        var preferPerLinkBaseline =
          sameColumnCircular ||
          (span <= 1 &&
            (link.circularLinkType === "bottom" ||
              (link.circularLinkType === "top" && link.type === "search_nearby")));

        var baselineMinY;
        var baselineMaxY;

        if (!preferPerLinkBaseline && link.circularPathData) {
          if (typeof link.circularPathData.groupMinY === "number") baselineMinY = link.circularPathData.groupMinY;
          if (typeof link.circularPathData.groupMaxY === "number") baselineMaxY = link.circularPathData.groupMaxY;
        }
        if (preferPerLinkBaseline && link.circularPathData) {
          if (typeof link.circularPathData._extMinY === "number") baselineMinY = link.circularPathData._extMinY;
          if (typeof link.circularPathData._extMaxY === "number") baselineMaxY = link.circularPathData._extMaxY;
        }
        // Final fallback
        if (typeof baselineMinY !== "number") baselineMinY = Math.min(link.source.y0, link.target.y0);
        if (typeof baselineMaxY !== "number") baselineMaxY = Math.max(link.source.y1, link.target.y1);

        // Sizing extents (for baseOffset sizing only): we can use group extents to keep
        // bundle sizing coherent, but we must NOT use them as baseline.
        var sizingMinY = baselineMinY;
        var sizingMaxY = baselineMaxY;
        if (
          link.circularPathData &&
          link.circularPathData.groupSize > 1 &&
          typeof link.circularPathData.groupMinY === "number" &&
          typeof link.circularPathData.groupMaxY === "number"
        ) {
          sizingMinY = link.circularPathData.groupMinY;
          sizingMaxY = link.circularPathData.groupMaxY;
        }

        // Base offset controls how far the circular link "escapes" above/below the main diagram.
        // Use an adaptive value, but cap it tightly to avoid excessive vertical gaps.
        // Make baseOffset span-dependent: short links stay closer to nodes.
        var columnHeight = sizingMaxY - sizingMinY;
        var linkSpan = Math.abs((link.source.column || 0) - (link.target.column || 0));
        // For short-span links (≤2 columns), use smaller baseOffset to keep them compact.
        // For longer backlinks, allow more vertical escape to avoid crossing horizontal flow.
        // For TOP links, make baseOffset much less dependent on span so that "bundle grouping by target"
        // dominates over span-based escape. Otherwise a longer-span link into a *lower* target (e.g. `filter`)
        // can rise above the bundle into a *higher* target (e.g. `saved_filters_search`), visually breaking it.
        var spanFactor =
          (link.circularLinkType === "top")
            ? 0.045
            : (linkSpan <= 1 ? 0.04 : (linkSpan === 2 ? 0.06 : 0.08));
        // Minimum "escape" from the diagram.
        // For BOTTOM links entering a node that already has a bottom self-loop, keep this much smaller
        // so the incoming loop bundle sits close to the self-loop (reduces persistent gaps).
        var minEscape = verticalMargin + link.width + 2;
        if (link.circularLinkType === "bottom" && link.target) {
          var tgtKey = null;
          try { tgtKey = String(id(link.target)); } catch (e) { tgtKey = null; }
          if (tgtKey && bottomSelfLoopNodeIds.has(tgtKey)) {
            // Use a much smaller minimum for span<=1; otherwise thick local loops (e.g. `search ◐→search ○`)
            // get pinned at verticalMargin and create an obvious gap above the self-loop.
            if (linkSpan <= 1) {
              // small, radius-ish heuristic without needing baseRadius in this scope
              minEscape = Math.max(10, link.width / 2 + 6);
              // Also reduce spanFactor so columnHeight doesn't force a large escape for local links.
              spanFactor = Math.min(spanFactor, 0.03);
            } else {
              minEscape = Math.max(10, link.width + 6);
            }
          }
        }
        var desiredBaseOffset = Math.max(minEscape, columnHeight * spanFactor);
        
        // Tight cap (~3% of diagram height for short, ~4.5% for long) to keep arcs close to nodes.
        var capFactor = linkSpan <= 2 ? 0.03 : 0.045;
        var maxAllowedBaseOffset = Math.max(verticalMargin, (graph.y1 - graph.y0) * capFactor);
        var isBacklink = (link.source.column || 0) > (link.target.column || 0);
        // Small-span TOP backlinks can be overly clamped, making them sit too low and intersect other TOP arcs.
        // Allow a tiny extra escape, but never exceed the "long-link" cap.
        if (isBacklink && link.circularLinkType === "top" && linkSpan <= 2) {
          var longCap = Math.max(verticalMargin, (graph.y1 - graph.y0) * 0.045);
          maxAllowedBaseOffset = Math.min(maxAllowedBaseOffset + 4, longCap);
        }
        var baseOffset = Math.min(desiredBaseOffset, maxAllowedBaseOffset);
        // TOP links: prefer arcs into higher targets to be slightly more "outer" (escape higher),
        // so their bundles sit above arcs into lower targets. Keep this tweak small & capped to
        // avoid spreading right arcs across the whole graph.
        if (
          link.circularLinkType === "top" &&
          link.target &&
          typeof link.target.y0 === "number" &&
          typeof link.target.y1 === "number" &&
          typeof graph.y0 === "number" &&
          typeof graph.y1 === "number"
        ) {
          var tCY = (link.target.y0 + link.target.y1) / 2;
          var h = (graph.y1 - graph.y0) || 1;
          // higher target => larger norm => slightly bigger baseOffset
          var norm = (graph.y1 - tCY) / h;
          var extraTop = Math.max(0, Math.min(4, 4 * norm));
          baseOffset = Math.min(baseOffset + extraTop, maxAllowedBaseOffset);
        }
        link.circularPathData.baseOffset = baseOffset;
        // IMPORTANT: do NOT force all links in a bundle to share the same verticalBuffer.
        // That makes them collapse onto one horizontal line (same verticalFullExtent).
        // Group alignment should be handled via groupMinY/groupMaxY (baseOffset sizing),
        // while per-link verticalBuffer preserves stacking.
        var totalOffset = baseOffset + link.circularPathData.verticalBuffer;

        // bottom links
        if (link.circularLinkType == "bottom") {
          link.circularPathData.verticalFullExtent =
            baselineMaxY + totalOffset;
          link.circularPathData.verticalRightInnerExtent =
            link.circularPathData.verticalFullExtent -
            link.circularPathData.rightLargeArcRadius;
          link.circularPathData.verticalLeftInnerExtent =
            link.circularPathData.verticalFullExtent -
            link.circularPathData.leftLargeArcRadius;
        } else {
          // top links
          link.circularPathData.verticalFullExtent =
            baselineMinY - totalOffset;
          link.circularPathData.verticalRightInnerExtent =
            link.circularPathData.verticalFullExtent +
            link.circularPathData.rightLargeArcRadius;
          link.circularPathData.verticalLeftInnerExtent =
            link.circularPathData.verticalFullExtent +
            link.circularPathData.leftLargeArcRadius;
        }

        if (link._debugCircular) {
          console.log("[circular/extents]", (link.source && link.source.name) + "->" + (link.target && link.target.name) + " (#" + link.index + ")", {
            type: link.circularLinkType,
            span: Math.abs((link.source.column || 0) - (link.target.column || 0)),
            width: link.width,
            baselineMinY: baselineMinY,
            baselineMaxY: baselineMaxY,
            sizingMinY: sizingMinY,
            sizingMaxY: sizingMaxY,
            groupMinY: link.circularPathData.groupMinY,
            groupMaxY: link.circularPathData.groupMaxY,
            columnHeight: columnHeight,
            desiredBaseOffset: desiredBaseOffset,
            maxAllowedBaseOffset: maxAllowedBaseOffset,
            baseOffset: baseOffset,
            vBuf: link.circularPathData.verticalBuffer,
            totalOffset: totalOffset,
            verticalFullExtent: link.circularPathData.verticalFullExtent
          });
        }
      }

      // all links
      link.circularPathData.rightInnerExtent =
        link.circularPathData.sourceX + link.circularPathData.rightNodeBuffer;
      link.circularPathData.leftInnerExtent =
        link.circularPathData.targetX - link.circularPathData.leftNodeBuffer;
      link.circularPathData.rightFullExtent =
        link.circularPathData.sourceX +
        link.circularPathData.rightLargeArcRadius +
        link.circularPathData.rightNodeBuffer;
      link.circularPathData.leftFullExtent =
        link.circularPathData.targetX -
        link.circularPathData.leftLargeArcRadius -
        link.circularPathData.leftNodeBuffer;
    }
  });

  // Post-pass: compress overly-large RIGHT-side radii for TOP circular links, per source column.
  //
  // Why: per-column radii spacing is what prevents right vertical legs from overlapping.
  // A hard clamp to leftLargeArcRadius can collapse those radii (causing overlaps), while
  // no clamp can produce ballooned radii (A91...). So we keep per-column spacing but, if
  // the whole group becomes too large, scale the radii down proportionally.
  var rightTopGroups = {};
  graph.links.forEach(function(l) {
    if (!l.circular || l.circularLinkType !== "top") return;
    if (selfLinking(l, id)) return;
    if (!l.source || typeof l.source.column !== "number") return;
    if (!l.circularPathData || typeof l.circularPathData.rightLargeArcRadius !== "number") return;
    var key = String(l.source.column);
    if (!rightTopGroups[key]) rightTopGroups[key] = [];
    rightTopGroups[key].push(l);
  });

  var diagramWidth = graph.x1 - graph.x0;
  var maxAllowedRightRadius = Math.max(baseRadius + 30, diagramWidth * 0.05);

  Object.keys(rightTopGroups).forEach(function(key) {
    var group = rightTopGroups[key];
    var maxR = 0;
    group.forEach(function(l) {
      var r = l.circularPathData.rightLargeArcRadius;
      if (r > maxR) maxR = r;
    });
    if (maxR <= maxAllowedRightRadius) return;

    var denom = (maxR - baseRadius);
    if (denom <= 1e-6) return;
    var factor = (maxAllowedRightRadius - baseRadius) / denom;
    // Don't over-compress; keep more spacing to avoid overlap after compression.
    // Too-aggressive compression (0.5) can violate clearance between thick+thin pairs.
    factor = Math.max(0.7, Math.min(1, factor));

    group.forEach(function(l) {
      var c = l.circularPathData;
      if (typeof c.rightLargeArcRadius === "number") {
        c.rightLargeArcRadius = baseRadius + (c.rightLargeArcRadius - baseRadius) * factor;
      }
      if (typeof c.rightSmallArcRadius === "number") {
        c.rightSmallArcRadius = baseRadius + (c.rightSmallArcRadius - baseRadius) * factor;
      }
      if (
        typeof c.rightLargeArcRadius === "number" &&
        typeof c.rightSmallArcRadius === "number" &&
        c.rightSmallArcRadius > c.rightLargeArcRadius
      ) {
        c.rightSmallArcRadius = c.rightLargeArcRadius;
      }
      // Keep extents consistent after radius scaling (clearance pass sorts by rightFullExtent).
      c.rightFullExtent =
        (c.sourceX || 0) + (c.rightLargeArcRadius || 0) + (c.rightNodeBuffer || 0);
    });
  });

  // Pre-pass: ensure self-loops do not overlap other circular links on the RIGHT vertical leg.
  //
  // This is a *narrow* cross-band rule (TOP vs BOTTOM), needed because different-band links can still
  // share the same right-leg X in the same source column and visually merge.
  //
  // Scope:
  // - group by source column
  // - only when there is a self-loop in that column
  // - only when the right-leg segments overlap in Y (use circularPathData sourceY/verticalRightInnerExtent)
  // - never inflate the self-loop; instead push the non-self link to the RIGHT of the loop
  var selfLoopsBySourceCol = {};
  graph.links.forEach(function(l) {
    if (!l || !l.circular || l.isVirtual) return;
    if (!selfLinking(l, id)) return;
    if (!l.circularPathData || typeof l.circularPathData.rightLargeArcRadius !== "number") return;
    var col = l.source && typeof l.source.column === "number" ? String(l.source.column) : null;
    if (!col) return;
    if (!selfLoopsBySourceCol[col]) selfLoopsBySourceCol[col] = [];
    selfLoopsBySourceCol[col].push(l);
  });

  function _rightLegSeg(link) {
    var c = link.circularPathData;
    var a = c.sourceY;
    var b = c.verticalRightInnerExtent;
    return [Math.min(a, b), Math.max(a, b)];
  }

  Object.keys(selfLoopsBySourceCol).forEach(function(col) {
    var loops = selfLoopsBySourceCol[col];
    if (!loops || !loops.length) return;
    // All circular links in this source column (both top + bottom).
    var group = graph.links.filter(function(l) {
      if (!l || !l.circular || l.isVirtual) return false;
      if (!l.circularPathData || typeof l.circularPathData.rightLargeArcRadius !== "number") return false;
      var ccol = l.source && typeof l.source.column === "number" ? String(l.source.column) : null;
      return ccol === col && !selfLinking(l, id);
    });
    if (!group.length) return;

    var maxIters = 10;
    for (var it = 0; it < maxIters; it++) {
      var changed = false;
      for (var li = 0; li < loops.length; li++) {
        var loop = loops[li];
        if (!loop || !loop.circularPathData) continue;
        var loopSeg = _rightLegSeg(loop);
        var loopW = loop.width || 0;
        var loopSrcId = loop.source ? id(loop.source) : null;

        for (var gi = 0; gi < group.length; gi++) {
          var other = group[gi];
          if (!other || !other.circularPathData) continue;
          // Only handle cross-NODE overlaps (same column, different source node).
          // Same-source-node interactions are already handled by within-band right leg clearance and
          // port ordering; pushing them here causes unnecessary blow-outs (e.g. search ◐→search ○).
          if (loopSrcId && other.source && id(other.source) === loopSrcId) continue;

          var otherSeg = _rightLegSeg(other);
          var vOv = Math.max(0, Math.min(loopSeg[1], otherSeg[1]) - Math.max(loopSeg[0], otherSeg[0]));
          if (vOv <= 1e-6) continue;

          // Ensure OTHER is to the right of LOOP by >= circularGap.
          // NOTE: current is edge-to-edge already (we subtract +/- width/2), so don't add widths again.
          var otherW = other.width || 0;
          var required = circularLinkGap || 0;
          var current =
            (other.circularPathData.rightFullExtent - otherW / 2) -
            (loop.circularPathData.rightFullExtent + loopW / 2);
          if (current < required) {
            var delta = (required - current) + 1e-6;
            other.circularPathData.rightLargeArcRadius += delta;
            if (typeof other.circularPathData.rightSmallArcRadius === "number") {
              other.circularPathData.rightSmallArcRadius += delta;
              if (other.circularPathData.rightSmallArcRadius > other.circularPathData.rightLargeArcRadius) {
                other.circularPathData.rightSmallArcRadius = other.circularPathData.rightLargeArcRadius;
              }
            }
            other.circularPathData.rightFullExtent =
              other.circularPathData.sourceX +
              other.circularPathData.rightLargeArcRadius +
              (other.circularPathData.rightNodeBuffer || 0);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
  });

  // Post-pass: enforce minimum clearance between RIGHT vertical legs (same source column + same top/bottom band).
  //
  // Right leg clearance: ensure minimum horizontal gap between circular links
  // from the same source column that have overlapping vertical ranges.
  var rightGroups = {};
  graph.links.forEach(function(l) {
    if (!l.circular) return;
    if (!l.circularPathData) return;
    if (typeof l.circularPathData.rightLargeArcRadius !== "number") return;
    var sourceKey =
      l.source && typeof l.source.column === "number"
        ? String(l.source.column)
        : String(Math.round((l.circularPathData.sourceX || 0) * 10) / 10);
    var key = sourceKey + "|" + String(l.circularLinkType);
    if (!rightGroups[key]) rightGroups[key] = [];
    rightGroups[key].push(l);
  });

  Object.keys(rightGroups).forEach(function(k) {
    var group = rightGroups[k];
    if (group.length < 2) return;
    
    // Freeze a stable inner->outer order before we start pushing radii.
    // This prevents a pushed link from reordering and causing cascade dispersion.
    group.forEach(function(l) {
      var c = l.circularPathData;
      if (!c) return;
      if (typeof c._rightFullExtentBase !== "number") c._rightFullExtentBase = c.rightFullExtent;
    });

    var maxRightIters = 20;
    for (var rightIt = 0; rightIt < maxRightIters; rightIt++) {
      var rightChanged = false;
      // Sort by rightFullExtent: inner first (smaller rfe)
      group.sort(function(a, b) {
        var ab = a.circularPathData._rightFullExtentBase;
        var bb = b.circularPathData._rightFullExtentBase;
        if (ab !== bb) return ab - bb;
        // If bases tie (common after pre-passes), prefer the port-ordering principle:
        // smaller span should be more inner than larger span.
        var ad = Math.abs((a.source && a.source.column || 0) - (a.target && a.target.column || 0));
        var bd = Math.abs((b.source && b.source.column || 0) - (b.target && b.target.column || 0));
        if (ad !== bd) return ad - bd;
        // Current rfe as last-resort tie-break (keeps determinism if everything ties)
        var ar = a.circularPathData.rightFullExtent;
        var br = b.circularPathData.rightFullExtent;
        if (ar !== br) return ar - br;
        return (a.circularLinkID || 0) - (b.circularLinkID || 0);
      });

      for (var i = 1; i < group.length; i++) {
        var prev = group[i - 1]; // inner (smaller rfe)
        var curr = group[i];     // outer (larger rfe)
        
        // Check vertical overlap on right leg.
        // IMPORTANT: use the actual source port position (link.y0), not node y0/y1.
        // Using node coords makes the overlap test too broad / too narrow depending on node height,
        // and can miss real overlaps with self-loops and same-column circulars.
        //
        // For TOP: Y range is [vfe, link.y0]
        // For BOTTOM: Y range is [link.y0, vfe]
        var prevYMin, prevYMax, currYMin, currYMax;
        if (prev.circularLinkType === 'top') {
          prevYMin = prev.circularPathData.verticalFullExtent;
          prevYMax = (typeof prev.y0 === "number") ? prev.y0 : prev.source.y0;
        } else {
          prevYMin = (typeof prev.y0 === "number") ? prev.y0 : prev.source.y1;
          prevYMax = prev.circularPathData.verticalFullExtent;
        }
        if (curr.circularLinkType === 'top') {
          currYMin = curr.circularPathData.verticalFullExtent;
          currYMax = (typeof curr.y0 === "number") ? curr.y0 : curr.source.y0;
        } else {
          currYMin = (typeof curr.y0 === "number") ? curr.y0 : curr.source.y1;
          currYMax = curr.circularPathData.verticalFullExtent;
        }
        
        var verticalOverlap = Math.max(0, Math.min(prevYMax, currYMax) - Math.max(prevYMin, currYMin));
        if (verticalOverlap <= 1e-6) continue; // No vertical overlap, no need for clearance
        
        var prevW = prev.width || 0;
        var currW = curr.width || 0;
        var prevRight = prev.circularPathData.rightFullExtent + prevW / 2;
        var currLeft = curr.circularPathData.rightFullExtent - currW / 2;
        var gap = currLeft - prevRight;
        var required = circularLinkGap || 0;
        
        if (gap < required) {
          var delta = required - gap + 1e-6;
          // Push curr outward (increase rfe)
          curr.circularPathData.rightLargeArcRadius += delta;
          if (typeof curr.circularPathData.rightSmallArcRadius === "number") {
            curr.circularPathData.rightSmallArcRadius += delta;
            if (curr.circularPathData.rightSmallArcRadius > curr.circularPathData.rightLargeArcRadius) {
              curr.circularPathData.rightSmallArcRadius = curr.circularPathData.rightLargeArcRadius;
            }
          }
          curr.circularPathData.rightFullExtent =
            curr.circularPathData.sourceX +
            curr.circularPathData.rightLargeArcRadius +
            (curr.circularPathData.rightNodeBuffer || 0);
          rightChanged = true;
        }
      }
      if (!rightChanged) break;
    }
  });

  // Post-pass: enforce minimum clearance between RIGHT vertical legs across TOP/BOTTOM bands
  // within the same source column, when their right-leg Y ranges overlap.
  //
  // Why:
  // - TOP vs BOTTOM links can still share the same physical right-leg region in a column.
  // - We want them to separate by ~circularGap when they overlap in Y, but NOT accumulate
  //   extra "radiusOffset" spacing just because they're in the same column.
  //
  // Scope:
  // - group by source column
  // - exclude self-loops (handled by dedicated self-loop clearance)
  // - exclude same-source-node interactions (port ordering + within-band clearance should handle)
  var crossBandRight = {};
  graph.links.forEach(function(l) {
    if (!l || !l.circular || l.isVirtual) return;
    if (!l.circularPathData || typeof l.circularPathData.rightLargeArcRadius !== "number") return;
    if (selfLinking(l, id)) return;
    var sourceKey =
      l.source && typeof l.source.column === "number"
        ? String(l.source.column)
        : String(Math.round((l.circularPathData.sourceX || 0) * 10) / 10);
    if (!crossBandRight[sourceKey]) crossBandRight[sourceKey] = [];
    crossBandRight[sourceKey].push(l);
  });

  Object.keys(crossBandRight).forEach(function(k) {
    var group = crossBandRight[k];
    if (!group || group.length < 2) return;

    // Stable inner->outer preference: smaller span should be more inner; if spans tie, smaller current rfe is inner.
    group.sort(function(a, b) {
      var ad = Math.abs((a.source && a.source.column || 0) - (a.target && a.target.column || 0));
      var bd = Math.abs((b.source && b.source.column || 0) - (b.target && b.target.column || 0));
      if (ad !== bd) return ad - bd;
      var ar = a.circularPathData.rightFullExtent;
      var br = b.circularPathData.rightFullExtent;
      if (ar !== br) return ar - br;
      return (a.circularLinkID || 0) - (b.circularLinkID || 0);
    });

    function rightLegSeg(link) {
      var c = link.circularPathData;
      var a = c.sourceY;
      var b = c.verticalRightInnerExtent;
      return [Math.min(a, b), Math.max(a, b)];
    }

    var slack = 0.25; // allow small extra without churning
    var maxIters = 25;
    for (var it = 0; it < maxIters; it++) {
      var changed = false;

      // Re-sort each iteration because we may move links outward.
      group.sort(function(a, b) {
        var ad = Math.abs((a.source && a.source.column || 0) - (a.target && a.target.column || 0));
        var bd = Math.abs((b.source && b.source.column || 0) - (b.target && b.target.column || 0));
        if (ad !== bd) return ad - bd;
        var ar = a.circularPathData.rightFullExtent;
        var br = b.circularPathData.rightFullExtent;
        if (ar !== br) return ar - br;
        return (a.circularLinkID || 0) - (b.circularLinkID || 0);
      });

      for (var i = 1; i < group.length; i++) {
        var prev = group[i - 1];
        var curr = group[i];
        if (!prev || !curr) continue;

        var sameSourceNode = prev.source && curr.source && id(prev.source) === id(curr.source);

        // Use the actual right-leg segment (sourceY ↔ verticalRightInnerExtent).
        var pSeg = rightLegSeg(prev);
        var cSeg = rightLegSeg(curr);
        var verticalOverlap = Math.max(0, Math.min(pSeg[1], cSeg[1]) - Math.max(pSeg[0], cSeg[0]));
        if (verticalOverlap <= 1e-6) continue;

        var prevW = prev.width || 0;
        var currW = curr.width || 0;
        var prevRight = prev.circularPathData.rightFullExtent + prevW / 2;
        var currLeft = curr.circularPathData.rightFullExtent - currW / 2;
        var gap = currLeft - prevRight;
        var required = circularLinkGap || 0;

        // Same-source-node ordering (very narrow):
        // If two non-self circular links exit the SAME node and their right legs overlap in Y,
        // enforce intuitive target-vertical ordering so "higher target" doesn't exit earlier than
        // "lower target" on the same shelf.
        //
        // For BOTTOM: lower target (larger y0) should be more inner than higher target.
        // If we see the reverse (higher target is inner), push the higher-target link outward past the lower one.
        if (sameSourceNode && prev.circularLinkType === "bottom" && curr.circularLinkType === "bottom") {
          var prevTgtY0 = prev.target && typeof prev.target.y0 === "number" ? prev.target.y0 : 0;
          var currTgtY0 = curr.target && typeof curr.target.y0 === "number" ? curr.target.y0 : 0;
          // prev is currently more inner (smaller rfe). If prev targets a HIGHER node (smaller y0),
          // ordering is wrong for bottom shelves.
          if (prevTgtY0 < currTgtY0 - 1e-6) {
            var desiredPrevRfe =
              curr.circularPathData.rightFullExtent + (prevW + currW) / 2 + required + 1e-6;
            if (desiredPrevRfe > prev.circularPathData.rightFullExtent + 1e-6) {
              var dOrd = desiredPrevRfe - prev.circularPathData.rightFullExtent;
              prev.circularPathData.rightLargeArcRadius += dOrd;
              if (typeof prev.circularPathData.rightSmallArcRadius === "number") {
                prev.circularPathData.rightSmallArcRadius += dOrd;
                if (prev.circularPathData.rightSmallArcRadius > prev.circularPathData.rightLargeArcRadius) {
                  prev.circularPathData.rightSmallArcRadius = prev.circularPathData.rightLargeArcRadius;
                }
              }
              prev.circularPathData.rightFullExtent =
                prev.circularPathData.sourceX +
                prev.circularPathData.rightLargeArcRadius +
                (prev.circularPathData.rightNodeBuffer || 0);
              changed = true;
              continue; // re-sort next iteration to realize the new ordering
            }
          }
        }

        // Skip other same-source-node pairs to avoid blowing apart same-node local cycles.
        if (sameSourceNode) continue;

        // Band ordering (revised): ONLY when right-leg segments overlap in Y.
        //
        // Desired order for this layout: BOTTOM links are more inner than TOP links,
        // so bottom shelves sit "before" top backlinks in the same source column.
        //
        // Exception: span=0 TOP cycles are very local and should remain compact/inner.
        // (e.g. filter→listing ○ should stay inside the bottom shelves.)
        if (prev.circularLinkType === "top" && curr.circularLinkType === "bottom") {
          var prevSpan = Math.abs((prev.source && prev.source.column || 0) - (prev.target && prev.target.column || 0));
          if (prevSpan !== 0) {
            var desiredPrevRfe =
              curr.circularPathData.rightFullExtent + (prevW + currW) / 2 + required + 1e-6;
            if (desiredPrevRfe > prev.circularPathData.rightFullExtent + 1e-6) {
              var dSwap = desiredPrevRfe - prev.circularPathData.rightFullExtent;
              prev.circularPathData.rightLargeArcRadius += dSwap;
              if (typeof prev.circularPathData.rightSmallArcRadius === "number") {
                prev.circularPathData.rightSmallArcRadius += dSwap;
                if (prev.circularPathData.rightSmallArcRadius > prev.circularPathData.rightLargeArcRadius) {
                  prev.circularPathData.rightSmallArcRadius = prev.circularPathData.rightLargeArcRadius;
                }
              }
              prev.circularPathData.rightFullExtent =
                prev.circularPathData.sourceX +
                prev.circularPathData.rightLargeArcRadius +
                (prev.circularPathData.rightNodeBuffer || 0);
              changed = true;
              continue; // re-sort next iteration to realize the new ordering
            }
          }
        }

        if (gap < required) {
          // Push curr outward to satisfy minimum clearance.
          var delta = required - gap + 1e-6;
          curr.circularPathData.rightLargeArcRadius += delta;
          if (typeof curr.circularPathData.rightSmallArcRadius === "number") {
            curr.circularPathData.rightSmallArcRadius += delta;
            if (curr.circularPathData.rightSmallArcRadius > curr.circularPathData.rightLargeArcRadius) {
              curr.circularPathData.rightSmallArcRadius = curr.circularPathData.rightLargeArcRadius;
            }
          }
          curr.circularPathData.rightFullExtent =
            curr.circularPathData.sourceX +
            curr.circularPathData.rightLargeArcRadius +
            (curr.circularPathData.rightNodeBuffer || 0);
          changed = true;
        } else if (gap > required + slack) {
          // If we're *too* far apart, compact by moving the INNER (prev) outward.
          var desiredPrevRightEdge = currLeft - required;
          var desiredPrevRfe = desiredPrevRightEdge - prevW / 2;
          var maxPrevRfe = curr.circularPathData.rightFullExtent - (prevW + currW) / 2 - required - 1e-6;
          if (desiredPrevRfe > maxPrevRfe) desiredPrevRfe = maxPrevRfe;
          if (desiredPrevRfe > prev.circularPathData.rightFullExtent + 1e-6) {
            var d2 = desiredPrevRfe - prev.circularPathData.rightFullExtent;
            prev.circularPathData.rightLargeArcRadius += d2;
            if (typeof prev.circularPathData.rightSmallArcRadius === "number") {
              prev.circularPathData.rightSmallArcRadius += d2;
              if (prev.circularPathData.rightSmallArcRadius > prev.circularPathData.rightLargeArcRadius) {
                prev.circularPathData.rightSmallArcRadius = prev.circularPathData.rightLargeArcRadius;
              }
            }
            prev.circularPathData.rightFullExtent =
              prev.circularPathData.sourceX +
              prev.circularPathData.rightLargeArcRadius +
              (prev.circularPathData.rightNodeBuffer || 0);
            changed = true;
          }
        }
      }

      if (!changed) break;
    }
  });

  // Pre-pass: ensure incoming links at a target node clear that node's self-loop on the LEFT leg.
  //
  // Why:
  // - Self-loops were intentionally excluded from left-leg clearance / left-side radius budgeting to keep
  //   unrelated links compact.
  // - But when a self-loop's left leg vertically overlaps an incoming link's left leg, they must still
  //   be separated horizontally; otherwise the two vertical legs visually merge.
  //
  // Scope:
  // - Only links that share the SAME target node as the self-loop (node-local, not whole column).
  // - Only when their left-leg segments overlap in Y (based on circularPathData targetY/verticalLeftInnerExtent).
  // - Never inflate the self-loop; instead push the OTHER link left by increasing its left arc radius.
  var leftSelfLoopByTarget = {};
  graph.links.forEach(function(l) {
    if (!l || !l.circular || l.isVirtual) return;
    if (!selfLinking(l, id)) return;
    if (!l.circularPathData || typeof l.circularPathData.leftLargeArcRadius !== "number") return;
    var tgtKey = id(l.target);
    if (!leftSelfLoopByTarget[tgtKey]) leftSelfLoopByTarget[tgtKey] = [];
    leftSelfLoopByTarget[tgtKey].push(l);
  });

  Object.keys(leftSelfLoopByTarget).forEach(function(tgtKey) {
    var loops = leftSelfLoopByTarget[tgtKey];
    if (!loops || !loops.length) return;

    // Consider all circular links that target this node (including both top/bottom),
    // but only push non-self links.
    var incoming = graph.links.filter(function(l) {
      if (!l || !l.circular || l.isVirtual) return false;
      if (!l.circularPathData || typeof l.circularPathData.leftLargeArcRadius !== "number") return false;
      return id(l.target) === tgtKey && !selfLinking(l, id);
    });
    if (!incoming.length) return;

    // Iterate a bit because pushing one link can change ordering / create new tight pairs.
    var maxIters = 10;
    for (var it = 0; it < maxIters; it++) {
      var changed = false;

      for (var li = 0; li < loops.length; li++) {
        var loop = loops[li];
        if (!loop || !loop.circularPathData) continue;
        var loopW = loop.width || 0;
        var loopYMin = Math.min(loop.circularPathData.targetY, loop.circularPathData.verticalLeftInnerExtent);
        var loopYMax = Math.max(loop.circularPathData.targetY, loop.circularPathData.verticalLeftInnerExtent);

        for (var oi = 0; oi < incoming.length; oi++) {
          var other = incoming[oi];
          if (!other || !other.circularPathData) continue;

          var otherYMin = Math.min(other.circularPathData.targetY, other.circularPathData.verticalLeftInnerExtent);
          var otherYMax = Math.max(other.circularPathData.targetY, other.circularPathData.verticalLeftInnerExtent);
          var vOv = Math.max(0, Math.min(loopYMax, otherYMax) - Math.max(loopYMin, otherYMin));
          if (vOv <= 1e-6) continue;

          var otherW = other.width || 0;
          var required = circularLinkGap || 0;
          // Gap between the loop's left edge and the other's right edge.
          var current =
            (loop.circularPathData.leftFullExtent - loopW / 2) -
            (other.circularPathData.leftFullExtent + otherW / 2);

          if (current < required) {
            var delta = (required - current) + 1e-6;
            other.circularPathData.leftLargeArcRadius += delta;
            if (typeof other.circularPathData.leftSmallArcRadius === "number") {
              other.circularPathData.leftSmallArcRadius += delta;
              if (other.circularPathData.leftSmallArcRadius > other.circularPathData.leftLargeArcRadius) {
                other.circularPathData.leftSmallArcRadius = other.circularPathData.leftLargeArcRadius;
              }
            }
            other.circularPathData.leftFullExtent =
              other.circularPathData.targetX -
              other.circularPathData.leftLargeArcRadius -
              (other.circularPathData.leftNodeBuffer || 0);
            changed = true;
          }
        }
      }

      if (!changed) break;
    }
  });

  // Pre-pass: ensure self-loops do not overlap other circular links on the LEFT vertical leg
  // within the same target column, even when they target different nodes.
  //
  // This specifically addresses same-column cycles where a TOP link's target-side left leg can
  // span a large Y range and visually merge with a BOTTOM self-loop's left leg in the same column
  // (e.g. listing ○→filter vs listing ○→listing ○).
  //
  // Scope:
  // - group by target column
  // - only when there is a self-loop in that column
  // - only for OTHER links that target a different node than the loop (cross-node)
  // - only when their left-leg segments overlap in Y (targetY ↔ verticalLeftInnerExtent)
  // - never inflate the self-loop; instead push the OTHER link further LEFT
  var selfLoopsByTargetCol = {};
  graph.links.forEach(function(l) {
    if (!l || !l.circular || l.isVirtual) return;
    if (!selfLinking(l, id)) return;
    if (!l.circularPathData || typeof l.circularPathData.leftLargeArcRadius !== "number") return;
    var col = l.target && typeof l.target.column === "number" ? String(l.target.column) : null;
    if (!col) return;
    if (!selfLoopsByTargetCol[col]) selfLoopsByTargetCol[col] = [];
    selfLoopsByTargetCol[col].push(l);
  });

  function _leftLegSeg(link) {
    var c = link.circularPathData;
    var a = c.targetY;
    var b = c.verticalLeftInnerExtent;
    return [Math.min(a, b), Math.max(a, b)];
  }

  Object.keys(selfLoopsByTargetCol).forEach(function(col) {
    var loops = selfLoopsByTargetCol[col];
    if (!loops || !loops.length) return;
    // All circular links in this target column (both top + bottom), excluding self-loops.
    var group = graph.links.filter(function(l) {
      if (!l || !l.circular || l.isVirtual) return false;
      if (!l.circularPathData || typeof l.circularPathData.leftLargeArcRadius !== "number") return false;
      var ccol = l.target && typeof l.target.column === "number" ? String(l.target.column) : null;
      return ccol === col && !selfLinking(l, id);
    });
    if (!group.length) return;

    var maxIters = 10;
    for (var it = 0; it < maxIters; it++) {
      var changed = false;
      for (var li = 0; li < loops.length; li++) {
        var loop = loops[li];
        if (!loop || !loop.circularPathData) continue;
        var loopSeg = _leftLegSeg(loop);
        var loopW = loop.width || 0;
        var loopTgtId = loop.target ? id(loop.target) : null;

        for (var gi = 0; gi < group.length; gi++) {
          var other = group[gi];
          if (!other || !other.circularPathData) continue;
          if (loopTgtId && other.target && id(other.target) === loopTgtId) continue; // cross-node only

          var otherSeg = _leftLegSeg(other);
          var vOv = Math.max(0, Math.min(loopSeg[1], otherSeg[1]) - Math.max(loopSeg[0], otherSeg[0]));
          if (vOv <= 1e-6) continue;

          // Ensure OTHER is to the LEFT of LOOP by >= circularGap.
          // NOTE: current is edge-to-edge already (we subtract +/- width/2), so don't add widths again.
          var otherW = other.width || 0;
          var required = circularLinkGap || 0;
          var current =
            (loop.circularPathData.leftFullExtent - loopW / 2) -
            (other.circularPathData.leftFullExtent + otherW / 2);
          if (current < required) {
            var delta = (required - current) + 1e-6;
            other.circularPathData.leftLargeArcRadius += delta;
            if (typeof other.circularPathData.leftSmallArcRadius === "number") {
              other.circularPathData.leftSmallArcRadius += delta;
              if (other.circularPathData.leftSmallArcRadius > other.circularPathData.leftLargeArcRadius) {
                other.circularPathData.leftSmallArcRadius = other.circularPathData.leftLargeArcRadius;
              }
            }
            other.circularPathData.leftFullExtent =
              other.circularPathData.targetX -
              other.circularPathData.leftLargeArcRadius -
              (other.circularPathData.leftNodeBuffer || 0);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
  });

  // Post-pass: ensure minimum horizontal clearance on the LEFT vertical leg.
  // Group links by circularLinkType AND target column - TOP and BOTTOM links don't affect each other
  // because they go in opposite directions and their left legs don't intersect.
  // Skip self-loops: they are already handled by the right leg post-pass (source col grouping).
  var leftGroups = {};
  graph.links.forEach(function(l) {
    if (!l.circular) return;
    if (!l.circularPathData) return;
    if (selfLinking(l, id)) return; // Self-loops handled by right leg pass
    if (typeof l.circularPathData.leftLargeArcRadius !== "number") return;
    var targetKey =
      l.target && typeof l.target.column === "number"
        ? String(l.target.column)
        : String(Math.round((l.circularPathData.targetX || 0) * 10) / 10);
    // Group by circularLinkType AND target column - TOP links only affect TOP, BOTTOM only affects BOTTOM
    var k = String(l.circularLinkType) + "|" + targetKey;
    if (!leftGroups[k]) leftGroups[k] = [];
    leftGroups[k].push(l);
  });

  Object.keys(leftGroups).forEach(function(k) {
    var group = leftGroups[k];
    var maxLeftIters = 20;
    for (var leftIt = 0; leftIt < maxLeftIters; leftIt++) {
      var leftChanged = false;
      // Sort by vertical band position first so "outer" matches the visual nesting:
      // - TOP: outer is higher (smaller verticalFullExtent)
      // - BOTTOM: outer is lower (larger verticalFullExtent)
      // Then fall back to leftFullExtent (more left = smaller).
      group.sort(function(a, b) {
        var av = a.circularPathData.verticalFullExtent;
        var bv = b.circularPathData.verticalFullExtent;
        if (group.length && group[0].circularLinkType === "top") {
          if (av !== bv) return av - bv; // outer first
        } else {
          if (av !== bv) return bv - av; // outer first for bottom
        }
        var al = a.circularPathData.leftFullExtent;
        var bl = b.circularPathData.leftFullExtent;
        if (al !== bl) return al - bl;
        return 0;
      });

      for (var i = 1; i < group.length; i++) {
        var prev = group[i - 1]; // outer (more to the left, smaller lfe)
        var curr = group[i];     // inner (more to the right, larger lfe)
        
        // Check if vertical ranges overlap on the left leg.
        // IMPORTANT: Use the actual target port position (link.y1), not node.y1.
        // Using node.y1 makes the overlap test far too broad (especially for TOP arcs),
        // which can cause excessive horizontal pushing of left legs.
        var prevTargetY =
          typeof prev.y1 === "number"
            ? prev.y1
            : (prev.target && typeof prev.target.y1 === "number" ? prev.target.y1 : 0);
        var prevVfe = prev.circularPathData.verticalFullExtent;
        var prevYMin = Math.min(prevTargetY, prevVfe);
        var prevYMax = Math.max(prevTargetY, prevVfe);
        
        var currTargetY =
          typeof curr.y1 === "number"
            ? curr.y1
            : (curr.target && typeof curr.target.y1 === "number" ? curr.target.y1 : 0);
        var currVfe = curr.circularPathData.verticalFullExtent;
        var currYMin = Math.min(currTargetY, currVfe);
        var currYMax = Math.max(currTargetY, currVfe);
        
        // Ranges overlap if: prevYMin <= currYMax AND currYMin <= prevYMax
        var verticalOverlap = (prevYMin <= currYMax) && (currYMin <= prevYMax);
        if (!verticalOverlap) continue; // No vertical overlap, no need for horizontal clearance
        
        var prevR = prev.circularPathData.leftLargeArcRadius;
        var prevW = prev.width || 0;
        var currW = curr.width || 0;
        var prevRight = prev.circularPathData.leftFullExtent + prevW / 2;
        var currLeft = curr.circularPathData.leftFullExtent - currW / 2;
        var gap = currLeft - prevRight;
        var required = circularLinkGap || 0;
        if (gap < required) {
          var delta = required - gap + 1e-6;
          // Increase prev's leftLargeArcRadius to push it more to the LEFT (decrease lfe)
          prev.circularPathData.leftLargeArcRadius = prevR + delta;
          if (typeof prev.circularPathData.leftSmallArcRadius === "number") {
            prev.circularPathData.leftSmallArcRadius += delta;
            if (prev.circularPathData.leftSmallArcRadius > prev.circularPathData.leftLargeArcRadius) {
              prev.circularPathData.leftSmallArcRadius = prev.circularPathData.leftLargeArcRadius;
            }
          }
          // Update leftFullExtent: lfe = targetX - radius - buffer
          prev.circularPathData.leftFullExtent =
            prev.circularPathData.targetX -
            prev.circularPathData.leftLargeArcRadius -
            (prev.circularPathData.leftNodeBuffer || 0);
          leftChanged = true;
        }
      }
      if (!leftChanged) break;
    }
  });

  // Post-pass: enforce global minimum vertical gap between ALL bottom circular links.
  //
  // The diagram has a shared "bottom escape band" for all bottom circular links. Even when
  // two links have non-overlapping horizontal ranges, their bottom arcs can visually overlap
  // unless we guarantee a minimum separation in absolute Y.
  //
  // This is intentionally global (not per column/group): it matches the layout invariant
  // checked in `test/sort-invariants.test.js`.
  var minBottomGap = circularLinkGap || 0;
  if (minBottomGap > 0) {
    var bottomCircular = graph.links.filter(function(l) {
      return (
        l &&
        l.circular &&
        l.circularLinkType === "bottom" &&
        !l.isVirtual &&
        l.circularPathData &&
        typeof l.circularPathData.verticalFullExtent === "number"
      );
    });
    // Iterate because pushing one link down can reorder adjacency,
    // and the invariant is defined on the final sorted order.
    var maxIters = 10;
    for (var it = 0; it < maxIters; it++) {
      var changed = false;
      bottomCircular.sort(function(a, b) {
        return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
      });

      for (var bi = 0; bi < bottomCircular.length; bi++) {
        var currL = bottomCircular[bi];
        // Keep self-loops compact: never push self-loops deeper in the global bottom-band min-gap pass.
        // Instead, other links will be pushed away from the self-loop when THEY are processed.
        if (selfLinking(currL, id)) continue;
        var currW = currL.width || 0;
        var currVfe = currL.circularPathData.verticalFullExtent;
        var targetVfe = currVfe;
        // Optional debug: capture the single tightest constraint that forces this push (if any).
        // NOTE: self-loops can still be pushed here even if their vBuf was set to 0 earlier.
        var _dbgMinBottom = !!currL._debugCircular;
        var _dbgBest = null; // { allowedCurrVfe, prevLink, overlapMode, xOverlap, prevBottom, required, span }

        // Bottom-band X range (inner extents).
        var cL =
          typeof currL.circularPathData.leftInnerExtent === "number" &&
          typeof currL.circularPathData.rightInnerExtent === "number"
            ? Math.min(currL.circularPathData.leftInnerExtent, currL.circularPathData.rightInnerExtent)
            : undefined;
        var cR =
          typeof currL.circularPathData.leftInnerExtent === "number" &&
          typeof currL.circularPathData.rightInnerExtent === "number"
            ? Math.max(currL.circularPathData.leftInnerExtent, currL.circularPathData.rightInnerExtent)
            : undefined;

        for (var pj = 0; pj < bi; pj++) {
          var prevL = bottomCircular[pj];

          // Prefer geometric crossing detection, but fall back to inner-X shelf overlap when available.
          // This avoids cases where two bottom shelves clearly overlap in X (inner extents overlap)
          // yet the higher-level crossing heuristic returns false and the shelves visually merge.
          var span = Math.abs((currL.source.column || 0) - (currL.target.column || 0));
          var overlaps = circularLinksActuallyCross(prevL, currL);
          var overlapMode = overlaps ? "cross" : "none";
          var xOverlap = undefined;
          if (!overlaps && cL !== undefined && cR !== undefined) {
            if (
              typeof prevL.circularPathData.leftInnerExtent === "number" &&
              typeof prevL.circularPathData.rightInnerExtent === "number"
            ) {
              var pL = Math.min(prevL.circularPathData.leftInnerExtent, prevL.circularPathData.rightInnerExtent);
              var pR = Math.max(prevL.circularPathData.leftInnerExtent, prevL.circularPathData.rightInnerExtent);
              xOverlap = Math.min(pR, cR) - Math.max(pL, cL);
              overlaps = xOverlap > 1e-6;
              overlapMode = overlaps ? "xOverlap" : "none";
            }
          }
          if (!overlaps) continue;

          var prevW = prevL.width || 0;
          var prevBottom = prevL.circularPathData.verticalFullExtent + prevW / 2;
          var allowedCurrVfe = prevBottom + minBottomGap + currW / 2;
          if (targetVfe < allowedCurrVfe) targetVfe = allowedCurrVfe;

          if (_dbgMinBottom && (!_dbgBest || allowedCurrVfe > _dbgBest.allowedCurrVfe + 1e-12)) {
            _dbgBest = {
              kind: "minBottomGap",
              iter: it,
              overlapMode: overlapMode,
              xOverlap: xOverlap,
              span: span,
              minBottomGap: minBottomGap,
              prevBottom: prevBottom,
              required:
                minBottomGap + (prevW / 2) + (currW / 2),
              allowedCurrVfe: allowedCurrVfe,
              prev: {
                index: prevL.index,
                source: prevL.source && prevL.source.name,
                target: prevL.target && prevL.target.name,
                width: prevW,
                vfe: prevL.circularPathData.verticalFullExtent
              }
            };
          }
        }

        if (targetVfe > currVfe + 1e-12) {
          var push = (targetVfe - currVfe) + 1e-6;
          currL.circularPathData.verticalFullExtent = currVfe + push;
          if (typeof currL.circularPathData.verticalBuffer === "number") {
            currL.circularPathData.verticalBuffer += push;
          }
          if (_dbgMinBottom) {
            // Use quoted property access so production minification doesn't mangle the debug field name.
            var _dbgKey = "_debugMinGapCauses";
            if (!currL.circularPathData[_dbgKey]) currL.circularPathData[_dbgKey] = [];
            currL.circularPathData[_dbgKey].push({
              kind: "minBottomGap",
              iter: it,
              curr: {
                index: currL.index,
                source: currL.source && currL.source.name,
                target: currL.target && currL.target.name,
                width: currW,
                vfeBefore: currVfe,
                vfeAfter: currVfe + push
              },
              targetVfe: targetVfe,
              push: push,
              tightest: _dbgBest
            });
          }
          changed = true;
        }
      }

      if (!changed) break;
    }

    // Debug-only: after the pass converges, record the *tightest* constraint for any link that opts in
    // via `link._debugCircular`. This is useful for self-loops that can end up deep without an
    // easy-to-capture per-iteration "push" event.
    //
    // Stored on `circularPathData["_debugMinBottomGapSummary"]` so minification won't rename the key.
    (bottomCircular || []).forEach(function(currL, biFinal) {
      if (!currL || !currL._debugCircular || !currL.circularPathData) return;
      var c = currL.circularPathData;
      if (typeof c.verticalFullExtent !== "number") return;

      var currW = currL.width || 0;
      var currVfe = c.verticalFullExtent;
      var best = null;

      // Bottom-band X range (inner extents).
      var cL =
        typeof c.leftInnerExtent === "number" && typeof c.rightInnerExtent === "number"
          ? Math.min(c.leftInnerExtent, c.rightInnerExtent)
          : undefined;
      var cR =
        typeof c.leftInnerExtent === "number" && typeof c.rightInnerExtent === "number"
          ? Math.max(c.leftInnerExtent, c.rightInnerExtent)
          : undefined;

      for (var pj = 0; pj < biFinal; pj++) {
        var prevL = bottomCircular[pj];
        if (!prevL || !prevL.circularPathData) continue;
        if (typeof prevL.circularPathData.verticalFullExtent !== "number") continue;

        var span = Math.abs((currL.source.column || 0) - (currL.target.column || 0));
        var overlaps = circularLinksActuallyCross(prevL, currL);
        var overlapMode = overlaps ? "cross" : "none";
        var xOverlap = undefined;

        if (!overlaps && span > 1 && cL !== undefined && cR !== undefined) {
          if (
            typeof prevL.circularPathData.leftInnerExtent === "number" &&
            typeof prevL.circularPathData.rightInnerExtent === "number"
          ) {
            var pL = Math.min(prevL.circularPathData.leftInnerExtent, prevL.circularPathData.rightInnerExtent);
            var pR = Math.max(prevL.circularPathData.leftInnerExtent, prevL.circularPathData.rightInnerExtent);
            xOverlap = Math.min(pR, cR) - Math.max(pL, cL);
            overlaps = xOverlap > 1e-6;
            overlapMode = overlaps ? "xOverlap" : "none";
          }
        }
        if (!overlaps) continue;

        var prevW = prevL.width || 0;
        var prevBottom = prevL.circularPathData.verticalFullExtent + prevW / 2;
        var allowedCurrVfe = prevBottom + minBottomGap + currW / 2;

        if (!best || allowedCurrVfe > best.allowedCurrVfe + 1e-12) {
          best = {
            overlapMode: overlapMode,
            xOverlap: xOverlap,
            span: span,
            prev: {
              index: prevL.index,
              source: prevL.source && prevL.source.name,
              target: prevL.target && prevL.target.name,
              width: prevW,
              vfe: prevL.circularPathData.verticalFullExtent
            },
            allowedCurrVfe: allowedCurrVfe
          };
        }
      }

      var _dbgKeySummary = "_debugMinBottomGapSummary";
      c[_dbgKeySummary] = {
        kind: "minBottomGap",
        rank: biFinal,
        minBottomGap: minBottomGap,
        curr: {
          index: currL.index,
          source: currL.source && currL.source.name,
          target: currL.target && currL.target.name,
          width: currW,
          vfe: currVfe,
          vBuf: c.verticalBuffer
        },
        tightest: best,
        // How far above the tightest constraint we currently sit (negative would mean violation).
        slack: best ? (currVfe - best.allowedCurrVfe) : null
      };
    });
  }

  // Post-pass: self-loops must always stay closer to the node than other bottom circular links
  // that actually cross them, and should push those neighbors away.
  //
  // Rationale:
  // - Port order (link.y0/y1) is separate from arc depth (verticalFullExtent).
  // - For readability, self-loops should be inner (closest), and other bottom arcs should escape deeper.
  var minSelfLoopExtraGap = circularLinkGap || 0;
  if (minSelfLoopExtraGap >= 0) {
    // Group candidate bottom circular links by node identity (use name as a fallback).
    var nodesByName = {};
    (graph.nodes || []).forEach(function(n) {
      if (n && n.name) nodesByName[n.name] = n;
    });

    // Collect self-loops (bottom) first.
    var bottomSelfLoops = graph.links.filter(function(l) {
      return (
        l &&
        l.circular &&
        l.circularLinkType === "bottom" &&
        !l.isVirtual &&
        selfLinking(l, id) &&
        l.circularPathData &&
        typeof l.circularPathData.verticalFullExtent === "number"
      );
    });

    bottomSelfLoops.forEach(function(selfL) {
      var node = selfL.source || (selfL.source && selfL.source.name ? nodesByName[selfL.source.name] : null);
      if (!node || typeof node.y1 !== "number") return;

      // Minimum depth for the self-loop: enough to accommodate its corner radius, but still compact.
      var r =
        selfL.circularPathData &&
        typeof selfL.circularPathData.rightLargeArcRadius === "number"
          ? selfL.circularPathData.rightLargeArcRadius
          : (baseRadius + (selfL.width || 0) / 2);
      var minDepth = Math.max(12, r + 4);
      var desiredSelfVfe = node.y1 + minDepth;

      // Pull self-loop up (closer to node) if it's deeper than necessary.
      if (selfL.circularPathData.verticalFullExtent > desiredSelfVfe) {
        var pullUp = selfL.circularPathData.verticalFullExtent - desiredSelfVfe;
        selfL.circularPathData.verticalFullExtent = desiredSelfVfe;
        // Keep verticalBuffer consistent (it acts as "how far from base" for many computations).
        if (typeof selfL.circularPathData.verticalBuffer === "number") {
          selfL.circularPathData.verticalBuffer = Math.max(0, selfL.circularPathData.verticalBuffer - pullUp);
        }
      }

      // Push all other bottom circular links that actually cross this self-loop downwards
      // so the self-loop stays inner.
      graph.links.forEach(function(other) {
        if (!other || other === selfL) return;
        if (!other.circular || other.circularLinkType !== "bottom") return;
        if (other.isVirtual) return;
        if (!other.circularPathData || typeof other.circularPathData.verticalFullExtent !== "number") return;

        if (!circularLinksActuallyCross(selfL, other)) return;

        var required =
          (circularLinkGap || 0) + ((selfL.width || 0) + (other.width || 0)) / 2;
        var minOtherVfe = selfL.circularPathData.verticalFullExtent + required;
        if (other.circularPathData.verticalFullExtent < minOtherVfe) {
          var push = (minOtherVfe - other.circularPathData.verticalFullExtent) + 1e-6;
          other.circularPathData.verticalFullExtent += push;
          if (typeof other.circularPathData.verticalBuffer === "number") {
            other.circularPathData.verticalBuffer += push;
          }
        }
      });
    });
  }

  // Post-pass: enforce minimum vertical gap WITHIN each BOTTOM target-node bundle.
  //
  // The global bottom min-gap pass relies on `circularLinksActuallyCross` and span heuristics;
  // in rare cases, two bottom backlinks into the same node can still end up on the exact same
  // horizontal shelf (same verticalFullExtent), which is always visually wrong.
  //
  // We treat "same target node" as overlap regardless of span/heuristics and push the outer
  // link DOWN until it satisfies circularGap + half-width separation.
  var perTargetBottomGap = circularLinkGap || 0;
  if (perTargetBottomGap > 0) {
    var bottomByTarget = new Map();
    graph.links.forEach(function(l) {
      if (!l || !l.circular || l.isVirtual || l.circularLinkType !== "bottom") return;
      if (!l.circularPathData || typeof l.circularPathData.verticalFullExtent !== "number") return;
      if (!l.target) return;
      // Only consider non-self links here; self-loops are handled by the self-loop pass above.
      if (selfLinking(l, id)) return;
      var key = l.target; // object identity
      var arr = bottomByTarget.get(key);
      if (!arr) { arr = []; bottomByTarget.set(key, arr); }
      arr.push(l);
    });

    var maxPerTargetBottomIters = 10;
    bottomByTarget.forEach(function(group) {
      if (!group || group.length < 2) return;
      for (var itPB = 0; itPB < maxPerTargetBottomIters; itPB++) {
        var changedPB = false;
        // Inner first (closer to node) = smaller VFE
        group.sort(function(a, b) {
          return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
        });
        for (var giB = 1; giB < group.length; giB++) {
          var inner = group[giB - 1];
          var outer = group[giB];
          var innerBottomEdge = inner.circularPathData.verticalFullExtent + (inner.width || 0) / 2;
          var outerTopEdge = outer.circularPathData.verticalFullExtent - (outer.width || 0) / 2;
          var gapNowB = outerTopEdge - innerBottomEdge;
          if (gapNowB < perTargetBottomGap) {
            var pushDown = (perTargetBottomGap - gapNowB) + 1e-6;
            outer.circularPathData.verticalFullExtent += pushDown;
            if (typeof outer.circularPathData.verticalBuffer === "number") {
              outer.circularPathData.verticalBuffer += pushDown;
            }
            if (outer._debugCircular) {
              // Use quoted property access so production minification doesn't mangle the debug field name.
              var _dbgKeyPB = "_debugMinGapCauses";
              if (!outer.circularPathData[_dbgKeyPB]) outer.circularPathData[_dbgKeyPB] = [];
              outer.circularPathData[_dbgKeyPB].push({
                kind: "perTargetBottomGap",
                iter: itPB,
                target: outer.target && outer.target.name,
                gapNow: gapNowB,
                requiredGap: perTargetBottomGap,
                push: pushDown,
                inner: {
                  index: inner.index,
                  source: inner.source && inner.source.name,
                  target: inner.target && inner.target.name,
                  width: inner.width || 0,
                  vfe: inner.circularPathData.verticalFullExtent
                },
                outer: {
                  index: outer.index,
                  source: outer.source && outer.source.name,
                  target: outer.target && outer.target.name,
                  width: outer.width || 0,
                  vfeAfter: outer.circularPathData.verticalFullExtent
                }
              });
            }
            changedPB = true;
          }
        }
        if (!changedPB) break;
      }
    });
  }

  // Finalize: after self-loop and per-target bottom passes, re-enforce the global bottom-band min-gap.
  // These later passes can push some links deeper, which can re-introduce shelf overlaps with other
  // bottom links (e.g. `schedule ○→filter` getting pushed can overlap `listing ○→search ●`).
  //
  // Keep self-loops compact: treat them as fixed anchors (never push them), and push non-self links away.
  if (minBottomGap > 0) {
    var bottomCircular2 = graph.links.filter(function(l) {
      return (
        l &&
        l.circular &&
        l.circularLinkType === "bottom" &&
        !l.isVirtual &&
        l.circularPathData &&
        typeof l.circularPathData.verticalFullExtent === "number"
      );
    });
    var maxIters2 = 10;
    for (var it2 = 0; it2 < maxIters2; it2++) {
      var changed2 = false;
      bottomCircular2.sort(function(a, b) {
        return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
      });

      for (var bi2 = 0; bi2 < bottomCircular2.length; bi2++) {
        var curr2 = bottomCircular2[bi2];
        if (!curr2) continue;
        if (selfLinking(curr2, id)) continue; // keep self-loops compact/inner
        var currW2 = curr2.width || 0;
        var currVfe2 = curr2.circularPathData.verticalFullExtent;
        var targetVfe2 = currVfe2;

        var cL2 =
          typeof curr2.circularPathData.leftInnerExtent === "number" &&
          typeof curr2.circularPathData.rightInnerExtent === "number"
            ? Math.min(curr2.circularPathData.leftInnerExtent, curr2.circularPathData.rightInnerExtent)
            : undefined;
        var cR2 =
          typeof curr2.circularPathData.leftInnerExtent === "number" &&
          typeof curr2.circularPathData.rightInnerExtent === "number"
            ? Math.max(curr2.circularPathData.leftInnerExtent, curr2.circularPathData.rightInnerExtent)
            : undefined;

        for (var pj2 = 0; pj2 < bi2; pj2++) {
          var prev2 = bottomCircular2[pj2];
          if (!prev2 || !prev2.circularPathData) continue;

          var overlaps2 = circularLinksActuallyCross(prev2, curr2);
          if (!overlaps2 && cL2 !== undefined && cR2 !== undefined) {
            if (
              typeof prev2.circularPathData.leftInnerExtent === "number" &&
              typeof prev2.circularPathData.rightInnerExtent === "number"
            ) {
              var pL2 = Math.min(prev2.circularPathData.leftInnerExtent, prev2.circularPathData.rightInnerExtent);
              var pR2 = Math.max(prev2.circularPathData.leftInnerExtent, prev2.circularPathData.rightInnerExtent);
              var xOv2 = Math.min(pR2, cR2) - Math.max(pL2, cL2);
              overlaps2 = xOv2 > 1e-6;
            }
          }
          if (!overlaps2) continue;

          var prevW2 = prev2.width || 0;
          var prevBottom2 = prev2.circularPathData.verticalFullExtent + prevW2 / 2;
          var allowed2 = prevBottom2 + minBottomGap + currW2 / 2;
          if (targetVfe2 < allowed2) targetVfe2 = allowed2;
        }

        if (targetVfe2 > currVfe2 + 1e-12) {
          var push2 = (targetVfe2 - currVfe2) + 1e-6;
          curr2.circularPathData.verticalFullExtent = currVfe2 + push2;
          if (typeof curr2.circularPathData.verticalBuffer === "number") {
            curr2.circularPathData.verticalBuffer += push2;
          }
          changed2 = true;
        }
      }

      if (!changed2) break;
    }
  }

  // Post-pass: enforce minimum vertical gap WITHIN each TOP target-node bundle.
  //
  // The global TOP min-gap pass only considers adjacency in overall VFE order; links targeting
  // the same node can still end up intersecting if other links sit between them globally.
  // This per-target pass ensures all TOP links into the same target node have >= circularGap.
  var perTargetTopGap = circularLinkGap || 0;
  if (perTargetTopGap > 0) {
    var topByTarget = new Map();
    graph.links.forEach(function(l) {
      if (!l || !l.circular || l.isVirtual || l.circularLinkType !== "top") return;
      if (!l.circularPathData || typeof l.circularPathData.verticalFullExtent !== "number") return;
      if (!l.target) return;
      // Keep self-loops compact: do not push top self-loops further up in per-target top-gap pass.
      if (selfLinking(l, id)) return;
      var key = l.target; // object identity
      var arr = topByTarget.get(key);
      if (!arr) { arr = []; topByTarget.set(key, arr); }
      arr.push(l);
    });

    var maxPerTargetIters = 10;
    topByTarget.forEach(function(group) {
      if (!group || group.length < 2) return;
      for (var itPT = 0; itPT < maxPerTargetIters; itPT++) {
        var changedPT = false;
        // Inner first (closer to nodes) = higher VFE
        group.sort(function(a, b) {
          return b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent;
        });
        for (var gi = 1; gi < group.length; gi++) {
          var inner = group[gi - 1];
          var outer = group[gi];
          var innerTopEdge = inner.circularPathData.verticalFullExtent - (inner.width || 0) / 2;
          var outerBottomEdge = outer.circularPathData.verticalFullExtent + (outer.width || 0) / 2;
          var gapNow = innerTopEdge - outerBottomEdge;
          if (gapNow < perTargetTopGap) {
            var pushUp = (perTargetTopGap - gapNow) + 1e-6;
            // Push outer UP (more outer = higher visually) => decrease its VFE
            outer.circularPathData.verticalFullExtent -= pushUp;
            if (typeof outer.circularPathData.verticalBuffer === "number") {
              outer.circularPathData.verticalBuffer += pushUp;
            }
            changedPT = true;
          }
        }
        if (!changedPT) break;
      }
    });
  }

  // Post-pass: enforce global minimum vertical gap between ALL top circular links.
  //
  // Same logic as bottom but inverted: for TOP links, lower VFE = higher visually.
  // Gap = (higher link's VFE - w/2) - (lower link's VFE + w/2)
  // If gap is too small, push the lower link UP (decrease its VFE).
  var minTopGap = circularLinkGap || 0;
  if (minTopGap > 0) {
    var topCircular = graph.links.filter(function(l) {
      return (
        l &&
        l.circular &&
        l.circularLinkType === "top" &&
        !l.isVirtual &&
        l.circularPathData &&
        typeof l.circularPathData.verticalFullExtent === "number"
      );
    });
    var maxItersTop = 10;
    for (var itTop = 0; itTop < maxItersTop; itTop++) {
      var changedTop = false;
      // Sort by VFE descending: higher VFE first (these are the links closer to nodes)
      topCircular.sort(function(a, b) {
        return b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent;
      });
      for (var ti = 0; ti < topCircular.length; ti++) {
        var currT = topCircular[ti]; // current link (closer-to-node earlier, outer later)
        // Keep self-loops compact: never push top self-loops further up in the global top-band min-gap pass.
        // Other links will be pushed away from them when processed.
        if (selfLinking(currT, id)) continue;
        var currW = currT.width || 0;
        var currVfe = currT.circularPathData.verticalFullExtent;
        var targetVfe = currVfe;

        // Compute curr's top-band X range once.
        var cL = Math.min(currT.circularPathData.leftInnerExtent, currT.circularPathData.rightInnerExtent);
        var cR = Math.max(currT.circularPathData.leftInnerExtent, currT.circularPathData.rightInnerExtent);

        // Ensure a minimum gap to *all* earlier (inner) links that overlap in the top-band region.
        for (var pj = 0; pj < ti; pj++) {
          var prevT = topCircular[pj];
          var prevW = prevT.width || 0;

          // Overlap criteria:
          // - strict crossing, OR
          // - overlapping X ranges on the top horizontal band (inner extents overlap)
          var overlaps = circularLinksActuallyCross(prevT, currT);
          if (!overlaps) {
            var pL = Math.min(prevT.circularPathData.leftInnerExtent, prevT.circularPathData.rightInnerExtent);
            var pR = Math.max(prevT.circularPathData.leftInnerExtent, prevT.circularPathData.rightInnerExtent);
            var xOverlap = Math.min(pR, cR) - Math.max(pL, cL);
            overlaps = xOverlap > 1e-6;
          }
          if (!overlaps) continue;

          var prevTopEdge = prevT.circularPathData.verticalFullExtent - prevW / 2;
          // Need: (prevTopEdge) - (currVfe + currW/2) >= minTopGap
          var allowedCurrVfe = prevTopEdge - minTopGap - currW / 2;
          if (targetVfe > allowedCurrVfe) targetVfe = allowedCurrVfe;
        }

        if (targetVfe < currVfe - 1e-12) {
          // Push curr UP = decrease its VFE (add epsilon to avoid float equality issues)
          var pushTop = (currVfe - targetVfe) + 1e-6;
          currT.circularPathData.verticalFullExtent = currVfe - pushTop;
          if (typeof currT.circularPathData.verticalBuffer === "number") {
            currT.circularPathData.verticalBuffer += pushTop;
          }
          changedTop = true;
        }
      }
      if (!changedTop) break;
    }
  }

  // Recompute extents that depend on radii (post-passes above mutate radii).
  graph.links.forEach(function(link) {
    if (!link.circular || !link.circularPathData) return;
    var c = link.circularPathData;

    // inner extents are buffer-only
    c.rightInnerExtent = c.sourceX + c.rightNodeBuffer;
    c.leftInnerExtent = c.targetX - c.leftNodeBuffer;

    // full extents depend on radii
    c.rightFullExtent = c.sourceX + c.rightLargeArcRadius + c.rightNodeBuffer;
    c.leftFullExtent = c.targetX - c.leftLargeArcRadius - c.leftNodeBuffer;

    // vertical inner extents depend on radii + direction
    if (link.circularLinkType === "bottom") {
      c.verticalRightInnerExtent = c.verticalFullExtent - c.rightLargeArcRadius;
      c.verticalLeftInnerExtent = c.verticalFullExtent - c.leftLargeArcRadius;
    } else {
      c.verticalRightInnerExtent = c.verticalFullExtent + c.rightLargeArcRadius;
      c.verticalLeftInnerExtent = c.verticalFullExtent + c.leftLargeArcRadius;
    }
  });

  // Debug-only: after ALL vertical passes have run, capture the final tightest bottom-band
  // min-gap constraint for any opted-in link (`link._debugCircular`), especially self-loops.
  //
  // Stored under a quoted key so minification won't rename it.
  try {
    var _dbgFinalKey = "_debugFinalBottomGapConstraint";
    var _dbgMinBottomGap = circularLinkGap || 0;
    if (_dbgMinBottomGap > 0) {
      var _dbgBottom = graph.links.filter(function(l) {
        return (
          l &&
          l.circular &&
          l.circularLinkType === "bottom" &&
          !l.isVirtual &&
          l.circularPathData &&
          typeof l.circularPathData.verticalFullExtent === "number"
        );
      });
      _dbgBottom.sort(function(a, b) {
        return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
      });

      for (var biDbg = 0; biDbg < _dbgBottom.length; biDbg++) {
        var currD = _dbgBottom[biDbg];
        if (!currD || !currD._debugCircular || !currD.circularPathData) continue;
        var cD = currD.circularPathData;
        var currWDbg = currD.width || 0;
        var currVfeDbg = cD.verticalFullExtent;
        var bestDbg = null;

        // Bottom-band X range (inner extents).
        var cLD =
          typeof cD.leftInnerExtent === "number" && typeof cD.rightInnerExtent === "number"
            ? Math.min(cD.leftInnerExtent, cD.rightInnerExtent)
            : undefined;
        var cRD =
          typeof cD.leftInnerExtent === "number" && typeof cD.rightInnerExtent === "number"
            ? Math.max(cD.leftInnerExtent, cD.rightInnerExtent)
            : undefined;

        for (var pjDbg = 0; pjDbg < biDbg; pjDbg++) {
          var prevD = _dbgBottom[pjDbg];
          if (!prevD || !prevD.circularPathData) continue;
          if (typeof prevD.circularPathData.verticalFullExtent !== "number") continue;

          var spanDbg = Math.abs((currD.source.column || 0) - (currD.target.column || 0));
          var overlapsDbg = circularLinksActuallyCross(prevD, currD);
          var overlapModeDbg = overlapsDbg ? "cross" : "none";
          var xOverlapDbg = undefined;

          if (!overlapsDbg && spanDbg > 1 && cLD !== undefined && cRD !== undefined) {
            if (
              typeof prevD.circularPathData.leftInnerExtent === "number" &&
              typeof prevD.circularPathData.rightInnerExtent === "number"
            ) {
              var pLD = Math.min(prevD.circularPathData.leftInnerExtent, prevD.circularPathData.rightInnerExtent);
              var pRD = Math.max(prevD.circularPathData.leftInnerExtent, prevD.circularPathData.rightInnerExtent);
              xOverlapDbg = Math.min(pRD, cRD) - Math.max(pLD, cLD);
              overlapsDbg = xOverlapDbg > 1e-6;
              overlapModeDbg = overlapsDbg ? "xOverlap" : "none";
            }
          }
          if (!overlapsDbg) continue;

          var prevWDbg = prevD.width || 0;
          var prevBottomDbg = prevD.circularPathData.verticalFullExtent + prevWDbg / 2;
          var allowedCurrVfeDbg = prevBottomDbg + _dbgMinBottomGap + currWDbg / 2;

          if (!bestDbg || allowedCurrVfeDbg > bestDbg.allowedCurrVfe + 1e-12) {
            bestDbg = {
              overlapMode: overlapModeDbg,
              xOverlap: xOverlapDbg,
              span: spanDbg,
              prev: {
                index: prevD.index,
                source: prevD.source && prevD.source.name,
                target: prevD.target && prevD.target.name,
                width: prevWDbg,
                vfe: prevD.circularPathData.verticalFullExtent
              },
              allowedCurrVfe: allowedCurrVfeDbg
            };
          }
        }

        cD[_dbgFinalKey] = {
          kind: "minBottomGap",
          minBottomGap: _dbgMinBottomGap,
          rank: biDbg,
          curr: {
            index: currD.index,
            source: currD.source && currD.source.name,
            target: currD.target && currD.target.name,
            width: currWDbg,
            vfe: currVfeDbg,
            vBuf: cD.verticalBuffer
          },
          tightest: bestDbg,
          slack: bestDbg ? (currVfeDbg - bestDbg.allowedCurrVfe) : null
        };
      }
    }
  } catch (eDbgFinal) {
    // ignore debug failures
  }

  graph.links.forEach(function(link) {
    if (link.circular) {
      link.path = createCircularPathString(link);
    } else {
  var normalPath = linkHorizontal()
    .source(function (d) {
      var x = d.source.x0 + (d.source.x1 - d.source.x0);
      var y = d.y0;
      return [x, y];
    })
    .target(function (d) {
      var x = d.target.x0;
      var y = d.y1;
      return [x, y];
    });
      link.path = normalPath(link);
    }
  });

  return graph;
}

// creates vertical buffer values per set of top/bottom links
function calcVerticalBuffer(links, nodes, id, circularLinkGap, graph, verticalMargin) {
  function dbg(link) {
    return !!(link && link._debugCircular);
  }
  function nameOf(link) {
    if (!link) return "?";
    var s = link.source && (link.source.name || link.source.index);
    var t = link.target && (link.target.name || link.target.index);
    return String(s) + "->" + String(t) + " (#" + String(link.index) + ")";
  }

  // Pre-calculate base Y for each link to optimize collision logic
  links.forEach(function(link) {
    var ext = getLinkBaseExtents(link, nodes);
    link.circularPathData._extMinY = ext.minY;
    link.circularPathData._extMaxY = ext.maxY;
    link.circularPathData.baseY = link.circularLinkType === "bottom" ? ext.maxY : ext.minY;
  });

  // Pre-calculate max span for each target column (for group ordering)
  var maxSpanByTarget = {};
  links.forEach(function(link) {
    var targetCol = link.target.column;
    var span = Math.abs(link.source.column - link.target.column);
    if (maxSpanByTarget[targetCol] === undefined || span > maxSpanByTarget[targetCol]) {
      maxSpanByTarget[targetCol] = span;
    }
  });
  
  // Attach max span to each link for sorting
  links.forEach(function(link) {
    link._targetGroupMaxSpan = maxSpanByTarget[link.target.column];
  });
  
  // New grouping algorithm:
  // 1. Group links by target column to ensure links to same node are together
  // 2. Within each group, sort by ascending distance (shortest first)
  // 3. Order groups to minimize horizontal crossings between groups
  // 4. Apply vertical buffering within this grouped order

  var groups = {};
  links.forEach(function(link) {
    var targetCol = link.target.column;
    if (!groups[targetCol]) groups[targetCol] = [];
    groups[targetCol].push(link);
  });

  // Sort within each group (same target column) so that:
  // - self-links (distance 0) come LAST (outer) relative to other links,
  // - for equal span, order by source vertical position (upper first),
  // - then thinner first as a stable tie-break.
  // This helps avoid:
  // - non-self backlinks being pushed below self-loops,
  // - crossings between same-span links,
  // - thin links becoming outermost and entering a node from above.
  Object.values(groups).forEach(function(group) {
    group.sort(function(a, b) {
      // For BOTTOM BACKLINKS that land in the same target column with the same span,
      // we want the *arc depth* (verticalBuffer/verticalFullExtent) to be inverted relative to
      // target vertical order:
      // - lower targets should curl LESS deep (stay closer to the node)
      // - higher targets should curl MORE deep (go more outer/deeper)
      //
      // Depth is primarily driven by processing order: earlier links get smaller verticalBuffer.
      // So we process LOWER targets first (DESC) in this specific tie-case.
      var aIsBottomBacklinkForDepth =
        a.circularLinkType === "bottom" && (a.target.column || 0) < (a.source.column || 0);
      var bIsBottomBacklinkForDepth =
        b.circularLinkType === "bottom" && (b.target.column || 0) < (b.source.column || 0);
      if (aIsBottomBacklinkForDepth && bIsBottomBacklinkForDepth) {
        var aDistDepth = Math.abs(a.source.column - a.target.column);
        var bDistDepth = Math.abs(b.source.column - b.target.column);
        var sameSpanDepth = (aDistDepth === bDistDepth);
        var sameTargetColDepth = (a.target.column === b.target.column);
        var sameSourceColDepth = (a.source.column === b.source.column);
        if (sameSpanDepth && sameTargetColDepth && sameSourceColDepth) {
          var aTgtCYDepth =
            a.target && typeof a.target.y0 === "number" && typeof a.target.y1 === "number"
              ? (a.target.y0 + a.target.y1) / 2
              : 0;
          var bTgtCYDepth =
            b.target && typeof b.target.y0 === "number" && typeof b.target.y1 === "number"
              ? (b.target.y0 + b.target.y1) / 2
              : 0;
          if (Math.abs(aTgtCYDepth - bTgtCYDepth) >= 1e-6) {
            // DESC: lower targets first (shallower), higher targets later (deeper)
            return bTgtCYDepth - aTgtCYDepth;
          }
        }
      }

      // Keep links targeting the same node together (prevents alternating/braiding between
      // multiple target nodes in the same column).
      //
      // Primary key: target vertical position (y0). This makes all backlinks entering the
      // upper target node come before those entering a lower target node.
      // Secondary key (only when y0 is equal): smaller target node first.
      var aTgtY0 = a.target && typeof a.target.y0 === "number" ? a.target.y0 : 0;
      var bTgtY0 = b.target && typeof b.target.y0 === "number" ? b.target.y0 : 0;
      if (Math.abs(aTgtY0 - bTgtY0) >= 1e-6) return aTgtY0 - bTgtY0;

      var aTgtH =
        a.target && typeof a.target.y1 === "number" && typeof a.target.y0 === "number"
          ? a.target.y1 - a.target.y0
          : 0;
      var bTgtH =
        b.target && typeof b.target.y1 === "number" && typeof b.target.y0 === "number"
          ? b.target.y1 - b.target.y0
          : 0;
      if (aTgtH !== bTgtH) return aTgtH - bTgtH; // smaller target first

      var aSelf = selfLinking(a, id);
      var bSelf = selfLinking(b, id);
      // Self-loops should stay inner (closer to node) and push other circular links away.
      // Process them first so they get smaller verticalBuffer / smaller |verticalFullExtent - baseY|.
      if (aSelf !== bSelf) return aSelf ? -1 : 1;

      // Special-case: for backlinks into the same target node with the same span from the same source column,
      // order by source vertical position DESC (lower sources first).
      // This makes lower sources \"wrap\" earlier (smaller verticalBuffer -> smaller verticalFullExtent),
      // matching the requested behavior for schedule ◐ -> search ● vs schedule ● -> search ●.
      var aIsBacklink0 =
        a.circularLinkType === "bottom" && (a.target.column || 0) < (a.source.column || 0);
      var bIsBacklink0 =
        b.circularLinkType === "bottom" && (b.target.column || 0) < (b.source.column || 0);
      var sameTargetNode0 = (a.target === b.target);
      if (aIsBacklink0 && bIsBacklink0 && sameTargetNode0) {
        var distA0 = Math.abs(a.source.column - a.target.column);
        var distB0 = Math.abs(b.source.column - b.target.column);
        if (distA0 === distB0 && a.source.column === b.source.column) {
          var aSrcY0 = (a.source.y0 + a.source.y1) / 2;
          var bSrcY0 = (b.source.y0 + b.source.y1) / 2;
          if (Math.abs(aSrcY0 - bSrcY0) >= 1e-6) return bSrcY0 - aSrcY0;
        }
      }

      // Bottom backlinks into the SAME target node:
      // - For *curl depth* (verticalBuffer / verticalFullExtent), we want nearer (shorter span)
      //   to curl less deep (stay higher), and farther spans to go more outer/deeper.
      // - Do NOT change the node entry order here (that's handled by sortTargetLinks + port assignment).
      var aIsBottomBacklink =
        a.circularLinkType === "bottom" && (a.target.column || 0) < (a.source.column || 0);
      var bIsBottomBacklink =
        b.circularLinkType === "bottom" && (b.target.column || 0) < (b.source.column || 0);
      var sameTargetNode1 = (a.target === b.target);
      if (aIsBottomBacklink && bIsBottomBacklink && sameTargetNode1) {
        var distA1 = Math.abs(a.source.column - a.target.column);
        var distB1 = Math.abs(b.source.column - b.target.column);
        // Nearer first => smaller verticalBuffer => smaller verticalFullExtent (higher bottom boundary).
        if (distA1 !== distB1) return distA1 - distB1;

        // If span ties, keep higher entry processed first (helps reduce target-side braiding).
        var aY1 = typeof a.y1 === "number" ? a.y1 : 0;
        var bY1 = typeof b.y1 === "number" ? b.y1 : 0;
        if (Math.abs(aY1 - bY1) >= 1e-6) return aY1 - bY1;
      }

      var distA = Math.abs(a.source.column - a.target.column);
      var distB = Math.abs(b.source.column - b.target.column);
      if (distA !== distB) return distA - distB;

      // Stable-ish tie-breakers to reduce jitter between reruns
      var aSrcY = (a.source.y0 + a.source.y1) / 2;
      var bSrcY = (b.source.y0 + b.source.y1) / 2;
      if (aSrcY !== bSrcY) return aSrcY - bSrcY;

      var aw = a.width || 0;
      var bw = b.width || 0;
      if (aw !== bw) return aw - bw; // thinner first

      return (a.circularLinkID || 0) - (b.circularLinkID || 0) || a.index - b.index;
    });
  });

  // For each group, compute shared minY/maxY across all links in the group.
  // This makes links targeting the same column align to the same baseline/ceiling,
  // so the "bundle" looks coherent and avoids one link not reaching another's height.
  Object.values(groups).forEach(function(group) {
    var groupMinY = Infinity;
    var groupMaxY = -Infinity;
    group.forEach(function(l) {
      if (l.circularPathData && typeof l.circularPathData._extMinY === "number") {
        groupMinY = Math.min(groupMinY, l.circularPathData._extMinY);
      }
      if (l.circularPathData && typeof l.circularPathData._extMaxY === "number") {
        groupMaxY = Math.max(groupMaxY, l.circularPathData._extMaxY);
      }
    });
    // Attach group extents to each link
    group.forEach(function(l) {
      l.circularPathData.groupMinY = groupMinY;
      l.circularPathData.groupMaxY = groupMaxY;
      l.circularPathData.groupSize = group.length;
    });
  });

  // Pre-compute baseOffset *here* so verticalBuffer stacking can compensate for it.
  // Without this, links with larger baseOffset (e.g. longer spans) get pushed down/up
  // by BOTH verticalBuffer and baseOffset differences, creating artificial holes even
  // within the same target bundle.
  var diagramY0 = (graph && typeof graph.y0 === "number") ? graph.y0 : undefined;
  var diagramY1 = (graph && typeof graph.y1 === "number") ? graph.y1 : undefined;
  if (typeof diagramY0 !== "number" || typeof diagramY1 !== "number") {
    diagramY0 = Infinity;
    diagramY1 = -Infinity;
    (nodes || []).forEach(function(n) {
      if (!n) return;
      if (typeof n.y0 === "number") diagramY0 = Math.min(diagramY0, n.y0);
      if (typeof n.y1 === "number") diagramY1 = Math.max(diagramY1, n.y1);
    });
    if (diagramY0 === Infinity) diagramY0 = 0;
    if (diagramY1 === -Infinity) diagramY1 = 0;
  }
  var diagramHeight = diagramY1 - diagramY0;
  var vMargin = (typeof verticalMargin === "number") ? verticalMargin : 0;

  // Nodes that have a bottom self-loop (by id). Links entering these nodes should stay compact.
  var bottomSelfLoopNodeIds = new Set();
  if (graph && Array.isArray(graph.links)) {
    graph.links.forEach(function(l) {
      if (!l || !l.circular) return;
      if (l.circularLinkType !== "bottom") return;
      if (!selfLinking(l, id)) return;
      try { bottomSelfLoopNodeIds.add(String(id(l.source))); } catch (e) { /* ignore */ }
    });
  }

  links.forEach(function(link) {
    if (!link || !link.circularPathData) return;
    // Self-loops handle baseOffset separately (forced 0) and don't participate in this correction.
    if (selfLinking(link, id)) {
      link.circularPathData._baseOffsetForBuffer = 0;
      return;
    }
    var relevantMinY = (typeof link.circularPathData._extMinY === "number")
      ? link.circularPathData._extMinY
      : Math.min(link.source.y0, link.target.y0);
    var relevantMaxY = (typeof link.circularPathData._extMaxY === "number")
      ? link.circularPathData._extMaxY
      : Math.max(link.source.y1, link.target.y1);

    if (
      link.circularPathData.groupSize > 1 &&
      typeof link.circularPathData.groupMinY === "number" &&
      typeof link.circularPathData.groupMaxY === "number"
    ) {
      relevantMinY = link.circularPathData.groupMinY;
      relevantMaxY = link.circularPathData.groupMaxY;
    }

    var columnHeight = relevantMaxY - relevantMinY;
    var linkSpan = Math.abs((link.source.column || 0) - (link.target.column || 0));

    // Match the baseOffset logic used later in addCircularPathData (so vBuf stacking can compensate accurately).
    var spanFactor =
      (link.circularLinkType === "top")
        ? 0.045
        : (linkSpan <= 1 ? 0.04 : (linkSpan === 2 ? 0.06 : 0.08));
    var minEscape = vMargin + link.width + 2;
    if (link.circularLinkType === "bottom" && link.target) {
      var tgtKey = null;
      try { tgtKey = String(id(link.target)); } catch (e) { tgtKey = null; }
      if (tgtKey && bottomSelfLoopNodeIds.has(tgtKey)) {
        if (linkSpan <= 1) {
          minEscape = Math.max(10, link.width / 2 + 6);
          spanFactor = Math.min(spanFactor, 0.03);
        } else {
          minEscape = Math.max(10, link.width + 6);
        }
      }
    }
    var desiredBaseOffset = Math.max(minEscape, columnHeight * spanFactor);

    var capFactor = linkSpan <= 2 ? 0.03 : 0.045;
    var maxAllowedBaseOffset = Math.max(vMargin, diagramHeight * capFactor);
    var isBacklink = (link.source.column || 0) > (link.target.column || 0);
    if (isBacklink && link.circularLinkType === "top" && linkSpan <= 2) {
      var longCap = Math.max(vMargin, diagramHeight * 0.045);
      maxAllowedBaseOffset = Math.min(maxAllowedBaseOffset + 4, longCap);
    }

    var baseOffset = Math.min(desiredBaseOffset, maxAllowedBaseOffset);
    if (
      link.circularLinkType === "top" &&
      link.target &&
      typeof link.target.y0 === "number" &&
      typeof link.target.y1 === "number" &&
      typeof diagramY0 === "number" &&
      typeof diagramY1 === "number"
    ) {
      var tCY = (link.target.y0 + link.target.y1) / 2;
      var h = (diagramY1 - diagramY0) || 1;
      var norm = (diagramY1 - tCY) / h;
      var extraTop = Math.max(0, Math.min(4, 4 * norm));
      baseOffset = Math.min(baseOffset + extraTop, maxAllowedBaseOffset);
    }

    link.circularPathData._baseOffsetForBuffer = baseOffset;
  });

  // Order groups to minimize crossings:
  // - Prefer groups with smaller MAX span first (inner)
  // - Larger-span groups later (outer)
  // Using MAX span (rather than average) ensures that a group containing any long backlink
  // is treated as "outer" overall, preventing that long backlink from being forced inner
  // relative to shorter-span links from other groups.
  //
  // Additional TOP-only tie-breaker:
  // When two target columns sit on the same row (same min target.y0), process the column
  // whose top-most target node is SMALLER (smaller height) first. Earlier processing =>
  // smaller verticalBuffer => TOP arcs stay closer to nodes. This fixes the case where a
  // tiny node (e.g. `saved_filters_search ●`) shares y0 with a tall neighbor (e.g. `search ●`)
  // but its backlinks end up above due to group-size sorting.
  var orderedGroups = Object.keys(groups)
    .map(function(col) { return { col: +col, links: groups[col] }; })
    .sort(function(a, b) {
      // Max span ascending
      var maxDistA = 0;
      a.links.forEach(function(l) {
        var d = Math.abs(l.source.column - l.target.column);
        if (d > maxDistA) maxDistA = d;
      });
      var maxDistB = 0;
      b.links.forEach(function(l) {
        var d = Math.abs(l.source.column - l.target.column);
        if (d > maxDistB) maxDistB = d;
      });
      if (maxDistA !== maxDistB) return maxDistA - maxDistB;

      // TOP-only tie-breakers:
      // 1) Prefer groups whose targets are LOWER in the diagram first (larger min target.y0).
      //    Rationale: earlier processing => smaller verticalBuffer => TOP arcs stay closer to nodes
      //    (less escape upward). This prevents a lower target (e.g. `schedule ○`) from being pushed
      //    above neighboring bundles with the same maxSpan (e.g. col=4 `listing ○`/`filter` bundle).
      //
      // 2) If min target.y0 is the same, prefer smaller target height first.
      // NOTE: We compute this on the fly to avoid mutating group state.
      if (a.links.length && a.links[0].circularLinkType === "top") {
        function groupMinTargetY0AndHeight(links) {
          var minY0 = Infinity;
          var minHAtMinY0 = Infinity;
          links.forEach(function(l) {
            var t = l.target;
            if (!t || typeof t.y0 !== "number" || typeof t.y1 !== "number") return;
            var y0 = t.y0;
            var h = t.y1 - t.y0;
            if (y0 < minY0 - 1e-6) {
              minY0 = y0;
              minHAtMinY0 = h;
            } else if (Math.abs(y0 - minY0) < 1e-6) {
              minHAtMinY0 = Math.min(minHAtMinY0, h);
            }
          });
          if (minY0 === Infinity) minY0 = 0;
          if (minHAtMinY0 === Infinity) minHAtMinY0 = 0;
          return { minY0: minY0, minHAtMinY0: minHAtMinY0 };
        }
        var ma = groupMinTargetY0AndHeight(a.links);
        var mb = groupMinTargetY0AndHeight(b.links);
        // For TOP links: when maxSpan ties, prefer groups targeting columns more to the RIGHT first.
        // Earlier processing => smaller verticalBuffer => arcs stay closer to nodes (less escape upward).
        // This matches the requested ordering: backlinks into `schedule ○` (col 5) should sit below
        // backlinks into col 4 targets like `listing ○` and `filter` when maxSpan ties.
        if (a.col !== b.col) return b.col - a.col;
        if (Math.abs(ma.minY0 - mb.minY0) >= 1e-6) {
          // Descending: lower targets first
          return mb.minY0 - ma.minY0;
        }
        if (ma.minHAtMinY0 !== mb.minHAtMinY0) return ma.minHAtMinY0 - mb.minHAtMinY0;
      }

      // Then bigger groups first (stable packing)
      if (a.links.length !== b.links.length) {
        return b.links.length - a.links.length;
      }
      // Finally by column index
      return a.col - b.col;
    });

  // Flatten back to ordered links array
  var orderedLinks = [];
  orderedGroups.forEach(function(group) {
    orderedLinks = orderedLinks.concat(group.links);
  });

  // Process links in grouped order
  orderedLinks.forEach(function (link, i) {
    var buffer = 0;
    // NOTE: avoid using node names in non-debug logic; keep names only for optional debug output.
    var maxCause = null; // { j, prev, gap, offsetCorrection, bufferOver }
    // Optional: capture the full chain of pushes for post-mortem debugging.
    // Enabled only when link._debugCircular is set (to avoid perf impact / log noise).
    var pushCauses = dbg(link) ? [] : null;

    // Find current group
    var currentGroupIndex = orderedGroups.findIndex(function(g) {
      return g.col === link.target.column;
    });
    var currentGroup = orderedGroups[currentGroupIndex];
    var linkIndexInGroup = currentGroup.links.indexOf(link);

    if (selfLinking(link, id)) {
      // Keep self-loops inner: do not stack them downward; instead, later links will be pushed away.
      link.circularPathData.verticalBuffer = 0;
    } else {
      // Check collisions based on grouping:
      // - Within same group: only check previous links in same group (guarantees no crossings within group)
      // - Across groups: check all previous links (allows stacking between groups)
      for (var j = 0; j < i; j++) {
        var prevLink = orderedLinks[j];
        var prevGroupIndex = orderedGroups.findIndex(function(g) {
          return g.col === prevLink.target.column;
        });

        // If same group, only check if previous in group
        if (prevGroupIndex === currentGroupIndex) {
          if (currentGroup.links.indexOf(prevLink) >= linkIndexInGroup) {
            continue; // Skip if not previous in group
          }
        }
        // Different groups or valid same-group previous - check crossing

        if (circularLinksActuallyCross(link, prevLink)) {
          // Check if both links share at least one node (object identity preferred; fallback to name for safety).
          function sameNodeRef(a, b) {
            if (a === b) return true;
            if (a && b && a.name !== undefined && b.name !== undefined) return a.name === b.name;
            return false;
          }
          var sameNode = (
            sameNodeRef(link.source, prevLink.source) ||
            sameNodeRef(link.source, prevLink.target) ||
            sameNodeRef(link.target, prevLink.source) ||
            sameNodeRef(link.target, prevLink.target)
          );
          // Use no gap ONLY if both are self-links AND they share a node
          var gap = circularLinkGap;
          if (selfLinking(link, id) && selfLinking(prevLink, id) && sameNode) {
            gap = 0;
          }
          
          var bufferOverThisLink =
            prevLink.circularPathData.verticalBuffer +
            prevLink.width / 2 +
            gap;
          
          // Adjust buffer requirement based on vertical separation of effective base positions.
          // Effective base includes `baseOffset`, otherwise span-dependent baseOffset creates
          // artificial holes between links that are already correctly stacked by verticalBuffer.
          var thisBaseY = link.circularPathData.baseY;
          var prevBaseY = prevLink.circularPathData.baseY;
          // BaseOffset is precomputed for ALL circular links as `_baseOffsetForBuffer`.
          // Correct stacking (min-gap) is in terms of (baseOffset + verticalBuffer), not just verticalBuffer.
          // We still apply it carefully for TOP: only within the SAME target-node bundle (see below).
          var thisBaseOffset =
            (link.circularPathData &&
              typeof link.circularPathData._baseOffsetForBuffer === "number")
              ? link.circularPathData._baseOffsetForBuffer
              : 0;
          var prevBaseOffset =
            (prevLink.circularPathData &&
              typeof prevLink.circularPathData._baseOffsetForBuffer === "number")
              ? prevLink.circularPathData._baseOffsetForBuffer
              : 0;
          var thisEffectiveBase =
            (link.circularLinkType === "bottom") ? (thisBaseY + thisBaseOffset) : thisBaseY;
          var prevEffectiveBase =
            (prevLink.circularLinkType === "bottom") ? (prevBaseY + prevBaseOffset) : prevBaseY;
          var offsetCorrection = 0;
          var sameTargetNode = (link.target === prevLink.target);
          
          if (link.circularLinkType === "bottom") {
            // BaseOffset correction should ALWAYS apply (even within same target column),
            // because span-dependent baseOffset is what creates holes inside bundles.
            offsetCorrection = prevBaseOffset - thisBaseOffset;
            // BaseY correction:
            // - Across different target columns: always apply (global band alignment).
            // - Within the SAME target node: also apply, because their vertical legs land at the
            //   same node and are already separated by port ordering (y1). In this case, a large
            //   `baseY` separation should be allowed to reduce the required verticalBuffer; otherwise
            //   a "high" backlink (e.g. `search ◐→search ○`) can unnecessarily push a "low" backlink
            //   (e.g. `sosisa ○→search ○`) deeper, creating visible holes.
            // - Within the same target column but different target nodes: do NOT apply baseY here
            //   (can collapse spacing at the column entry and violate circularGap).
            if (link.target.column !== prevLink.target.column || sameTargetNode) {
              offsetCorrection += (prevBaseY - thisBaseY);
            }
          } else {
            // TOP links: only apply BaseY correction across different target columns.
            // Within the same target column, reducing buffer here can cause overlaps and
            // can invert the desired span nesting order.
            offsetCorrection = 0;
            if (link.target.column !== prevLink.target.column) {
              offsetCorrection = thisBaseY - prevBaseY;
            }
            // BUT within the SAME target NODE, baseOffset differences are pure "escape" and should
            // not create holes inside that bundle. Compensate so stacking uses (baseOffset+vBuf).
            if (sameTargetNode) {
              offsetCorrection += (prevBaseOffset - thisBaseOffset);
            }
          }
          // Clamp policy for offsetCorrection:
          // - TOP: generally only allow offsetCorrection to REDUCE buffer (negative),
          //   because positive corrections can create artificial "holes" between unrelated bundles.
          //   EXCEPTION: within the SAME target node, allow positive correction to preserve min-gaps.
          // - BOTTOM: allow positive correction ONLY across DIFFERENT target columns (different groups).
          //   Within the same target column, positive correction tends to "inherit" large baseY deltas
          //   from other links landing in that column (e.g. `search ◐→search ○` vs `sosisa ○→search ○`)
          //   and stretches arcs unnecessarily, breaking the desired early-closure/compact look.
          //   The pierce case we want to fix (`filter off→filter` vs `sosisa ●→schedule ○`) is cross-column,
          //   so this restriction still fixes the real geometry issue without global blow-ups.
          if (link.circularLinkType === "top" && !sameTargetNode) {
            if (offsetCorrection > 0) offsetCorrection = 0;
          } else if (link.circularLinkType === "bottom" && link.target.column === prevLink.target.column) {
            if (offsetCorrection > 0) offsetCorrection = 0;
          }

          // Safety cap: even when we allow a positive correction for BOTTOM cross-column interactions,
          // keep it bounded so we don't destroy "early closure" by pushing compact loops extremely deep.
          // (Observed regression: `search ◐→search ○` picking up ~140px correction from links into `search ◐`.)
          if (link.circularLinkType === "bottom" && offsetCorrection > 0) {
            // Use a small absolute cap, but allow slightly more on very tall diagrams.
            var maxPositiveOffsetCorrection = Math.max(24, diagramHeight * 0.02);
            if (offsetCorrection > maxPositiveOffsetCorrection) {
              offsetCorrection = maxPositiveOffsetCorrection;
            }
          }
          
          bufferOverThisLink += offsetCorrection;
          
          if (bufferOverThisLink > buffer) {
            buffer = bufferOverThisLink;
            maxCause = { j: j, prev: prevLink, gap: gap, offsetCorrection: offsetCorrection, bufferOver: bufferOverThisLink };
            if (pushCauses) {
              pushCauses.push({
                prev: nameOf(prevLink),
                j: j,
                gap: gap,
                offsetCorrection: offsetCorrection,
                prevVB: prevLink.circularPathData.verticalBuffer,
                prevW: prevLink.width,
                thisBaseY: link.circularPathData.baseY,
                prevBaseY: prevLink.circularPathData.baseY,
                bufferOver: +bufferOverThisLink.toFixed(2),
              });
            }
          }
          if (dbg(link) || dbg(prevLink)) {
            console.log(
              "[circular/vBuf] link",
              nameOf(link),
              "crosses",
              nameOf(prevLink),
              {
                gap: gap,
                offsetCorrection: offsetCorrection,
                prevVB: prevLink.circularPathData.verticalBuffer,
                prevW: prevLink.width,
                baseY: link.circularPathData.baseY,
                prevBaseY: prevLink.circularPathData.baseY,
                bufferOver: +bufferOverThisLink.toFixed(2),
              }
            );
          }
        }
      }

      var finalBuffer = buffer + link.width / 2;
      // NO cap for regular backlinks here - they need proper stacking.
      // Height control is done in addCircularPathData via baseOffset caps.
      link.circularPathData.verticalBuffer = finalBuffer;
      if (dbg(link)) {
        // Store for programmatic inspection (e.g. from node scripts) without scraping console.
        link.circularPathData._debugPushCauses = pushCauses;
        console.log(
          "[circular/vBuf] FINAL",
          nameOf(link),
          {
            vBuf: +link.circularPathData.verticalBuffer.toFixed(2),
            baseY: link.circularPathData.baseY,
            groupMinY: link.circularPathData.groupMinY,
            groupMaxY: link.circularPathData.groupMaxY,
            maxCause: maxCause
              ? {
                  prev: nameOf(maxCause.prev),
                  j: maxCause.j,
                  gap: maxCause.gap,
                  offsetCorrection: maxCause.offsetCorrection,
                  bufferOver: +maxCause.bufferOver.toFixed(2),
                }
              : null,
            pushes: pushCauses ? pushCauses.length : 0,
          }
        );
      }
    }
  });

  // Post-pass (BOTTOM only): enforce minimum vertical separation for links that share the SAME TARGET NODE.
  //
  // Why: In some configurations, two backlinks into the same node can end up on the same horizontal
  // "shelf" (same verticalFullExtent) despite overlapping in X. This is visually wrong and violates
  // the intended circularGap separation. The most common repro is `schedule ○→filter` vs `filter off→filter`.
  //
  // We do this using the effective shelf equation (bottom):
  //   shelfY = baseY + _baseOffsetForBuffer + verticalBuffer
  // and require that adjacent shelves differ by at least:
  //   gap + (prevWidth/2) + (currWidth/2)
  if (orderedLinks.length && orderedLinks[0].circularLinkType === "bottom") {
    var byTarget = {};
    orderedLinks.forEach(function(l) {
      if (!l || !l.circularPathData) return;
      if (selfLinking(l, id)) return; // self-loops stay inner; they create separation via other links' pushes
      var k = null;
      try { k = String(id(l.target)); } catch (e) { k = (l.target && l.target.name) ? String(l.target.name) : null; }
      if (!k) return;
      if (!byTarget[k]) byTarget[k] = [];
      byTarget[k].push(l);
    });

    Object.keys(byTarget).forEach(function(k) {
      var arr = byTarget[k];
      if (!arr || arr.length < 2) return;

      function baseOf(l) {
        var c = l.circularPathData;
        var baseY = typeof c.baseY === "number" ? c.baseY : 0;
        var baseOffset = (typeof c._baseOffsetForBuffer === "number") ? c._baseOffsetForBuffer : (typeof c.baseOffset === "number" ? c.baseOffset : 0);
        return baseY + baseOffset;
      }
      function shelfOf(l) {
        return baseOf(l) + (l.circularPathData.verticalBuffer || 0);
      }

      // Sort by current shelf (inner-to-outer), tie-break by source position for stability.
      arr.sort(function(a, b) {
        var da = shelfOf(a);
        var db = shelfOf(b);
        if (Math.abs(da - db) >= 1e-6) return da - db;
        var aSrc = (a.source && typeof a.source.y0 === "number" && typeof a.source.y1 === "number") ? (a.source.y0 + a.source.y1) / 2 : 0;
        var bSrc = (b.source && typeof b.source.y0 === "number" && typeof b.source.y1 === "number") ? (b.source.y0 + b.source.y1) / 2 : 0;
        if (Math.abs(aSrc - bSrc) >= 1e-6) return aSrc - bSrc;
        return (a.circularLinkID || 0) - (b.circularLinkID || 0) || (a.index - b.index);
      });

      for (var ii = 1; ii < arr.length; ii++) {
        var prev = arr[ii - 1];
        var curr = arr[ii];
        var prevBase = baseOf(prev);
        var currBase = baseOf(curr);
        var prevVB = prev.circularPathData.verticalBuffer || 0;
        var currVB = curr.circularPathData.verticalBuffer || 0;
        var prevHalf = (prev.width || 0) / 2;
        var currHalf = (curr.width || 0) / 2;
        var needShelf = (prevBase + prevVB) + circularLinkGap + currHalf;
        var needVB = needShelf - currBase;
        if (needVB > currVB) {
          curr.circularPathData.verticalBuffer = needVB;
        }
      }
    });
  }

  return orderedLinks;
}

// Links cross only if their horizontal ranges overlap AND they share a column
function circularLinksActuallyCross(link1, link2) {
  var link1Source = link1.source.column;
  var link1Target = link1.target.column;
  var link2Source = link2.source.column;
  var link2Target = link2.target.column;

  // Helper: true self-loop means same node (not just same column)
  var link1SelfLoop = (link1.source === link1.target) ||
                      (link1.source && link1.target && link1.source.name === link1.target.name);
  var link2SelfLoop = (link2.source === link2.target) ||
                      (link2.source && link2.target && link2.source.name === link2.target.name);

  // Helper: do links share at least one node (object identity preferred; fallback to name)
  function sameNode(a, b) {
    if (a === b) return true;
    if (a && b && a.name !== undefined && b.name !== undefined) return a.name === b.name;
    return false;
  }
  var shareNode =
    sameNode(link1.source, link2.source) ||
    sameNode(link1.source, link2.target) ||
    sameNode(link1.target, link2.source) ||
    sameNode(link1.target, link2.target);
  
  // Special case: "zero-span" (source.column === target.column) but NOT self-link
  // (source node !== target node). These are very compact local loops.
  //
  // Key point: they should NOT be forced to stack against every link that merely has an
  // endpoint in this column. In practice, a zero-span non-self link only meaningfully
  // interacts with links that share the SAME endpoint node (same source node => right side,
  // same target node => left side) or with true self-loops in this column.
  var link1ZeroSpanNonSelf =
    link1Source === link1Target && link1.source !== link1.target;
  var link2ZeroSpanNonSelf =
    link2Source === link2Target && link2.source !== link2.target;

  if (link1ZeroSpanNonSelf) {
    var col = link1Source;
    if (!(link2Source === col || link2Target === col)) return false;
    // If link2 doesn't share a node with the zero-span link AND is not a self-loop,
    // treat it as non-crossing. This prevents large, unnecessary verticalBuffer stacking
    // between unrelated same-column cycles and long links in the same column.
    if (!shareNode && !link2SelfLoop) return false;
    // If they only share a node in an opposite-side way (one's source is the other's target),
    // they generally don't intersect: one is leaving the node (right side) while the other is entering (left side).
    // Keep them unstacked to avoid large vertical holes.
    if (shareNode && !link2SelfLoop) {
      var sameSideShare =
        sameNode(link1.source, link2.source) || sameNode(link1.target, link2.target);
      if (!sameSideShare) return false;
    }
  }
  if (link2ZeroSpanNonSelf) {
    var col2 = link2Source;
    if (!(link1Source === col2 || link1Target === col2)) return false;
    if (!shareNode && !link1SelfLoop) return false;
    if (shareNode && !link1SelfLoop) {
      var sameSideShare2 =
        sameNode(link2.source, link1.source) || sameNode(link2.target, link1.target);
      if (!sameSideShare2) return false;
    }
  }

  // Calculate horizontal ranges
  var link1Min = Math.min(link1Source, link1Target);
  var link1Max = Math.max(link1Source, link1Target);
  var link2Min = Math.min(link2Source, link2Target);
  var link2Max = Math.max(link2Source, link2Target);
  
  // First check: do horizontal ranges overlap or touch at boundary?
  // If ranges don't overlap at all, links can be at same Y level without crossing
  var rangesOverlap = link1Max >= link2Min && link2Max >= link1Min;
  
  if (!rangesOverlap) {
    // If column ranges don't overlap at all, these links cannot cross:
    // their horizontal segments live in disjoint column spans, so stacking them globally
    // (just because both are TOP or both are BOTTOM) creates unnecessary "holes".
    return false;
  }
  
  // Ranges overlap - check for specific crossing conditions
  
  // Same TARGET NODE: stack (they share the same endpoint and can overlap near the node).
  if (sameNode(link1.target, link2.target)) return true;

  // NOTE: we intentionally do NOT auto-stack merely because target *column* matches.
  // However, we also must not early-return false here: links targeting different nodes in
  // the same column can still geometrically overlap (nested spans, shared leg columns, etc),
  // and in that case we still need verticalBuffer + circularGap to prevent visual overlap.

  // Same SOURCE column = right vertical segments would overlap at source.
  // This is a common cause of "double-crossing" (links swap order near the source,
  // then swap back near the target). If both links share the same source column,
  // they must be stacked unless it's an unrelated self-loop that can be nested locally.
  var sameSource = (link1Source === link2Source);
  if (sameSource) {
    // Allow two unrelated self-loop bubbles to be nested by radii.
    // IMPORTANT: this exception is ONLY valid when BOTH links are self-loops.
    // If only one link is a self-loop, it can still be intersected by the other link's
    // right vertical leg / shoulder region in the same source column (even if nodes differ),
    // so we must stack them.
    if ((link1SelfLoop && link2SelfLoop) && !shareNode) {
      // fall through
    } else {
      return true;
    }
  }

  // Self-link handling:
  // NOTE: self-link means "same node", not merely "same column".
  // Column-equality is common for compact circulars and must NOT be treated as a self-loop.
  var link1Self = link1SelfLoop;
  var link2Self = link2SelfLoop;
  
  if (link1Self || link2Self) {
    // A self-loop's "bubble" lives at its node position. It can ONLY be intersected by circular
    // links that SHARE THE SAME NODE (enter or exit from the same node).
    //
    // Previously we stacked self-loops against ALL links with an endpoint in the same column,
    // but that caused self-loops to accumulate huge verticalBuffer values when sharing a column
    // with other nodes (e.g. filter, autosearch, listing ○ in the same column).
    //
    // A self-loop physically only occupies space near its own node, so it should only stack
    // against links that actually share that node.
    if (shareNode) return true;
    return false;
  }

  // Boundary-touch overlap:
  // If the column ranges only TOUCH at a boundary (e.g. [2,5] and [5,7]) and BOTH links
  // have an endpoint at that boundary column, their vertical legs/arc buffers can overlap
  // visually. This is a common source of "bundle groups overlapping" and should be stacked,
  // but only in this narrow boundary-touch case (avoids the old over-aggressive stacking).
  var overlapStart = Math.max(link1Min, link2Min);
  var overlapEnd = Math.min(link1Max, link2Max);
  if (overlapStart === overlapEnd) {
    var c = overlapStart;
    var link1HasEndpointAt = (link1Source === c || link1Target === c);
    var link2HasEndpointAt = (link2Source === c || link2Target === c);
    if (link1HasEndpointAt && link2HasEndpointAt) {
      // Boundary-touch handling:
      // For TOP links, we keep the looser behavior: treat any endpoint-touch as potentially crossing.
      // This helps avoid bundle overlaps near dense hubs.
      //
      // For BOTTOM links, we want a compromise:
      // - short-span circulars often need stacking even on boundary-touch, otherwise they can end up
      //   sharing the same horizontal "shelf" (same verticalFullExtent) and visibly overlap
      //   (e.g. `schedule ○→filter` overlapping `listing ○→search ●`).
      // - long-span circulars are sometimes nicer if they stay compact and simply cross a short-span
      //   backlink at the boundary (user preference for "early closure", e.g. `sosisa ●→schedule ○`
      //   crossing backlinks into `filter`).
      //
      // Rule: for BOTTOM, we only allow the *opposite-side* boundary-touch case (one touches as source,
      // other as target) to be NON-crossing when at least one link has a long span (>= 3 columns).
      if (link1.circularLinkType === "bottom") {
        var bothSources = (link1Source === c && link2Source === c);
        var bothTargets = (link1Target === c && link2Target === c);
        if (bothSources || bothTargets) return true;
        var span1 = Math.abs(link1Source - link1Target);
        var span2 = Math.abs(link2Source - link2Target);
        var allowCrossWithoutStack = (Math.max(span1, span2) >= 3);
        return !allowCrossWithoutStack;
      }
      return true;
    }
  }

  // For non-self links with overlapping ranges, we only need stacking if a vertical
  // "leg" column of one link lies strictly INSIDE the other link's horizontal span.
  // This is the real condition for a vertical segment intersecting a horizontal segment.
  // (If they only overlap by range but all endpoints are outside, they can be nested
  // by radii without needing extra vertical separation.)
  function inside(col, min, max) {
    return col > min && col < max;
  }
  if (
    inside(link1Source, link2Min, link2Max) ||
    inside(link1Target, link2Min, link2Max) ||
    inside(link2Source, link1Min, link1Max) ||
    inside(link2Target, link1Min, link1Max)
  ) {
    return true;
  }
  
  // With proper span-distance sorting, other crossings (vertical inside range) don't occur:
  // - Shorter span is processed first (higher, smaller vBuf)
  // - Its vertical segments end above the longer span's horizontal
  // - So no actual visual crossing happens
  
  return false;
}

// create a d path using the addCircularPathData
// create a d path using the addCircularPathData
function createCircularPathString(link) {
  var pathString = "";

  if (link.circularLinkType == "top") {
    pathString =
      // start at the left of the source node
      "M" +
      link.circularPathData.sourceX +
      " " +
      link.circularPathData.sourceY +
      " " +
      // line left to buffer point
      "L" +
      link.circularPathData.rightInnerExtent +
      " " +
      link.circularPathData.sourceY +
      " " +
      // Arc around: Centre of arc X and  //Centre of arc Y
      "A" +
      link.circularPathData.rightLargeArcRadius +
      " " +
      link.circularPathData.rightSmallArcRadius +
      " 0 0 0 " +
      // End of arc X //End of arc Y
      link.circularPathData.rightFullExtent +
      " " +
      (link.circularPathData.sourceY -
        link.circularPathData.rightSmallArcRadius) +
      " " + // End of arc X
      // line up to buffer point
      "L" +
      link.circularPathData.rightFullExtent +
      " " +
      link.circularPathData.verticalRightInnerExtent +
      " " +
      // Arc around: Centre of arc X and  //Centre of arc Y
      "A" +
      link.circularPathData.rightLargeArcRadius +
      " " +
      link.circularPathData.rightLargeArcRadius +
      " 0 0 0 " +
      // End of arc X //End of arc Y
      link.circularPathData.rightInnerExtent +
      " " +
      link.circularPathData.verticalFullExtent +
      " " + // End of arc X
      // line right to buffer point
      "L" +
      link.circularPathData.leftInnerExtent +
      " " +
      link.circularPathData.verticalFullExtent +
      " " +
      // Arc around: Centre of arc X and  //Centre of arc Y
      "A" +
      link.circularPathData.leftLargeArcRadius +
      " " +
      link.circularPathData.leftLargeArcRadius +
      " 0 0 0 " +
      // End of arc X //End of arc Y
      link.circularPathData.leftFullExtent +
      " " +
      link.circularPathData.verticalLeftInnerExtent +
      " " + // End of arc X
      // line down
      "L" +
      link.circularPathData.leftFullExtent +
      " " +
      (link.circularPathData.targetY -
        link.circularPathData.leftSmallArcRadius) +
      " " +
      // Arc around: Centre of arc X and  //Centre of arc Y
      "A" +
      link.circularPathData.leftLargeArcRadius +
      " " +
      link.circularPathData.leftSmallArcRadius +
      " 0 0 0 " +
      // End of arc X //End of arc Y
      link.circularPathData.leftInnerExtent +
      " " +
      link.circularPathData.targetY +
      " " + // End of arc X
      // line to end
      "L" +
      link.circularPathData.targetX +
      " " +
      link.circularPathData.targetY;
  } else {
    // bottom path
    pathString =
      // start at the left of the source node
      "M" +
      link.circularPathData.sourceX +
      " " +
      link.circularPathData.sourceY +
      " " +
      // line left to buffer point
      "L" +
      link.circularPathData.rightInnerExtent +
      " " +
      link.circularPathData.sourceY +
      " " +
      // Arc around: Centre of arc X and  //Centre of arc Y
      "A" +
      link.circularPathData.rightLargeArcRadius +
      " " +
      link.circularPathData.rightSmallArcRadius +
      " 0 0 1 " +
      // End of arc X //End of arc Y
      link.circularPathData.rightFullExtent +
      " " +
      (link.circularPathData.sourceY +
        link.circularPathData.rightSmallArcRadius) +
      " " + // End of arc X
      // line down to buffer point
      "L" +
      link.circularPathData.rightFullExtent +
      " " +
      link.circularPathData.verticalRightInnerExtent +
      " " +
      // Arc around: Centre of arc X and  //Centre of arc Y
      "A" +
      link.circularPathData.rightLargeArcRadius +
      " " +
      link.circularPathData.rightLargeArcRadius +
      " 0 0 1 " +
      // End of arc X //End of arc Y
      link.circularPathData.rightInnerExtent +
      " " +
      link.circularPathData.verticalFullExtent +
      " " + // End of arc X
      // line right to buffer point
      "L" +
      link.circularPathData.leftInnerExtent +
      " " +
      link.circularPathData.verticalFullExtent +
      " " +
      // Arc around: Centre of arc X and  //Centre of arc Y
      "A" +
      link.circularPathData.leftLargeArcRadius +
      " " +
      link.circularPathData.leftLargeArcRadius +
      " 0 0 1 " +
      // End of arc X //End of arc Y
      link.circularPathData.leftFullExtent +
      " " +
      link.circularPathData.verticalLeftInnerExtent +
      " " + // End of arc X
      // line up
      "L" +
      link.circularPathData.leftFullExtent +
      " " +
      (link.circularPathData.targetY +
        link.circularPathData.leftSmallArcRadius) +
      " " +
      // Arc around: Centre of arc X and  //Centre of arc Y
      "A" +
      link.circularPathData.leftLargeArcRadius +
      " " +
      link.circularPathData.leftSmallArcRadius +
      " 0 0 1 " +
      // End of arc X //End of arc Y
      link.circularPathData.leftInnerExtent +
      " " +
      link.circularPathData.targetY +
      " " + // End of arc X
      // line to end
      "L" +
      link.circularPathData.targetX +
      " " +
      link.circularPathData.targetY;
  }

  return pathString;
}

function getLinkBaseY(link, nodes, type) {
  // Find min/max Y of REAL nodes between source and target columns
  // Exclude virtual nodes
  var relevantMinY = Math.min(link.source.y0, link.target.y0);
  var relevantMaxY = Math.max(link.source.y1, link.target.y1);
  
  nodes.forEach(function(node) {
    if (node.virtual || (node.name && node.name.indexOf('virtualNode') === 0)) {
      return;
    }
    if (node.column >= Math.min(link.source.column, link.target.column) && 
        node.column <= Math.max(link.source.column, link.target.column)) {
      if (node.y0 < relevantMinY) relevantMinY = node.y0;
      if (node.y1 > relevantMaxY) relevantMaxY = node.y1;
    }
  });
  
  return type === "bottom" ? relevantMaxY : relevantMinY;
}

// Returns both minY and maxY extents of REAL nodes in the link's spanned columns.
// For self-loops (source === target), we ONLY use the node's own extents,
// NOT the whole column, so self-loops stay compact near their node.
function getLinkBaseExtents(link, nodes) {
  var relevantMinY = Math.min(link.source.y0, link.target.y0);
  var relevantMaxY = Math.max(link.source.y1, link.target.y1);

  // Self-loop check: source and target are the same node (by object or by name).
  var isSelfLoop = (link.source === link.target) ||
    (link.source && link.target && 
     link.source.name !== undefined && link.target.name !== undefined &&
     link.source.name === link.target.name);

  // For self-loops, don't scan other nodes - keep baseY close to the node itself.
  if (isSelfLoop) {
    return { minY: relevantMinY, maxY: relevantMaxY };
  }

  nodes.forEach(function(node) {
    if (node.virtual || (node.name && node.name.indexOf('virtualNode') === 0)) {
      return;
    }
    if (node.column >= Math.min(link.source.column, link.target.column) && 
        node.column <= Math.max(link.source.column, link.target.column)) {
      if (node.y0 < relevantMinY) relevantMinY = node.y0;
      if (node.y1 > relevantMaxY) relevantMaxY = node.y1;
    }
  });

  return { minY: relevantMinY, maxY: relevantMaxY };
}
