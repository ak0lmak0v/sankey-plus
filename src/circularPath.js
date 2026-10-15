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
  verticalMargin,
  compactFinalBacklinks = false,
  compactSourceTurns = false
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
        // so the loop doesn't collapse into the node stroke or its own label.
        // NOTE: "closer to node" means smaller verticalFullExtent for bottom loops (and larger for top loops).
        var minSelfLoopMargin = Math.max(12, selfLinkRadius + 4);
        var minSelfLoopLabelHeight = Math.max(28, link.width + 18);
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
          if (link.circularPathData.verticalFullExtent < link.circularPathData.sourceY + minSelfLoopLabelHeight) {
            link.circularPathData.verticalFullExtent = link.circularPathData.sourceY + minSelfLoopLabelHeight;
          }
          link.circularPathData.verticalRightInnerExtent =
            link.circularPathData.verticalFullExtent - selfLinkRadius;
          link.circularPathData.verticalLeftInnerExtent =
            link.circularPathData.verticalFullExtent - selfLinkRadius;
        } else {
          // top links
          link.circularPathData.verticalFullExtent =
            extMinY - selfLinkMargin - vBuf;
          if (link.circularPathData.verticalFullExtent > link.circularPathData.sourceY - minSelfLoopLabelHeight) {
            link.circularPathData.verticalFullExtent = link.circularPathData.sourceY - minSelfLoopLabelHeight;
          }
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
        // Group by target node identity so each target node gets its own
        // radius stack. Self-loops are excluded so they don't inflate the
        // budget for other links.
        thisColumn = link.target.column;
        var linkIsSelfLoop = selfLinking(link, id);
        sameColumnLinks = graph.links.filter(function (l) {
          if (!(l && l.circular && l.circularLinkType == thisCircularLinkType)) return false;
          if (!linkIsSelfLoop && selfLinking(l, id)) return false;
          return id(l.target) === id(link.target);
        });
        // Sort: span ASC within target node, source CY tiebreaker.
        sameColumnLinks.sort(function(a, b) {
          var aTgtY0 = a.target && typeof a.target.y0 === "number" ? a.target.y0 : 0;
          var bTgtY0 = b.target && typeof b.target.y0 === "number" ? b.target.y0 : 0;
          var aIsBottomBacklink =
            a.circularLinkType === "bottom" && (a.target.column || 0) < (a.source.column || 0);
          var bIsBottomBacklink =
            b.circularLinkType === "bottom" && (b.target.column || 0) < (b.source.column || 0);
          if (aIsBottomBacklink && bIsBottomBacklink) {
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

          var sameTargetNode = (a.target === b.target);
          var ad = Math.abs((a.source.column || 0) - (a.target.column || 0));
          var bd = Math.abs((b.source.column || 0) - (b.target.column || 0));
          if (aIsBottomBacklink && bIsBottomBacklink && sameTargetNode) {
            if (ad !== bd) return ad - bd;
            var aSrcY = (a.source.y0 + a.source.y1) / 2;
            var bSrcY = (b.source.y0 + b.source.y1) / 2;
            if (Math.abs(aSrcY - bSrcY) >= 1e-6) return bSrcY - aSrcY;
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
          // Enforce leg floors: VFE must be below both source and target
          // attachments + arc radii so both vertical legs point upward.
          if (!selfLinking(link, id)) {
            var bRightFloor = link.circularPathData.sourceY +
              link.circularPathData.rightSmallArcRadius +
              link.circularPathData.rightLargeArcRadius + 1e-6;
            var bLeftFloor = link.circularPathData.targetY +
              link.circularPathData.leftSmallArcRadius +
              link.circularPathData.leftLargeArcRadius + 1e-6;
            var bFloor = Math.max(bRightFloor, bLeftFloor);
            if (link.circularPathData.verticalFullExtent < bFloor) {
              link.circularPathData.verticalFullExtent = bFloor;
            }
          }
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
          // Enforce leg ceilings: VFE must be above both source and target
          // attachments - arc radii so both vertical legs point downward.
          if (!selfLinking(link, id)) {
            var tRightCeiling = link.circularPathData.sourceY -
              link.circularPathData.rightSmallArcRadius -
              link.circularPathData.rightLargeArcRadius - 1e-6;
            var tLeftCeiling = link.circularPathData.targetY -
              link.circularPathData.leftSmallArcRadius -
              link.circularPathData.leftLargeArcRadius - 1e-6;
            var tCeiling = Math.min(tRightCeiling, tLeftCeiling);
            if (link.circularPathData.verticalFullExtent > tCeiling) {
              link.circularPathData.verticalFullExtent = tCeiling;
            }
          }
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
          if (selfLinking(curr, id) && !selfLinking(prev, id)) {
            var desiredPrevRfe =
              curr.circularPathData.rightFullExtent + (prevW + currW) / 2 + required + 1e-6;
            var prevDelta = desiredPrevRfe - prev.circularPathData.rightFullExtent;
            if (prevDelta > 1e-6) {
              prev.circularPathData.rightLargeArcRadius += prevDelta;
              if (typeof prev.circularPathData.rightSmallArcRadius === "number") {
                prev.circularPathData.rightSmallArcRadius += prevDelta;
                if (prev.circularPathData.rightSmallArcRadius > prev.circularPathData.rightLargeArcRadius) {
                  prev.circularPathData.rightSmallArcRadius = prev.circularPathData.rightLargeArcRadius;
                }
              }
              prev.circularPathData.rightFullExtent =
                prev.circularPathData.sourceX +
                prev.circularPathData.rightLargeArcRadius +
                (prev.circularPathData.rightNodeBuffer || 0);
              rightChanged = true;
            }
            continue;
          }
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
        //
        // Only applied within the same span — cross-span pairs should keep the initial
        // span-based ordering (shorter span = more inner).
        var prevSpanSS = Math.abs((prev.source && prev.source.column || 0) - (prev.target && prev.target.column || 0));
        var currSpanSS = Math.abs((curr.source && curr.source.column || 0) - (curr.target && curr.target.column || 0));
        if (sameSourceNode && prev.circularLinkType === "bottom" && curr.circularLinkType === "bottom" && prevSpanSS === currSpanSS) {
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

  // Final right-leg overlap enforcement for same-source-node pairs.
  //
  // The cross-band pass can push links from the same source node into overlap
  // when they have different spans (e.g. span=0 and span=3), because its
  // span-based sort makes such pairs non-adjacent. This targeted pass checks
  // only same-source-node links (grouped per source node + band) using current
  // RFE values.
  (function finalRightLegOverlap() {
    var rightFinalGroups = {};
    graph.links.forEach(function(l) {
      if (!l || !l.circular || l.isVirtual) return;
      if (!l.circularPathData) return;
      if (typeof l.circularPathData.rightLargeArcRadius !== "number") return;
      if (selfLinking(l, id)) return;
      var srcId = l.source ? id(l.source) : null;
      if (!srcId) return;
      var key = String(srcId) + "|" + String(l.circularLinkType);
      if (!rightFinalGroups[key]) rightFinalGroups[key] = [];
      rightFinalGroups[key].push(l);
    });

    Object.keys(rightFinalGroups).forEach(function(grpKey) {
      var group = rightFinalGroups[grpKey];
      if (group.length < 2) return;

      var maxIters = 10;
      for (var it = 0; it < maxIters; it++) {
        var anyChange = false;

        group.sort(function(a, b) {
          var aSelf = selfLinking(a, id);
          var bSelf = selfLinking(b, id);
          if (aSelf !== bSelf) return aSelf ? -1 : 1;
          var ar = a.circularPathData.rightFullExtent;
          var br = b.circularPathData.rightFullExtent;
          if (ar !== br) return ar - br;
          return (a.circularLinkID || 0) - (b.circularLinkID || 0);
        });

        for (var i = 1; i < group.length; i++) {
          var prev = group[i - 1];
          var curr = group[i];

          var pC = prev.circularPathData;
          var cC = curr.circularPathData;

          var prevW = prev.width || 0;
          var currW = curr.width || 0;
          var prevRight = pC.rightFullExtent + prevW / 2;
          var currLeft = cC.rightFullExtent - currW / 2;
          var gap = currLeft - prevRight;
          var req = circularLinkGap || 0;

          if (gap < req) {
            var delta = req - gap + 1e-6;
            cC.rightLargeArcRadius += delta;
            if (typeof cC.rightSmallArcRadius === "number") {
              cC.rightSmallArcRadius += delta;
              if (cC.rightSmallArcRadius > cC.rightLargeArcRadius) {
                cC.rightSmallArcRadius = cC.rightLargeArcRadius;
              }
            }
            cC.rightFullExtent =
              cC.sourceX + cC.rightLargeArcRadius + (cC.rightNodeBuffer || 0);
            anyChange = true;
          }
        }

        if (!anyChange) break;
      }
    });
  })();

  // Restore span-based right-leg ordering for same-source-node pairs.
  //
  // The cross-band pass may push a shorter-span link past a longer-span
  // same-band neighbor, inverting the expected ordering. Fix by swapping
  // rightLargeArcRadius / rightSmallArcRadius between the inverted pair
  // and re-compacting.
  (function enforceRightLegSpanOrderSameNode() {
    var bySourceBand = {};
    graph.links.forEach(function(l) {
      if (!l || !l.circular || l.isVirtual) return;
      if (!l.circularPathData) return;
      if (selfLinking(l, id)) return;
      if (typeof l.circularPathData.rightLargeArcRadius !== "number") return;
      var srcId = l.source ? id(l.source) : null;
      if (!srcId) return;
      var key = String(srcId) + "|" + String(l.circularLinkType);
      if (!bySourceBand[key]) bySourceBand[key] = [];
      bySourceBand[key].push(l);
    });

    Object.keys(bySourceBand).forEach(function(k) {
      var grp = bySourceBand[k];
      if (grp.length < 2) return;

      grp.sort(function(a, b) {
        return a.circularPathData.rightFullExtent - b.circularPathData.rightFullExtent;
      });

      for (var i = 0; i < grp.length - 1; i++) {
        var inner = grp[i];
        var outer = grp[i + 1];
        var spanInner = Math.abs((inner.source.column || 0) - (inner.target.column || 0));
        var spanOuter = Math.abs((outer.source.column || 0) - (outer.target.column || 0));
        if (spanInner <= spanOuter) continue;

        var iC = inner.circularPathData;
        var oC = outer.circularPathData;
        var tmpR = iC.rightLargeArcRadius;
        var tmpS = iC.rightSmallArcRadius;
        iC.rightLargeArcRadius = oC.rightLargeArcRadius;
        iC.rightSmallArcRadius = oC.rightSmallArcRadius;
        oC.rightLargeArcRadius = tmpR;
        oC.rightSmallArcRadius = tmpS;
        iC.rightFullExtent = iC.sourceX + iC.rightLargeArcRadius + (iC.rightNodeBuffer || 0);
        oC.rightFullExtent = oC.sourceX + oC.rightLargeArcRadius + (oC.rightNodeBuffer || 0);
      }

      grp.sort(function(a, b) {
        return a.circularPathData.rightFullExtent - b.circularPathData.rightFullExtent;
      });
      var gap = circularLinkGap || 0;
      for (var i = 1; i < grp.length; i++) {
        var prev = grp[i - 1];
        var curr = grp[i];
        var pC = prev.circularPathData;
        var cC = curr.circularPathData;
        var prevRight = pC.rightFullExtent + (prev.width || 0) / 2;
        var currLeft = cC.rightFullExtent - (curr.width || 0) / 2;
        var g = currLeft - prevRight;
        if (g < gap) {
          var delta = gap - g + 1e-6;
          cC.rightLargeArcRadius += delta;
          if (typeof cC.rightSmallArcRadius === "number") {
            cC.rightSmallArcRadius += delta;
            if (cC.rightSmallArcRadius > cC.rightLargeArcRadius) {
              cC.rightSmallArcRadius = cC.rightLargeArcRadius;
            }
          }
          cC.rightFullExtent = cC.sourceX + cC.rightLargeArcRadius + (cC.rightNodeBuffer || 0);
        }
      }
    });
  })();

  // Re-run within-band right-leg clearance after cross-band and same-source-node passes.
  //
  // The cross-band pass can push a link outward (increase its rfe), creating overlap with
  // same-band neighbors that the earlier within-band pass had already resolved. Because
  // the cross-band pass compares only consecutive pairs (sorted by span/rfe across bands),
  // a TOP link sitting between two BOTTOM links can mask the overlap.
  //
  // This pass re-checks same-band pairs with current rfe values and fixes any residual overlap.
  (function postCrossBandWithinBandClearance() {
    var wbGroups = {};
    graph.links.forEach(function(l) {
      if (!l || !l.circular || l.isVirtual) return;
      if (!l.circularPathData) return;
      if (typeof l.circularPathData.rightLargeArcRadius !== "number") return;
      var sourceKey =
        l.source && typeof l.source.column === "number"
          ? String(l.source.column)
          : String(Math.round((l.circularPathData.sourceX || 0) * 10) / 10);
      var key = sourceKey + "|" + String(l.circularLinkType);
      if (!wbGroups[key]) wbGroups[key] = [];
      wbGroups[key].push(l);
    });

    function rightLegOverlapAmount(a, b) {
      var ac = a.circularPathData;
      var bc = b.circularPathData;
      var aMin = Math.min(ac.sourceY, ac.verticalRightInnerExtent);
      var aMax = Math.max(ac.sourceY, ac.verticalRightInnerExtent);
      var bMin = Math.min(bc.sourceY, bc.verticalRightInnerExtent);
      var bMax = Math.max(bc.sourceY, bc.verticalRightInnerExtent);
      return Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
    }

    Object.keys(wbGroups).forEach(function(k) {
      var group = wbGroups[k];
      if (group.length < 2) return;

      var maxIters = 15;
      for (var it = 0; it < maxIters; it++) {
        var changed = false;

        group.sort(function(a, b) {
          var ar = a.circularPathData.rightFullExtent;
          var br = b.circularPathData.rightFullExtent;
          if (ar !== br) return ar - br;
          var ad = Math.abs((a.source && a.source.column || 0) - (a.target && a.target.column || 0));
          var bd = Math.abs((b.source && b.source.column || 0) - (b.target && b.target.column || 0));
          if (ad !== bd) return ad - bd;
          return (a.circularLinkID || 0) - (b.circularLinkID || 0);
        });

        for (var i = 1; i < group.length; i++) {
          var prev = group[i - 1];
          var curr = group[i];

          var pC = prev.circularPathData;
          var cC = curr.circularPathData;

          var prevW = prev.width || 0;
          var currW = curr.width || 0;
          var prevRight = pC.rightFullExtent + prevW / 2;
          var currLeft = cC.rightFullExtent - currW / 2;
          var gap = currLeft - prevRight;
          var required = circularLinkGap || 0;
          var vOverlap = rightLegOverlapAmount(prev, curr);

          if (vOverlap > 1e-6 && gap < required) {
            var delta = required - gap + 1e-6;
            if (selfLinking(curr, id) && !selfLinking(prev, id)) {
              var desiredPrevRfe =
                cC.rightFullExtent + (prevW + currW) / 2 + required + 1e-6;
              var prevDelta = desiredPrevRfe - pC.rightFullExtent;
              if (prevDelta > 1e-6) {
                pC.rightLargeArcRadius += prevDelta;
                if (typeof pC.rightSmallArcRadius === "number") {
                  pC.rightSmallArcRadius += prevDelta;
                  if (pC.rightSmallArcRadius > pC.rightLargeArcRadius) {
                    pC.rightSmallArcRadius = pC.rightLargeArcRadius;
                  }
                }
                pC.rightFullExtent =
                  pC.sourceX + pC.rightLargeArcRadius + (pC.rightNodeBuffer || 0);
                changed = true;
              }
              continue;
            }
            cC.rightLargeArcRadius += delta;
            if (typeof cC.rightSmallArcRadius === "number") {
              cC.rightSmallArcRadius += delta;
              if (cC.rightSmallArcRadius > cC.rightLargeArcRadius) {
                cC.rightSmallArcRadius = cC.rightLargeArcRadius;
              }
            }
            cC.rightFullExtent =
              cC.sourceX + cC.rightLargeArcRadius + (cC.rightNodeBuffer || 0);
            changed = true;
          }

          if (!selfLinking(curr, id)) {
            var minRadius = baseRadius + currW / 2;
            var minRfe = cC.sourceX + (cC.rightNodeBuffer || 0) + minRadius;
            for (var bi = 0; bi < i; bi++) {
              var blocker = group[bi];
              if (blocker.circularPathData.rightFullExtent >= cC.rightFullExtent - 1e-6) continue;
              if (rightLegOverlapAmount(blocker, curr) <= 1e-6) continue;
              var blockerBound = blocker.circularPathData.rightFullExtent +
                ((blocker.width || 0) + currW) / 2 + required;
              if (blockerBound > minRfe) minRfe = blockerBound;
            }
            if (minRfe < cC.rightFullExtent - 1e-6) {
              var nextRadius = minRfe - cC.sourceX - (cC.rightNodeBuffer || 0);
              if (nextRadius < minRadius) nextRadius = minRadius;
              if (nextRadius < cC.rightLargeArcRadius - 1e-6) {
                cC.rightLargeArcRadius = nextRadius;
                if (typeof cC.rightSmallArcRadius === "number" &&
                    cC.rightSmallArcRadius > cC.rightLargeArcRadius) {
                  cC.rightSmallArcRadius = cC.rightLargeArcRadius;
                }
                cC.rightFullExtent = cC.sourceX + cC.rightLargeArcRadius + (cC.rightNodeBuffer || 0);
                if (curr.circularLinkType === "bottom") {
                  cC.verticalRightInnerExtent = cC.verticalFullExtent - cC.rightLargeArcRadius;
                } else {
                  cC.verticalRightInnerExtent = cC.verticalFullExtent + cC.rightLargeArcRadius;
                }
                changed = true;
              }
            }
          }
        }

        if (!changed) break;
      }
    });
  })();

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

  // Priority-based greedy left-leg placement.
  //
  // Instead of iterative pairwise pushing (which causes cascade effects where
  // short-span links get pushed far from their node), this pass places links
  // one at a time in PRIORITY order: shortest span first, then closest-to-node
  // first within the same span. Each link gets the rightmost (closest to node)
  // position that doesn't conflict with any already-placed link.
  //
  // This ensures span=0 links are anchored near their node before longer-span
  // links are placed, preventing the cascade from displacing them.
  var leftGroups = {};
  graph.links.forEach(function(l) {
    if (!l.circular) return;
    if (!l.circularPathData) return;
    if (selfLinking(l, id)) return;
    if (typeof l.circularPathData.leftLargeArcRadius !== "number") return;
    // Group by target node. Cross-target interactions are handled by the narrower
    // self-loop/cross-band clearance passes; grouping the whole column here makes
    // non-overlapping target bundles reserve space for each other.
    var targetKey =
      l.target
        ? String(id(l.target))
        : String(Math.round((l.circularPathData.targetX || 0) * 10) / 10);
    if (!leftGroups[targetKey]) leftGroups[targetKey] = [];
    leftGroups[targetKey].push(l);
  });

  Object.keys(leftGroups).forEach(function(k) {
    var group = leftGroups[k];
    if (group.length < 2) return;

    var reqGap = circularLinkGap || 0;

    // Sort by priority:
    //   1. Target node — group all links to the same target together so their
    //      left legs form a contiguous visual block. Higher target y0 is
    //      placed first (closer to node) for both bands.
    //   2. span ASC — within each target group, shorter-span links get best
    //      positions (closest to node).
    //   3. lfe DESC — within same target + span, already closer = higher priority.
    group.sort(function(a, b) {
      var ay = a.target && typeof a.target.y0 === "number" ? a.target.y0 : 0;
      var by = b.target && typeof b.target.y0 === "number" ? b.target.y0 : 0;
      if (Math.abs(ay - by) > 1e-3) return by - ay;
      var sa = Math.abs(
        (a.source && typeof a.source.column === "number" ? a.source.column : 0) -
        (a.target && typeof a.target.column === "number" ? a.target.column : 0)
      );
      var sb = Math.abs(
        (b.source && typeof b.source.column === "number" ? b.source.column : 0) -
        (b.target && typeof b.target.column === "number" ? b.target.column : 0)
      );
      if (sa !== sb) return sa - sb;
      return b.circularPathData.leftFullExtent - a.circularPathData.leftFullExtent;
    });

    // Pre-populate placed list with self-loops on this target node
    // (immovable obstacles from the self-loop clearance pass).
    var placed = [];
    var firstTarget = group[0] && group[0].target;
    if (leftSelfLoopByTarget && firstTarget) {
      var targetLoops = leftSelfLoopByTarget[String(id(firstTarget))];
      if (targetLoops) {
        for (var sl = 0; sl < targetLoops.length; sl++) {
          var loop = targetLoops[sl];
          if (!loop || !loop.circularPathData) continue;
          var lc = loop.circularPathData;
          placed.push({
            lfe: lc.leftFullExtent,
            hw: (loop.width || 0) / 2,
            yMin: Math.min(lc.targetY, lc.verticalLeftInnerExtent),
            yMax: Math.max(lc.targetY, lc.verticalLeftInnerExtent)
          });
        }
      }
    }

    for (var i = 0; i < group.length; i++) {
      var link = group[i];
      var c = link.circularPathData;
      var hw = (link.width || 0) / 2;

      // Only the actual LEFT vertical leg should reserve horizontal space.
      // Using targetY -> verticalFullExtent makes non-overlapping shelves look like obstacles.
      var tY = typeof c.targetY === "number"
        ? c.targetY
        : (typeof link.y1 === "number"
          ? link.y1
          : (link.target && typeof link.target.y1 === "number" ? link.target.y1 : 0));
      var vLeft = typeof c.verticalLeftInnerExtent === "number" ? c.verticalLeftInnerExtent : c.verticalFullExtent;
      var yMin = Math.min(tY, vLeft);
      var yMax = Math.max(tY, vLeft);

      // Maximum lfe = minimum radius, closest to node.
      var maxLfe = c.targetX - (c.leftNodeBuffer || 0) - baseRadius - hw;

      // Collect forbidden zones from already-placed entries.
      // Require a minimum Y overlap to count as a real conflict; tiny
      // boundary touches (e.g. TOP link ending at the port where a BOTTOM
      // link begins) are not visual conflicts.
      var forbidden = [];
      var minYOverlap = 5;
      for (var j = 0; j < placed.length; j++) {
        var p = placed[j];
        var yOv = Math.min(yMax, p.yMax) - Math.max(yMin, p.yMin);
        if (yOv < minYOverlap) continue;
        forbidden.push({
          lo: p.lfe - p.hw - reqGap - hw,
          hi: p.lfe + p.hw + reqGap + hw
        });
      }

      // Walk from maxLfe downward through forbidden zones to find the
      // rightmost free slot.
      forbidden.sort(function(a, b) { return b.hi - a.hi; });
      var moved = true;
      var safety = 0;
      while (moved && safety < 300) {
        moved = false;
        safety++;
        for (var fi = 0; fi < forbidden.length; fi++) {
          if (maxLfe >= forbidden[fi].lo && maxLfe <= forbidden[fi].hi) {
            maxLfe = forbidden[fi].lo - 1e-6;
            moved = true;
            break;
          }
        }
      }

      // Apply the new position.
      var newRadius = c.targetX - (c.leftNodeBuffer || 0) - maxLfe;
      if (newRadius < baseRadius + hw) newRadius = baseRadius + hw;

      var radiusDelta = newRadius - c.leftLargeArcRadius;
      c.leftLargeArcRadius = newRadius;
      if (typeof c.leftSmallArcRadius === "number") {
        c.leftSmallArcRadius += radiusDelta;
        if (c.leftSmallArcRadius < 0) c.leftSmallArcRadius = 0;
        if (c.leftSmallArcRadius > c.leftLargeArcRadius) {
          c.leftSmallArcRadius = c.leftLargeArcRadius;
        }
      }
      c.leftFullExtent = c.targetX - c.leftLargeArcRadius - (c.leftNodeBuffer || 0);

      placed.push({
        lfe: c.leftFullExtent,
        hw: hw,
        yMin: yMin,
        yMax: yMax
      });
    }
  });

  // (TOP left-leg reorder runs later, after all constraint passes.)

  // Post-pass (narrow): cross-band LEFT-leg clearance when a TOP and a BOTTOM circular link
  // visually merge on the same left vertical leg in a target column.
  //
  // Why this is intentionally narrow:
  // - In most diagrams, TOP and BOTTOM links use different vertical bands and don't need to affect each other.
  // - But in some local configurations, their left-leg Y segments can overlap substantially while their
  //   left-leg X positions become identical/too-close (often because left-leg budgeting is done per band).
  //
  // We only apply this when:
  // - same target column (same left-leg neighborhood),
  // - opposite bands (top vs bottom),
  // - left-leg segments overlap in Y,
  // - the two links share a node (node-local interaction, not cross-column broadening),
  // - and at least one of them is "local" (span<=1), which is where this visual merge tends to happen.
  //
  // The resolution strategy matches the within-band left clearance: push the OUTER (more-left) link further
  // left by increasing its left arc radius just enough to satisfy `circularLinkGap`.
  var crossBandLeftGroups = {};
  graph.links.forEach(function(l) {
    if (!l || !l.circular || l.isVirtual) return;
    if (!l.circularPathData) return;
    if (selfLinking(l, id)) return; // self-loops handled by dedicated passes already
    if (typeof l.circularPathData.leftLargeArcRadius !== "number") return;
    if (!l.target || typeof l.target.column !== "number") return;
    var colKey = String(l.target.column);
    if (!crossBandLeftGroups[colKey]) crossBandLeftGroups[colKey] = [];
    crossBandLeftGroups[colKey].push(l);
  });

  function _span(link) {
    var sc = link && link.source && typeof link.source.column === "number" ? link.source.column : 0;
    var tc = link && link.target && typeof link.target.column === "number" ? link.target.column : 0;
    return Math.abs(tc - sc);
  }

  function _sharesNode(a, b) {
    // Use name-based matching as a safe fallback when object identity differs.
    function sameNode(x, y) {
      if (x === y) return true;
      if (x && y && x.name != null && y.name != null) return x.name === y.name;
      return false;
    }
    return (
      sameNode(a.source, b.source) ||
      sameNode(a.source, b.target) ||
      sameNode(a.target, b.source) ||
      sameNode(a.target, b.target)
    );
  }

  Object.keys(crossBandLeftGroups).forEach(function(colKey) {
    var group = crossBandLeftGroups[colKey];
    if (!group || group.length < 2) return;

    var maxIters = 10;
    for (var it = 0; it < maxIters; it++) {
      var changed = false;

      // Sort by leftFullExtent (more left first) so we can enforce adjacency clearance.
      group.sort(function(a, b) {
        var al = a.circularPathData.leftFullExtent;
        var bl = b.circularPathData.leftFullExtent;
        return al - bl;
      });

      for (var i = 1; i < group.length; i++) {
        var outer = group[i - 1]; // smaller lfe => more left
        var inner = group[i];     // larger lfe => more right
        if (!outer || !inner) continue;
        if (!outer.circularPathData || !inner.circularPathData) continue;

        // Only cross-band pairs.
        if (outer.circularLinkType === inner.circularLinkType) continue;

        // Narrow: require they share a node (node-local).
        if (!_sharesNode(outer, inner)) continue;

        // Narrow: at least one is local (span<=1).
        var s1 = _span(outer);
        var s2 = _span(inner);
        if (Math.min(s1, s2) > 1) continue;

        // Check vertical overlap on the left leg using target port and verticalLeftInnerExtent.
        var oTargetY =
          typeof outer.circularPathData.targetY === "number"
            ? outer.circularPathData.targetY
            : (typeof outer.y1 === "number"
              ? outer.y1
              : (outer.target && typeof outer.target.y1 === "number" ? outer.target.y1 : 0));
        var oV = outer.circularPathData.verticalLeftInnerExtent;
        var oMin = Math.min(oTargetY, oV);
        var oMax = Math.max(oTargetY, oV);

        var iTargetY =
          typeof inner.circularPathData.targetY === "number"
            ? inner.circularPathData.targetY
            : (typeof inner.y1 === "number"
              ? inner.y1
              : (inner.target && typeof inner.target.y1 === "number" ? inner.target.y1 : 0));
        var iV = inner.circularPathData.verticalLeftInnerExtent;
        var iMin = Math.min(iTargetY, iV);
        var iMax = Math.max(iTargetY, iV);

        var vOv = Math.max(0, Math.min(oMax, iMax) - Math.max(oMin, iMin));
        if (vOv <= 1e-6) continue;

        var gapRequired = circularLinkGap || 0;
        var oW = outer.width || 0;
        var iW = inner.width || 0;
        var outerRightEdge = outer.circularPathData.leftFullExtent + oW / 2;
        var innerLeftEdge = inner.circularPathData.leftFullExtent - iW / 2;
        var gap = innerLeftEdge - outerRightEdge;

        if (gap < gapRequired) {
          var delta = (gapRequired - gap) + 1e-6;
          // Push OUTER further left by increasing its radius.
          outer.circularPathData.leftLargeArcRadius += delta;
          if (typeof outer.circularPathData.leftSmallArcRadius === "number") {
            outer.circularPathData.leftSmallArcRadius += delta;
            if (outer.circularPathData.leftSmallArcRadius > outer.circularPathData.leftLargeArcRadius) {
              outer.circularPathData.leftSmallArcRadius = outer.circularPathData.leftLargeArcRadius;
            }
          }
          outer.circularPathData.leftFullExtent =
            outer.circularPathData.targetX -
            outer.circularPathData.leftLargeArcRadius -
            (outer.circularPathData.leftNodeBuffer || 0);
          changed = true;
        }
      }

      if (!changed) break;
    }
  });

  // Post-pass: compact left legs toward the node.
  // The clearance pass above only pushes links further OUT (left). After the
  // cascade some links end up much further out than needed. This pass pulls
  // each link back toward the node as far as clearance with ALL other links
  // in the same target column allows.
  (function compactLeftLegsTowardNode() {
    var colBuckets = {};
    graph.links.forEach(function(l) {
      if (!l || !l.circular || l.isVirtual) return;
      if (!l.circularPathData) return;
      if (typeof l.circularPathData.leftLargeArcRadius !== "number") return;
      // Group by target column only (matching greedy placement grouping)
      // to ensure cross-band constraints are respected during compaction.
      var col = l.target && typeof l.target.column === "number" ? l.target.column : -1;
      var k = String(col);
      if (!colBuckets[k]) colBuckets[k] = [];
      colBuckets[k].push(l);
    });

    var gap = circularLinkGap || 0;

    Object.keys(colBuckets).forEach(function(k) {
      var bucket = colBuckets[k];
      if (bucket.length < 2) return;

      // Sort by leftFullExtent ascending (furthest from node first).
      bucket.sort(function(a, b) {
        return a.circularPathData.leftFullExtent - b.circularPathData.leftFullExtent;
      });

      for (var i = 0; i < bucket.length; i++) {
        var link = bucket[i];
        var c = link.circularPathData;
        var hw = (link.width || 0) / 2;

        var tY = typeof c.targetY === "number"
          ? c.targetY
          : (typeof link.y1 === "number"
            ? link.y1
            : (link.target && typeof link.target.y1 === "number" ? link.target.y1 : 0));
        var vLeft = typeof c.verticalLeftInnerExtent === "number" ? c.verticalLeftInnerExtent : c.verticalFullExtent;
        var vfe = c.verticalFullExtent;
        var yMin = Math.min(tY, vLeft);
        var yMax = Math.max(tY, vLeft);

        var maxLfe = c.targetX - (c.leftNodeBuffer || 0) - baseRadius - hw;

        // Constrain by every other link in the bucket.
        // Same minimum Y overlap threshold as the greedy placement.
        var minYOv = 5;
        for (var j = 0; j < bucket.length; j++) {
          if (j === i) continue;
          var other = bucket[j];
          var oc = other.circularPathData;
          var oHW = (other.width || 0) / 2;

          var oTY = typeof oc.targetY === "number"
            ? oc.targetY
            : (typeof other.y1 === "number"
              ? other.y1
              : (other.target && typeof other.target.y1 === "number" ? other.target.y1 : 0));
          var oVLeft = typeof oc.verticalLeftInnerExtent === "number" ? oc.verticalLeftInnerExtent : oc.verticalFullExtent;
          var oVfe = oc.verticalFullExtent;
          var oYMin = Math.min(oTY, oVLeft);
          var oYMax = Math.max(oTY, oVLeft);
          var yOvLen = Math.min(yMax, oYMax) - Math.max(yMin, oYMin);
          if (yOvLen < minYOv) continue;

          var oLfe = oc.leftFullExtent;
          if (oLfe > c.leftFullExtent) {
            var limit = oLfe - oHW - gap - hw;
            if (limit < maxLfe) maxLfe = limit;
          }

          // vLIE monotonicity: if `other` is more outer (oLfe < this link's lfe),
          // don't compact this link so far that its vLIE rises above the y-position
          // of `other`'s arc at this link's left-leg x-position.
          // Only applies to bottom links sharing approximately the same innerX.
          if (link.circularLinkType === "bottom" && other.circularLinkType === "bottom"
              && oLfe < c.leftFullExtent) {
            var oR = oc.leftLargeArcRadius;
            var bInnerX = c.targetX - (c.leftNodeBuffer || 0);
            var aInnerX = oc.targetX - (oc.leftNodeBuffer || 0);
            var dxVlie = bInnerX - aInnerX;
            if (dxVlie < oR) { // B's leg is within A's arc x-range
              var disc = oR * oR - dxVlie * dxVlie;
              var arcY = oVfe - Math.sqrt(disc); // A's arc top at B's leg x
              // Only constrain if B's leg actually spans arcY
              if (tY <= arcY) {
                var rBminVlie = vfe - arcY;
                if (rBminVlie > 0) {
                  var lfeLimitVlie = bInnerX - rBminVlie;
                  if (lfeLimitVlie < maxLfe) maxLfe = lfeLimitVlie;
                }
              }
            }
          }

        }

        // Also check against self-loops in the same target column
        if (selfLoopsByTargetCol) {
          var colKey = link.target && typeof link.target.column === "number"
            ? String(link.target.column) : null;
          var colLoops = colKey && selfLoopsByTargetCol[colKey];
          if (colLoops) {
            for (var sl = 0; sl < colLoops.length; sl++) {
              var loop = colLoops[sl];
              if (!loop || !loop.circularPathData) continue;
              var lc = loop.circularPathData;
              var lHW = (loop.width || 0) / 2;
              var lYMin = Math.min(lc.targetY, lc.verticalLeftInnerExtent);
              var lYMax = Math.max(lc.targetY, lc.verticalLeftInnerExtent);
              if (yMin > lYMax || yMax < lYMin) continue;
              var loopLfe = lc.leftFullExtent;
              var limitSL = loopLfe - lHW - gap - hw;
              if (limitSL < maxLfe) maxLfe = limitSL;
            }
          }
        }

        if (maxLfe > c.leftFullExtent + 1e-6) {
          var delta = maxLfe - c.leftFullExtent;
          c.leftLargeArcRadius -= delta;
          if (c.leftLargeArcRadius < baseRadius + hw)
            c.leftLargeArcRadius = baseRadius + hw;
          if (typeof c.leftSmallArcRadius === "number") {
            c.leftSmallArcRadius -= delta;
            if (c.leftSmallArcRadius < 0) c.leftSmallArcRadius = 0;
          }
          c.leftFullExtent = c.targetX - c.leftLargeArcRadius - (c.leftNodeBuffer || 0);
        }
      }
    });
  })();


  // =========================================================================
  // Column-level VFE resolver
  //
  // Replaces 14+ individual VFE-modifying post-passes with a structured
  // multi-step assignment for both bottom and top circular links:
  //   Phase 2:  Pin self-loops compact (close to their node)
  //   Phase 3A: Per-column/target-node VFE stacking with gap enforcement
  //   Phase 3B: Global gap enforcement (catches cross-column shelf overlaps)
  //   Phase 3D: Bottom local tightening (span<=1 close to deeper anchors)
  //   Phase 3F: Bottom compaction (pull links towards nodes to reduce leg crossings)
  //   Phase 3E: Top compaction (pull outer links towards nodes)
  //   Phase 3C: Top local tightening (span<=1 close to bundle neighbors)
  // =========================================================================
  (function resolveColumnVFE() {
    var gap = circularLinkGap || 0;

    function shelfXRange(link) {
      var c = link.circularPathData;
      var x1 = Math.min(c.leftInnerExtent, c.rightInnerExtent);
      var x2 = Math.max(c.leftInnerExtent, c.rightInnerExtent);
      return { x1: x1, x2: x2 };
    }

    function shelvesOverlapX(a, b) {
      var ax = shelfXRange(a);
      var bx = shelfXRange(b);
      return Math.min(ax.x2, bx.x2) - Math.max(ax.x1, bx.x1) > 1e-6;
    }

    function needsSeparation(a, b) {
      return shelvesOverlapX(a, b) || circularLinksActuallyCross(a, b);
    }

    function linkSpan(l) {
      return Math.abs((l.source.column || 0) - (l.target.column || 0));
    }

    // ===================== BOTTOM =====================

    var bottomLinks = graph.links.filter(function(l) {
      return l && l.circular && l.circularLinkType === "bottom" && !l.isVirtual &&
             l.circularPathData && typeof l.circularPathData.verticalFullExtent === "number";
    });

    // Phase 2: Pin bottom self-loops compact (close to their node)
    bottomLinks.forEach(function(l) {
      if (!selfLinking(l, id)) return;
      var node = l.source;
      if (!node || typeof node.y1 !== "number") return;
      var r = typeof l.circularPathData.rightLargeArcRadius === "number"
        ? l.circularPathData.rightLargeArcRadius : (baseRadius + (l.width || 0) / 2);
      var labelHeight = Math.max(28, (l.width || 0) + 18);
      var desiredVfe = Math.max(
        node.y1 + Math.max(12, r + 4),
        (typeof l.circularPathData.sourceY === "number" ? l.circularPathData.sourceY : node.y1) + labelHeight
      );
      if (l.circularPathData.verticalFullExtent > desiredVfe) {
        var pullUp = l.circularPathData.verticalFullExtent - desiredVfe;
        l.circularPathData.verticalFullExtent = desiredVfe;
        if (typeof l.circularPathData.verticalBuffer === "number") {
          l.circularPathData.verticalBuffer = Math.max(0, l.circularPathData.verticalBuffer - pullUp);
        }
      }
    });

    // Phase 3A: Per-column VFE stacking for BOTTOM links
    var bottomByCol = {};
    bottomLinks.forEach(function(l) {
      var col = l.target.column;
      if (!bottomByCol[col]) bottomByCol[col] = [];
      bottomByCol[col].push(l);
    });

    Object.keys(bottomByCol).forEach(function(colKey) {
      var group = bottomByCol[colKey];

      // Ordering: self-loops first, then lighter targets first (all their links
      // form a compact inner band), then heavier targets outside.
      // Within each target group: locals (span=0) first, then span ASC.
      group.sort(function(a, b) {
        var aSelf = selfLinking(a, id) ? 1 : 0;
        var bSelf = selfLinking(b, id) ? 1 : 0;
        if (aSelf !== bSelf) return bSelf - aSelf;

        // Lighter (shorter) target first → compact inner band.
        var aTgtCY = (a.target.y0 + a.target.y1) / 2;
        var bTgtCY = (b.target.y0 + b.target.y1) / 2;
        if (Math.abs(aTgtCY - bTgtCY) >= 1e-6) return bTgtCY - aTgtCY;

        var aSpan = linkSpan(a);
        var bSpan = linkSpan(b);

        var aLocal = aSpan === 0 ? 1 : 0;
        var bLocal = bSpan === 0 ? 1 : 0;
        if (aLocal !== bLocal) return bLocal - aLocal;

        if (aSpan !== bSpan) return aSpan - bSpan;

        var aSrcCY = (a.source.y0 + a.source.y1) / 2;
        var bSrcCY = (b.source.y0 + b.source.y1) / 2;
        if (Math.abs(aSrcCY - bSrcCY) >= 1e-6) return bSrcCY - aSrcCY;

        return (a.width || 0) - (b.width || 0);
      });

      // Authoritative sweep: assign VFEs based on sort order.
      // Uses right-leg min-length + gap constraints from already-placed links
      // as the floor, ignoring calcVerticalBuffer's initial ordering.
      for (var i = 0; i < group.length; i++) {
        var link = group[i];
        var c = link.circularPathData;
        var halfW = (link.width || 0) / 2;

        // Leg min-length constraints as absolute floor.
        // Both legs must clear their respective node attachments + arc radii
        // so the shelf is always below both source and target for bottom links.
        var legFloor = -Infinity;
        if (!selfLinking(link, id)) {
          if (typeof c.sourceY === "number" &&
              typeof c.rightSmallArcRadius === "number" &&
              typeof c.rightLargeArcRadius === "number") {
            legFloor = c.sourceY + c.rightSmallArcRadius + c.rightLargeArcRadius + 1e-6;
          }
          if (typeof c.targetY === "number" &&
              typeof c.leftSmallArcRadius === "number" &&
              typeof c.leftLargeArcRadius === "number") {
            var leftLegFloor = c.targetY + c.leftSmallArcRadius + c.leftLargeArcRadius + 1e-6;
            if (leftLegFloor > legFloor) legFloor = leftLegFloor;
          }
        }

        // Node-clearance floor: the horizontal shelf must clear all
        // intermediate nodes whose x-range overlaps the shelf span.
        var nodeFloor = -Infinity;
        if (!selfLinking(link, id)) {
          var shelfX1 = Math.min(
            typeof c.leftInnerExtent === "number" ? c.leftInnerExtent : (c.targetX || 0),
            typeof c.rightInnerExtent === "number" ? c.rightInnerExtent : (c.sourceX || 0)
          );
          var shelfX2 = Math.max(
            typeof c.leftInnerExtent === "number" ? c.leftInnerExtent : (c.targetX || 0),
            typeof c.rightInnerExtent === "number" ? c.rightInnerExtent : (c.sourceX || 0)
          );
          var srcId = link.source ? id(link.source) : null;
          var tgtId = link.target ? id(link.target) : null;
          for (var ni = 0; ni < graph.nodes.length; ni++) {
            var nd = graph.nodes[ni];
            if (nd.virtual) continue;
            if (id(nd) === srcId || id(nd) === tgtId) continue;
            if (typeof nd.x0 !== "number" || typeof nd.x1 !== "number") continue;
            if (typeof nd.y1 !== "number") continue;
            if (nd.x1 <= shelfX1 || nd.x0 >= shelfX2) continue;
            var ndNeeded = nd.y1 + gap + halfW;
            if (ndNeeded > nodeFloor) nodeFloor = ndNeeded;
          }
        }

        // Self-loop clearance floor: the shelf must not cross any self-loop
        // whose x-range overlaps the shelf span.
        var selfLoopFloor = -Infinity;
        if (!selfLinking(link, id)) {
          var slShelfX1 = typeof c.leftFullExtent === "number" ? c.leftFullExtent : (typeof c.leftInnerExtent === "number" ? c.leftInnerExtent : (c.targetX || 0));
          var slShelfX2 = typeof c.rightFullExtent === "number" ? c.rightFullExtent : (typeof c.rightInnerExtent === "number" ? c.rightInnerExtent : (c.sourceX || 0));
          if (slShelfX1 > slShelfX2) { var _t = slShelfX1; slShelfX1 = slShelfX2; slShelfX2 = _t; }
          for (var sl = 0; sl < bottomLinks.length; sl++) {
            var slLink = bottomLinks[sl];
            if (!selfLinking(slLink, id)) continue;
            var slC = slLink.circularPathData;
            var slLfe = typeof slC.leftFullExtent === "number" ? slC.leftFullExtent : 0;
            var slRfe = typeof slC.rightFullExtent === "number" ? slC.rightFullExtent : 0;
            if (slLfe > slRfe) { var _t2 = slLfe; slLfe = slRfe; slRfe = _t2; }
            if (slRfe <= slShelfX1 || slLfe >= slShelfX2) continue;
            var slVfe = slC.verticalFullExtent || 0;
            var slHalfW = (slLink.width || 0) / 2;
            var slNeeded = slVfe + slHalfW + gap + halfW;
            if (slNeeded > selfLoopFloor) selfLoopFloor = slNeeded;
          }
        }

        // Gap constraints from all previously placed overlapping links
        var placedFloor = -Infinity;
        for (var j = 0; j < i; j++) {
          var prev = group[j];
          if (!needsSeparation(link, prev)) continue;
          var prevBottom = prev.circularPathData.verticalFullExtent + (prev.width || 0) / 2;
          var needed = prevBottom + gap + halfW;
          if (needed > placedFloor) placedFloor = needed;
        }

        var targetVfe = Math.max(legFloor, placedFloor, nodeFloor, selfLoopFloor);
        if (targetVfe === -Infinity) targetVfe = c.verticalFullExtent;

        if (Math.abs(targetVfe - c.verticalFullExtent) > 1e-12) {
          var delta = targetVfe - c.verticalFullExtent;
          c.verticalFullExtent = targetVfe;
          if (typeof c.verticalBuffer === "number") c.verticalBuffer += delta;
        }
      }
    });

    // Phase 3B: Global gap enforcement for ALL bottom links (cross-column overlaps)
    if (gap > 0) {
      var maxGlobalIters = 10;
      for (var gIt = 0; gIt < maxGlobalIters; gIt++) {
        var gChanged = false;
        bottomLinks.sort(function(a, b) {
          return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
        });
        for (var gi = 0; gi < bottomLinks.length; gi++) {
          var curr = bottomLinks[gi];
          if (selfLinking(curr, id)) continue;
          var currC = curr.circularPathData;
          var currHW = (curr.width || 0) / 2;
          var targetVfe = currC.verticalFullExtent;

          for (var gj = 0; gj < gi; gj++) {
            var prev = bottomLinks[gj];
            if (!needsSeparation(curr, prev)) continue;
            var prevBot = prev.circularPathData.verticalFullExtent + (prev.width || 0) / 2;
            var need = prevBot + gap + currHW;
            if (need > targetVfe) targetVfe = need;
          }
          if (targetVfe > currC.verticalFullExtent + 1e-12) {
            var dg = targetVfe - currC.verticalFullExtent;
            currC.verticalFullExtent = targetVfe;
            if (typeof currC.verticalBuffer === "number") currC.verticalBuffer += dg;
            gChanged = true;
          }
        }
        if (!gChanged) break;
      }
    }

    // Phase 3F: Bottom compaction — pull each bottom link towards nodes
    // (decrease VFE) while respecting gap constraints to all overlapping
    // shallower (smaller VFE) links. This lets short-span links float above
    // long-span links from other target groups, reducing vertical-leg crossings.
    // Runs BEFORE Phase 3D so that local tightening gets the final word.
    if (gap > 0) {
      var maxBotCompactIters = 10;
      for (var bcIt = 0; bcIt < maxBotCompactIters; bcIt++) {
        var bcChanged = false;
        bottomLinks.sort(function(a, b) {
          return b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent;
        });
        for (var bci = 0; bci < bottomLinks.length; bci++) {
          var bcLink = bottomLinks[bci];
          if (selfLinking(bcLink, id)) continue;
          var bcC = bcLink.circularPathData;
          var bcHW = (bcLink.width || 0) / 2;
          var bcMinVfe = -Infinity;

          // Left-leg floor: VFE must stay below the target attachment + arcs
          if (typeof bcC.targetY === "number" &&
              typeof bcC.leftSmallArcRadius === "number" &&
              typeof bcC.leftLargeArcRadius === "number") {
            bcMinVfe = bcC.targetY + bcC.leftSmallArcRadius + bcC.leftLargeArcRadius + 1e-6;
          }
          // Right-leg floor
          if (typeof bcC.sourceY === "number" &&
              typeof bcC.rightSmallArcRadius === "number" &&
              typeof bcC.rightLargeArcRadius === "number") {
            var bcRightFloor = bcC.sourceY + bcC.rightSmallArcRadius + bcC.rightLargeArcRadius + 1e-6;
            if (bcRightFloor > bcMinVfe) bcMinVfe = bcRightFloor;
          }
          // Node-clearance floor (same as Phase 3A)
          var bcShelfX1 = Math.min(
            typeof bcC.leftInnerExtent === "number" ? bcC.leftInnerExtent : (bcC.targetX || 0),
            typeof bcC.rightInnerExtent === "number" ? bcC.rightInnerExtent : (bcC.sourceX || 0)
          );
          var bcShelfX2 = Math.max(
            typeof bcC.leftInnerExtent === "number" ? bcC.leftInnerExtent : (bcC.targetX || 0),
            typeof bcC.rightInnerExtent === "number" ? bcC.rightInnerExtent : (bcC.sourceX || 0)
          );
          var bcSrcId = bcLink.source ? id(bcLink.source) : null;
          var bcTgtId = bcLink.target ? id(bcLink.target) : null;
          for (var bni = 0; bni < graph.nodes.length; bni++) {
            var bnd = graph.nodes[bni];
            if (bnd.virtual) continue;
            if (id(bnd) === bcSrcId || id(bnd) === bcTgtId) continue;
            if (typeof bnd.x0 !== "number" || typeof bnd.x1 !== "number") continue;
            if (typeof bnd.y1 !== "number") continue;
            if (bnd.x1 <= bcShelfX1 || bnd.x0 >= bcShelfX2) continue;
            var bndNeeded = bnd.y1 + gap + bcHW;
            if (bndNeeded > bcMinVfe) bcMinVfe = bndNeeded;
          }

          // Self-loop clearance floor (same as Phase 3A)
          var bcSlX1 = typeof bcC.leftFullExtent === "number" ? bcC.leftFullExtent : (typeof bcC.leftInnerExtent === "number" ? bcC.leftInnerExtent : (bcC.targetX || 0));
          var bcSlX2 = typeof bcC.rightFullExtent === "number" ? bcC.rightFullExtent : (typeof bcC.rightInnerExtent === "number" ? bcC.rightInnerExtent : (bcC.sourceX || 0));
          if (bcSlX1 > bcSlX2) { var _t3 = bcSlX1; bcSlX1 = bcSlX2; bcSlX2 = _t3; }
          for (var bcsl = 0; bcsl < bottomLinks.length; bcsl++) {
            var bcSlLink = bottomLinks[bcsl];
            if (!selfLinking(bcSlLink, id)) continue;
            var bcSlC = bcSlLink.circularPathData;
            var slL = typeof bcSlC.leftFullExtent === "number" ? bcSlC.leftFullExtent : 0;
            var slR = typeof bcSlC.rightFullExtent === "number" ? bcSlC.rightFullExtent : 0;
            if (slL > slR) { var _t4 = slL; slL = slR; slR = _t4; }
            if (slR <= bcSlX1 || slL >= bcSlX2) continue;
            var slVfe2 = bcSlC.verticalFullExtent || 0;
            var slHW2 = (bcSlLink.width || 0) / 2;
            var slNeeded2 = slVfe2 + slHW2 + gap + bcHW;
            if (slNeeded2 > bcMinVfe) bcMinVfe = slNeeded2;
          }

          for (var bcj = bci + 1; bcj < bottomLinks.length; bcj++) {
            var bcShallow = bottomLinks[bcj];
            if (!needsSeparation(bcLink, bcShallow)) continue;
            var shallowBot = bcShallow.circularPathData.verticalFullExtent + (bcShallow.width || 0) / 2;
            var bcBound = shallowBot + gap + bcHW;
            if (bcBound > bcMinVfe) bcMinVfe = bcBound;
          }

          if (bcMinVfe !== -Infinity && bcMinVfe < bcC.verticalFullExtent - 1e-12) {
            var bcDelta = bcC.verticalFullExtent - bcMinVfe;
            bcC.verticalFullExtent = bcMinVfe;
            if (typeof bcC.verticalBuffer === "number") bcC.verticalBuffer -= bcDelta;
            bcChanged = true;
          }
        }
        if (!bcChanged) break;
      }
    }

    // Re-run Phase 3B after compaction to fix any gap violations it introduced.
    if (gap > 0) {
      var maxGlobalIters2 = 10;
      for (var gIt2 = 0; gIt2 < maxGlobalIters2; gIt2++) {
        var gChanged2 = false;
        bottomLinks.sort(function(a, b) {
          return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
        });
        for (var gi2 = 0; gi2 < bottomLinks.length; gi2++) {
          var curr2 = bottomLinks[gi2];
          if (selfLinking(curr2, id)) continue;
          var currC2 = curr2.circularPathData;
          var currHW2 = (curr2.width || 0) / 2;
          var targetVfe2 = currC2.verticalFullExtent;

          for (var gj2 = 0; gj2 < gi2; gj2++) {
            var prev2 = bottomLinks[gj2];
            if (!needsSeparation(curr2, prev2)) continue;
            var prevBot2 = prev2.circularPathData.verticalFullExtent + (prev2.width || 0) / 2;
            var need2 = prevBot2 + gap + currHW2;
            if (need2 > targetVfe2) targetVfe2 = need2;
          }
          if (targetVfe2 > currC2.verticalFullExtent + 1e-12) {
            var dg2 = targetVfe2 - currC2.verticalFullExtent;
            currC2.verticalFullExtent = targetVfe2;
            if (typeof currC2.verticalBuffer === "number") currC2.verticalBuffer += dg2;
            gChanged2 = true;
          }
        }
        if (!gChanged2) break;
      }
    }

    // Phase 3G: Cross-column vertical-horizontal crossing fix.
    //
    // Phase 3A assigns VFEs per target-column independently, so a short-span link L2
    // (targeting col C2) and a long-span link L1 (targeting col C1 < C2) can end up
    // with L1.VFE < L2.VFE when L2.target.column is strictly inside L1's horizontal span
    // [C1, L1.source.column]. In that case L2's left vertical segment (from L2.target.y1
    // down to L2.VFE) crosses L1's horizontal shelf at Y = L1.VFE — a visible artifact.
    //
    // Fix: push L1 deeper so L1.VFE ≥ L2.VFE + L2.width/2 + gap + L1.width/2.
    // Run iteratively (pushing L1 may require pushing neighbours in L1's own group,
    // which Phase 3B re-run handles via the existing gap-propagation logic).
    /*
    {
      var maxCrossIters = 10;
      for (var cgIt = 0; cgIt < maxCrossIters; cgIt++) {
        var cgChanged = false;
        // Process ascending by VFE so we fix the shallowest violator first.
        bottomLinks.sort(function(a, b) {
          return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
        });
        for (var cgi = 0; cgi < bottomLinks.length; cgi++) {
          var cgLink = bottomLinks[cgi];
          if (selfLinking(cgLink, id)) continue;
          var cgC = cgLink.circularPathData;
          var cgHW = (cgLink.width || 0) / 2;
          var cgSrcCol = cgLink.source.column;
          var cgTgtCol = cgLink.target.column;
          var cgColMin = Math.min(cgSrcCol, cgTgtCol);
          var cgColMax = Math.max(cgSrcCol, cgTgtCol);

          for (var cgj = 0; cgj < bottomLinks.length; cgj++) {
            if (cgj === cgi) continue;
            var cgBlocker = bottomLinks[cgj];
            if (selfLinking(cgBlocker, id)) continue;
            var blockerC = cgBlocker.circularPathData;
            var blockerHW = (cgBlocker.width || 0) / 2;

            // cgBlocker's left vertical is at cgBlocker.target.column.
            // This vertical is inside cgLink's horizontal span only when the
            // blocker's target column is strictly between cgLink's endpoints.
            var blockerTgtCol = cgBlocker.target.column;
            if (!(blockerTgtCol > cgColMin && blockerTgtCol < cgColMax)) continue;

            // The vertical of cgBlocker at blockerTgtCol extends from
            // cgBlocker.target.y1 downward to blockerC.verticalFullExtent + blockerHW.
            var blockerTgtNode = cgBlocker.target;
            if (!blockerTgtNode || typeof blockerTgtNode.y1 !== "number") continue;

            // cgLink's horizontal at Y = cgC.verticalFullExtent crosses the blocker
            // vertical when: blockerTgtNode.y1 ≤ cgLink.VFE ≤ blocker.VFE + blocker.hw.
            var blockerVfeBottom = blockerC.verticalFullExtent + blockerHW;

            if (cgC.verticalFullExtent < blockerTgtNode.y1 - 1e-6) continue; // above vertical
            if (cgC.verticalFullExtent >= blockerVfeBottom + gap + cgHW - 1e-6) continue; // already clear

            // Crossing detected: push cgLink deeper.
            var neededVfe = blockerVfeBottom + gap + cgHW;
            var cgDelta = neededVfe - cgC.verticalFullExtent;
            cgC.verticalFullExtent = neededVfe;
            if (typeof cgC.verticalBuffer === "number") cgC.verticalBuffer += cgDelta;
            cgChanged = true;
          }
        }
        if (!cgChanged) break;
      }

      // Re-run Phase 3B once more to propagate any Phase-3G pushes within groups.
      for (var gIt3 = 0; gIt3 < 10; gIt3++) {
        var gChanged3 = false;
        bottomLinks.sort(function(a, b) {
          return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
        });
        for (var gi3 = 0; gi3 < bottomLinks.length; gi3++) {
          var curr3 = bottomLinks[gi3];
          if (selfLinking(curr3, id)) continue;
          var currC3 = curr3.circularPathData;
          var currHW3 = (curr3.width || 0) / 2;
          var targetVfe3 = currC3.verticalFullExtent;
          for (var gj3 = 0; gj3 < gi3; gj3++) {
            var prev3 = bottomLinks[gj3];
            if (!needsSeparation(curr3, prev3)) continue;
            var prevBot3 = prev3.circularPathData.verticalFullExtent + (prev3.width || 0) / 2;
            var need3 = prevBot3 + gap + currHW3;
            if (need3 > targetVfe3) targetVfe3 = need3;
          }
          if (targetVfe3 > currC3.verticalFullExtent + 1e-12) {
            var dg3 = targetVfe3 - currC3.verticalFullExtent;
            currC3.verticalFullExtent = targetVfe3;
            if (typeof currC3.verticalBuffer === "number") currC3.verticalBuffer += dg3;
            gChanged3 = true;
          }
        }
        if (!gChanged3) break;
      }
    }
    */

    // Phase 3H: Enforce nesting for same-target bottom links.
    // Ensure that outer links (smaller lfe / larger radius) are deeper (larger VFE) than inner links
    // to create a consistent "wrapped" look and prevent inverted nesting artifacts.
    // This fixes cases where Phase 3G or sorting pushed inner links deeper than outer links.
    if (gap > 0) {
      var bottomByTargetNode = new Map();
      bottomLinks.forEach(function(l) {
        if (!l.target) return;
        if (selfLinking(l, id)) return;
        var arr = bottomByTargetNode.get(l.target);
        if (!arr) { arr = []; bottomByTargetNode.set(l.target, arr); }
        arr.push(l);
      });

      bottomByTargetNode.forEach(function(grp) {
        if (grp.length < 2) return;
        // Sort by lfe DESC (Inner to Outer).
        // Larger lfe = Inner. Smaller lfe = Outer.
        grp.sort(function(a, b) {
          return b.circularPathData.leftFullExtent - a.circularPathData.leftFullExtent;
        });

        for (var i = 1; i < grp.length; i++) {
          var inner = grp[i - 1];
          var outer = grp[i];
          var innerBot = inner.circularPathData.verticalFullExtent + (inner.width || 0) / 2;
          var outerTop = outer.circularPathData.verticalFullExtent - (outer.width || 0) / 2;

          // We want outerTop >= innerBot + gap
          // If outerTop < innerBot + gap, push outer down.
          var needed = innerBot + gap;
          if (outerTop < needed - 1e-6) {
             var push = needed - outerTop;
             outer.circularPathData.verticalFullExtent += push;
             if (typeof outer.circularPathData.verticalBuffer === "number") {
               outer.circularPathData.verticalBuffer += push;
             }
          }
        }
      });
    }

    // Phase 3I: Enforce nesting for same-target-column bottom links.
    // Ensure that outer links (smaller lfe) are deeper (larger VFE) than inner links (larger lfe).
    // This prevents outer links' horizontal shelves from crossing inner links' vertical legs.
    if (gap > 0) {
      var bottomByCol = {};
      bottomLinks.forEach(function(l) {
        var col = l.target.column;
        if (!bottomByCol[col]) bottomByCol[col] = [];
        bottomByCol[col].push(l);
      });

      Object.keys(bottomByCol).forEach(function(k) {
        var grp = bottomByCol[k];
        if (grp.length < 2) return;
        
        // Sort by lfe DESC (Inner to Outer).
        grp.sort(function(a, b) {
          return b.circularPathData.leftFullExtent - a.circularPathData.leftFullExtent;
        });

        for (var i = 1; i < grp.length; i++) {
          var inner = grp[i - 1];
          var outer = grp[i];
          
          // If outer is actually to the left of inner (it should be, due to sort)
          if (outer.circularPathData.leftFullExtent < inner.circularPathData.leftFullExtent - 1e-6) {
             var innerBot = inner.circularPathData.verticalFullExtent + (inner.width || 0) / 2;
             var outerTop = outer.circularPathData.verticalFullExtent - (outer.width || 0) / 2;
             
             var needed = innerBot + gap;
             if (outerTop < needed - 1e-6) {
                var push = needed - outerTop;
                outer.circularPathData.verticalFullExtent += push;
                if (typeof outer.circularPathData.verticalBuffer === "number") {
                  outer.circularPathData.verticalBuffer += push;
                }
             }
          }
        }
      });
    }

    // Phase 3D: Bottom local tightening - pull local (span<=1) bottom links
    // close to the deeper anchor in the same target-node bundle.
    if (gap > 0) {
      var byTargetBottomAll = new Map();
      bottomLinks.forEach(function(l) {
        if (selfLinking(l, id)) return;
        if (!l.target) return;
        if (typeof l.circularPathData.rightLargeArcRadius !== "number") return;
        var arr = byTargetBottomAll.get(l.target);
        if (!arr) { arr = []; byTargetBottomAll.set(l.target, arr); }
        arr.push(l);
      });

      byTargetBottomAll.forEach(function(grp) {
        if (!grp || grp.length < 2) return;
        var locals = [];
        var deepers = [];
        for (var gi = 0; gi < grp.length; gi++) {
          if (linkSpan(grp[gi]) <= 1) locals.push(grp[gi]);
          else deepers.push(grp[gi]);
        }
        if (locals.length < 2 || deepers.length < 1) return;

        var outerLocal = locals[0];
        for (var li = 1; li < locals.length; li++) {
          if (locals[li].circularPathData.rightLargeArcRadius >
              outerLocal.circularPathData.rightLargeArcRadius) {
            outerLocal = locals[li];
          }
        }

        var maxDeeperRadius = -Infinity;
        for (var di = 0; di < deepers.length; di++) {
          var rr = deepers[di].circularPathData.rightLargeArcRadius;
          if (typeof rr === "number" && rr > maxDeeperRadius) maxDeeperRadius = rr;
        }
        if (maxDeeperRadius + 1e-6 < outerLocal.circularPathData.rightLargeArcRadius) return;

        var outerVfe = outerLocal.circularPathData.verticalFullExtent;
        var outerW = outerLocal.width || 0;

        var maxAllowedOuterVfe = Infinity;
        for (var dj = 0; dj < deepers.length; dj++) {
          var d = deepers[dj];
          var dVfe = d.circularPathData.verticalFullExtent;
          var dW = d.width || 0;
          var bound = dVfe - (dW + outerW) / 2 - gap - 1e-6;
          if (bound < maxAllowedOuterVfe) maxAllowedOuterVfe = bound;
        }
        if (maxAllowedOuterVfe === Infinity) return;

        if (maxAllowedOuterVfe > outerVfe + 1e-12) {
          var deltaPull = maxAllowedOuterVfe - outerVfe;
          // Cap deltaPull so no local overshoots any deeper's bound.
          // Each local has a different width, so its bound differs.
          for (var capM = 0; capM < locals.length; capM++) {
            var capLocVfe = locals[capM].circularPathData.verticalFullExtent;
            var capLocW = locals[capM].width || 0;
            for (var capD = 0; capD < deepers.length; capD++) {
              var capDVfe = deepers[capD].circularPathData.verticalFullExtent;
              var capDW = deepers[capD].width || 0;
              var capBound = capDVfe - (capDW + capLocW) / 2 - gap - 1e-6;
              var capMax = capBound - capLocVfe;
              if (capMax < deltaPull) deltaPull = capMax;
            }
          }
          if (deltaPull > 1e-12) {
            for (var m = 0; m < locals.length; m++) {
              var cLoc = locals[m].circularPathData;
              cLoc.verticalFullExtent += deltaPull;
              if (typeof cLoc.verticalBuffer === "number") cLoc.verticalBuffer += deltaPull;
            }
          }
        } else if (outerVfe > maxAllowedOuterVfe + 1e-12) {
          for (var dj2 = 0; dj2 < deepers.length; dj2++) {
            var d2 = deepers[dj2];
            var cD2 = d2.circularPathData;
            var d2W = d2.width || 0;
            var minD2Vfe = outerVfe + (d2W + outerW) / 2 + gap + 1e-6;
            if (cD2.verticalFullExtent + 1e-12 >= minD2Vfe) continue;
            var deltaD2 = minD2Vfe - cD2.verticalFullExtent;
            cD2.verticalFullExtent += deltaD2;
            if (typeof cD2.verticalBuffer === "number") cD2.verticalBuffer += deltaD2;
          }
        }
      });

    }

    // ===================== TOP =====================

    var topLinks = graph.links.filter(function(l) {
      return l && l.circular && l.circularLinkType === "top" && !l.isVirtual &&
             l.circularPathData && typeof l.circularPathData.verticalFullExtent === "number";
    });

    // Phase 3A: Per-target-node gap enforcement for TOP links.
    if (gap > 0) {
      var topByTarget = new Map();
      topLinks.forEach(function(l) {
        if (!l.target) return;
        if (selfLinking(l, id)) return;
        var arr = topByTarget.get(l.target);
        if (!arr) { arr = []; topByTarget.set(l.target, arr); }
        arr.push(l);
      });

      topByTarget.forEach(function(grp) {
        if (!grp || grp.length < 2) return;
        var maxPTIters = 10;
        for (var itPT = 0; itPT < maxPTIters; itPT++) {
          var changedPT = false;
          grp.sort(function(a, b) {
            return b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent;
          });
          for (var gi = 1; gi < grp.length; gi++) {
            var inner = grp[gi - 1];
            var outer = grp[gi];
            var innerTopEdge = inner.circularPathData.verticalFullExtent - (inner.width || 0) / 2;
            var outerBottomEdge = outer.circularPathData.verticalFullExtent + (outer.width || 0) / 2;
            var gapNow = innerTopEdge - outerBottomEdge;
            if (gapNow < gap) {
              var pushUp = (gap - gapNow) + 1e-6;
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

    // Phase 3B: Global gap enforcement for ALL top links (cross-column overlaps).
    // Sorted DESC by VFE (innermost first); push each outer link further out
    // if it violates the minimum gap to any overlapping inner link.
    if (gap > 0) {
      var maxTopGlobalIters = 10;
      for (var tgIt = 0; tgIt < maxTopGlobalIters; tgIt++) {
        var tgChanged = false;
        topLinks.sort(function(a, b) {
          return b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent;
        });
        for (var tgi = 0; tgi < topLinks.length; tgi++) {
          var currT = topLinks[tgi];
          if (selfLinking(currT, id)) continue;
          var currTC = currT.circularPathData;
          var currTHW = (currT.width || 0) / 2;

          var tightestInner = currTC.verticalFullExtent;
          for (var tgj = 0; tgj < tgi; tgj++) {
            var prevT = topLinks[tgj];
            if (!needsSeparation(currT, prevT)) continue;
            var prevTTop = prevT.circularPathData.verticalFullExtent - (prevT.width || 0) / 2;
            var needT = prevTTop - gap - currTHW;
            if (needT < tightestInner) tightestInner = needT;
          }

          if (tightestInner < currTC.verticalFullExtent - 1e-12) {
            var dtg = currTC.verticalFullExtent - tightestInner;
            currTC.verticalFullExtent = tightestInner;
            if (typeof currTC.verticalBuffer === "number") currTC.verticalBuffer += dtg;
            tgChanged = true;
          }
        }
        if (!tgChanged) break;
      }
    }

    // Phase 3E: Top compaction - pull each outer TOP link towards nodes
    // (increase VFE) while respecting gap constraints to all overlapping
    // links. Collapses excessive gaps from cascading pushes in the global pass.
    // Runs BEFORE local tightening so tightening gets the final word.
    if (gap > 0) {
      var maxCompactIters = 30;
      for (var cpIt = 0; cpIt < maxCompactIters; cpIt++) {
        var cpChanged = false;
        topLinks.sort(function(a, b) {
          return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
        });
        for (var cpi = 0; cpi < topLinks.length; cpi++) {
          var cpLink = topLinks[cpi];
          if (selfLinking(cpLink, id)) continue;
          var cpC = cpLink.circularPathData;
          var cpHW = (cpLink.width || 0) / 2;
          var cpMaxVfe = Infinity;

          // Leg ceiling: VFE must stay above both attachment points
          if (typeof cpC.sourceY === "number" &&
              typeof cpC.rightSmallArcRadius === "number" &&
              typeof cpC.rightLargeArcRadius === "number") {
            var cpRCeil = cpC.sourceY - cpC.rightSmallArcRadius - cpC.rightLargeArcRadius - 1e-6;
            if (cpRCeil < cpMaxVfe) cpMaxVfe = cpRCeil;
          }
          if (typeof cpC.targetY === "number" &&
              typeof cpC.leftSmallArcRadius === "number" &&
              typeof cpC.leftLargeArcRadius === "number") {
            var cpLCeil = cpC.targetY - cpC.leftSmallArcRadius - cpC.leftLargeArcRadius - 1e-6;
            if (cpLCeil < cpMaxVfe) cpMaxVfe = cpLCeil;
          }

          for (var cpj = cpi + 1; cpj < topLinks.length; cpj++) {
            var cpInner = topLinks[cpj];
            if (!needsSeparation(cpLink, cpInner)) continue;
            var cpInnerBot = cpInner.circularPathData.verticalFullExtent - (cpInner.width || 0) / 2;
            var cpBound = cpInnerBot - gap - cpHW;
            if (cpBound < cpMaxVfe) cpMaxVfe = cpBound;
          }

          for (var cpk = 0; cpk < cpi; cpk++) {
            var cpOuter = topLinks[cpk];
            if (!needsSeparation(cpLink, cpOuter)) continue;
            var cpOuterTop = cpOuter.circularPathData.verticalFullExtent + (cpOuter.width || 0) / 2;
            var cpBound2 = cpOuterTop + gap + cpHW;
            if (cpBound2 > cpMaxVfe) cpMaxVfe = cpBound2;
          }

          var _is3eDbg = false && id(cpLink.source)==='click' && id(cpLink.target)==='baggage_filter_on';
          if (_is3eDbg) {
            var cpRCeil2 = cpC.sourceY - (cpC.rightSmallArcRadius||0) - (cpC.rightLargeArcRadius||0);
            var cpLCeil2 = cpC.targetY - (cpC.leftSmallArcRadius||0) - (cpC.leftLargeArcRadius||0);
            console.log("[3E] click→bf VFE="+cpC.verticalFullExtent.toFixed(1)+" cpMaxVfe="+(cpMaxVfe===Infinity?'inf':cpMaxVfe.toFixed(1))+" ceilingR="+cpRCeil2.toFixed(1)+" ceilingL="+cpLCeil2.toFixed(1));
            // Log what constrained cpMaxVfe
            for (var _dbgj = cpi+1; _dbgj < topLinks.length; _dbgj++) {
              var _dbgL = topLinks[_dbgj];
              if (!needsSeparation(cpLink, _dbgL)) continue;
              var _dbgBound = _dbgL.circularPathData.verticalFullExtent - (_dbgL.width||0)/2 - gap - cpHW;
              if (Math.abs(_dbgBound - cpMaxVfe) < 2) {
                console.log("[3E]   BINDING inner: "+id(_dbgL.source)+"→"+id(_dbgL.target)+" VFE="+_dbgL.circularPathData.verticalFullExtent.toFixed(1)+" bound="+_dbgBound.toFixed(1));
              }
            }
            for (var _dbgk = 0; _dbgk < cpi; _dbgk++) {
              var _dbgO = topLinks[_dbgk];
              if (!needsSeparation(cpLink, _dbgO)) continue;
              var _dbgBound2 = _dbgO.circularPathData.verticalFullExtent + (_dbgO.width||0)/2 + gap + cpHW;
              if (Math.abs(_dbgBound2 - cpMaxVfe) < 2) {
                console.log("[3E]   BINDING outer: "+id(_dbgO.source)+"→"+id(_dbgO.target)+" VFE="+_dbgO.circularPathData.verticalFullExtent.toFixed(1)+" bound="+_dbgBound2.toFixed(1));
              }
            }
          }

          if (cpMaxVfe !== Infinity && cpMaxVfe > cpC.verticalFullExtent + 1e-12) {
            var cpDelta = cpMaxVfe - cpC.verticalFullExtent;
            cpC.verticalFullExtent = cpMaxVfe;
            if (typeof cpC.verticalBuffer === "number") cpC.verticalBuffer -= cpDelta;
            cpChanged = true;
          }
        }
        if (!cpChanged) break;
      }
    }

    // Phase 3C: Tighten TOP links towards their nearest neighbor in the same
    // target-node bundle. Runs after compaction for final word.
    if (gap > 0) {
      var topAllNonSelf = topLinks.filter(function(l) {
        return !selfLinking(l, id) &&
               typeof l.circularPathData.leftInnerExtent === "number" &&
               typeof l.circularPathData.rightInnerExtent === "number";
      });

      var topByTarget = new Map();
      topAllNonSelf.forEach(function(l) {
        if (!l.target) return;
        var arr = topByTarget.get(l.target);
        if (!arr) { arr = []; topByTarget.set(l.target, arr); }
        arr.push(l);
      });

      function syncTopVerticalForTightening(link) {
        var c = link.circularPathData;
        if (!c) return;
        if (typeof c.rightLargeArcRadius === "number") {
          c.verticalRightInnerExtent = c.verticalFullExtent + c.rightLargeArcRadius;
        }
        if (typeof c.leftLargeArcRadius === "number") {
          c.verticalLeftInnerExtent = c.verticalFullExtent + c.leftLargeArcRadius;
        }
      }

      function topCeilingForTightening(link) {
        var c = link.circularPathData;
        var halfW = (link.width || 0) / 2;
        var ceiling = Infinity;
        if (typeof c.sourceY === "number" &&
            typeof c.rightSmallArcRadius === "number" &&
            typeof c.rightLargeArcRadius === "number") {
          var minRightSmall = Math.min(c.rightSmallArcRadius, baseRadius + halfW);
          ceiling = Math.min(ceiling, c.sourceY - minRightSmall - c.rightLargeArcRadius - 1e-6);
        }
        if (typeof c.targetY === "number" &&
            typeof c.leftSmallArcRadius === "number" &&
            typeof c.leftLargeArcRadius === "number") {
          var minLeftSmall = Math.min(c.leftSmallArcRadius, baseRadius + halfW);
          ceiling = Math.min(ceiling, c.targetY - minLeftSmall - c.leftLargeArcRadius - 1e-6);
        }

        var xr = _shelfX(link);
        if (xr) {
          var srcId = link.source ? id(link.source) : null;
          var tgtId = link.target ? id(link.target) : null;
          for (var ni = 0; ni < graph.nodes.length; ni++) {
            var nd = graph.nodes[ni];
            if (!nd || nd.virtual) continue;
            if (id(nd) === srcId || id(nd) === tgtId) continue;
            if (typeof nd.x0 !== "number" || typeof nd.x1 !== "number") continue;
            if (typeof nd.y0 !== "number") continue;
            if (nd.x1 <= xr.x0 || nd.x0 >= xr.x1) continue;
            ceiling = Math.min(ceiling, nd.y0 - gap - halfW);
          }
        }
        return ceiling;
      }

      function shrinkTopRightSmallToVfe(link) {
        var c = link.circularPathData;
        if (!c) return;
        if (typeof c.sourceY !== "number" ||
            typeof c.rightSmallArcRadius !== "number" ||
            typeof c.rightLargeArcRadius !== "number") return;
        var minRightSmall = baseRadius + (link.width || 0) / 2;
        var nextSmall = c.sourceY - c.verticalFullExtent - c.rightLargeArcRadius;
        if (nextSmall < minRightSmall) nextSmall = minRightSmall;
        if (nextSmall < c.rightSmallArcRadius - 1e-6) {
          c.rightSmallArcRadius = nextSmall;
        }
      }

      function shrinkTopLeftSmallToVfe(link) {
        var c = link.circularPathData;
        if (!c) return;
        if (typeof c.targetY !== "number" ||
            typeof c.leftSmallArcRadius !== "number" ||
            typeof c.leftLargeArcRadius !== "number") return;
        var minLeftSmall = baseRadius + (link.width || 0) / 2;
        var nextSmall = c.targetY - c.verticalFullExtent - c.leftLargeArcRadius;
        if (nextSmall < minLeftSmall) nextSmall = minLeftSmall;
        if (nextSmall < c.leftSmallArcRadius - 1e-6) {
          c.leftSmallArcRadius = nextSmall;
        }
      }

      var maxTightenIters = 5;
      topByTarget.forEach(function(grp) {
        if (!grp || grp.length < 2) return;
        for (var itT = 0; itT < maxTightenIters; itT++) {
          var changedT = false;
          grp.sort(function(a, b) {
            return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
          });
          for (var giT = 1; giT < grp.length; giT++) {
            var inner = grp[giT];
            var outer = null;
            for (var kk = giT - 1; kk >= 0; kk--) {
              if (shelvesOverlapX(grp[kk], inner)) { outer = grp[kk]; break; }
            }
            if (!outer) continue;
            var innerW = inner.width || 0;
            var outerW = outer.width || 0;
            var edgeGap = (inner.circularPathData.verticalFullExtent - innerW / 2) -
                          (outer.circularPathData.verticalFullExtent + outerW / 2);
            if (edgeGap <= gap + 1e-6) continue;

            var minAllowed = -Infinity;
            for (var pp = 0; pp < topAllNonSelf.length; pp++) {
              var p = topAllNonSelf[pp];
              if (p === inner) continue;
              if (p.circularPathData.verticalFullExtent >= inner.circularPathData.verticalFullExtent) continue;
              if (!shelvesOverlapX(p, inner)) continue;
              var bnd = p.circularPathData.verticalFullExtent + ((p.width || 0) + innerW) / 2 + gap;
              if (bnd > minAllowed) minAllowed = bnd;
            }
            if (minAllowed === -Infinity) continue;
            var tightenTarget = outer.circularPathData.verticalFullExtent + (outerW + innerW) / 2 + gap;
            if (tightenTarget < minAllowed) tightenTarget = minAllowed;

            if (tightenTarget < inner.circularPathData.verticalFullExtent - 1e-6) {
              var pullUp = inner.circularPathData.verticalFullExtent - tightenTarget;
              inner.circularPathData.verticalFullExtent = tightenTarget;
              if (typeof inner.circularPathData.verticalBuffer === "number") {
                inner.circularPathData.verticalBuffer += pullUp;
              }
              changedT = true;
            }
          }
          if (!changedT) break;
        }
      });

      // Cross-target tightening: after each target-node bundle has been made
      // internally compact, pull the innermost valid shelves down to their
      // ceilings, then pack overlapping outer shelves directly above them.
      for (var itTG = 0; itTG < maxTightenIters; itTG++) {
        var changedTG = false;
        topAllNonSelf.sort(function(a, b) {
          return b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent;
        });
        for (var giTG = 0; giTG < topAllNonSelf.length; giTG++) {
          var link = topAllNonSelf[giTG];
          var linkC = link.circularPathData;
          var linkW = link.width || 0;
          var maxAllowed = topCeilingForTightening(link);

          for (var prevI = 0; prevI < giTG; prevI++) {
            var prevLink = topAllNonSelf[prevI];
            if (!shelvesOverlapX(prevLink, link)) continue;
            var bound = prevLink.circularPathData.verticalFullExtent -
              ((prevLink.width || 0) + linkW) / 2 - gap;
            if (bound < maxAllowed) maxAllowed = bound;
          }

          if (maxAllowed === Infinity) continue;
          if (maxAllowed > linkC.verticalFullExtent + 1e-6) {
            var pullDown = maxAllowed - linkC.verticalFullExtent;
            linkC.verticalFullExtent = maxAllowed;
            shrinkTopRightSmallToVfe(link);
            shrinkTopLeftSmallToVfe(link);
            if (typeof linkC.verticalBuffer === "number") {
              linkC.verticalBuffer -= pullDown;
            }
            syncTopVerticalForTightening(link);
            changedTG = true;
          }
        }
        if (!changedTG) break;
      }
    }
    {
    }

    // Phase 3S: Push non-self TOP links outward past any TOP self-loops.
    // Self-loops at a node should always be the innermost (largest VFE for TOP) arc.
    // This runs after Phase 3C (tightening) so it has the final word on self-loop clearance.
    // We shift all three vertical extent coordinates by the same delta so path geometry stays valid.
    if (gap > 0) {
      var topSelfLoops = topLinks.filter(function(l) { return selfLinking(l, id); });
      var topNonSelf = topLinks.filter(function(l) { return !selfLinking(l, id); });

      topSelfLoops.forEach(function(sl) {
        var slC = sl.circularPathData;
        var slHW = (sl.width || 0) / 2;
        var slNodeId = id(sl.source);
        // Outer (top-most) edge of self-loop for TOP links = VFE - halfWidth
        var slOuterEdge = slC.verticalFullExtent - slHW;

        topNonSelf.forEach(function(ns) {
          // Only links that share the self-loop's node need to clear it
          var nsSrcId = ns.source ? id(ns.source) : null;
          var nsTgtId = ns.target ? id(ns.target) : null;
          if (nsSrcId !== slNodeId && nsTgtId !== slNodeId) return;

          var nsC = ns.circularPathData;
          var nsHW = (ns.width || 0) / 2;

          // ns must be OUTSIDE (smaller VFE) the self-loop outer edge by at least gap
          var maxNsVfe = slOuterEdge - gap - nsHW;

          if (nsC.verticalFullExtent > maxNsVfe + 1e-6) {
            var delta = nsC.verticalFullExtent - maxNsVfe;  // positive
            // Shift all three Y coords outward (decrease = more outer = more upward for TOP)
            nsC.verticalFullExtent -= delta;
            if (typeof nsC.verticalRightInnerExtent === "number") nsC.verticalRightInnerExtent -= delta;
            if (typeof nsC.verticalLeftInnerExtent === "number") nsC.verticalLeftInnerExtent -= delta;
            if (typeof nsC.verticalBuffer === "number") nsC.verticalBuffer += delta;
          }
        });
      });
    }
    {
    }

    // Phase 3J: Final pairwise gap enforcement for bottom links.
    // Catches any remaining overlaps introduced by earlier phases (3D, 3H, 3I).
    // Only pushes individual links, does not reorder or move groups.
    if (gap > 0) {
      var maxFinalIters = 10;
      for (var fIt = 0; fIt < maxFinalIters; fIt++) {
        var fChanged = false;
        bottomLinks.sort(function(a, b) {
          return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
        });
        for (var fi = 0; fi < bottomLinks.length; fi++) {
          var fCurr = bottomLinks[fi];
          if (selfLinking(fCurr, id)) continue;
          var fCurrC = fCurr.circularPathData;
          var fCurrHW = (fCurr.width || 0) / 2;
          var fTargetVfe = fCurrC.verticalFullExtent;

          for (var fj = 0; fj < fi; fj++) {
            var fPrev = bottomLinks[fj];
            if (!needsSeparation(fCurr, fPrev)) continue;
            var fPrevBot = fPrev.circularPathData.verticalFullExtent + (fPrev.width || 0) / 2;
            var fNeed = fPrevBot + gap + fCurrHW;
            if (fNeed > fTargetVfe) fTargetVfe = fNeed;
          }
          if (fTargetVfe > fCurrC.verticalFullExtent + 1e-12) {
            var fDelta = fTargetVfe - fCurrC.verticalFullExtent;
            fCurrC.verticalFullExtent = fTargetVfe;
            if (typeof fCurrC.verticalBuffer === "number") fCurrC.verticalBuffer += fDelta;
            fChanged = true;
          }
        }
        if (!fChanged) break;
      }
    }

    // Phase 3K: Long-span target-node consolidation.
    // Re-stacks long-span links (span >= 3) in target-node-grouped order so
    // same-target links stay contiguous.  Short-span links (span < 3) are
    // treated as fixed anchors — their VFEs are unchanged, preserving arc-leg
    // geometry (avoids the crossing inflation that a global grouped sort causes).
    if (gap > 0) {
      var kSpanThreshold = 3;
      var kLong = [];
      var kFixed = [];
      for (var ki = 0; ki < bottomLinks.length; ki++) {
        var kl = bottomLinks[ki];
        if (selfLinking(kl, id) || linkSpan(kl) < kSpanThreshold) {
          kFixed.push(kl);
        } else {
          kLong.push(kl);
        }
      }

      if (kLong.length > 1) {
        var kGrpMin = {};
        for (var kg = 0; kg < kLong.length; kg++) {
          var kKey = id(kLong[kg].target);
          var kV = kLong[kg].circularPathData.verticalFullExtent;
          if (!(kKey in kGrpMin) || kV < kGrpMin[kKey]) kGrpMin[kKey] = kV;
        }

        kLong.sort(function(a, b) {
          var aCol = a.target.column || 0;
          var bCol = b.target.column || 0;
          if (aCol !== bCol) return bCol - aCol;
          var aK = id(a.target), bK = id(b.target);
          if (aK !== bK) return aK < bK ? -1 : 1;
          return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
        });

        var kPlaced = kFixed.slice();
        var kCurGrpKey = null;
        var kCurGrpMembers = [];

        function kTightenGroup(members) {
          if (members.length < 2) return;
          members.sort(function(a, b) {
            return b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent;
          });
          for (var t = 1; t < members.length; t++) {
            var deeper = members[t - 1];
            var shallower = members[t];
            var dHW = (deeper.width || 0) / 2;
            var sHW = (shallower.width || 0) / 2;
            var pullTarget = deeper.circularPathData.verticalFullExtent - dHW - gap - sHW;
            if (shallower.circularPathData.verticalFullExtent < pullTarget - 1e-12) {
              var pullDelta = pullTarget - shallower.circularPathData.verticalFullExtent;
              shallower.circularPathData.verticalFullExtent = pullTarget;
              if (typeof shallower.circularPathData.verticalBuffer === "number") {
                shallower.circularPathData.verticalBuffer += pullDelta;
              }
            }
          }
        }

        for (var kj = 0; kj < kLong.length; kj++) {
          var kLink = kLong[kj];
          var kLinkKey = id(kLink.target);

          if (kLinkKey !== kCurGrpKey) {
            kTightenGroup(kCurGrpMembers);
            kCurGrpKey = kLinkKey;
            kCurGrpMembers = [];
          }

          var kC = kLink.circularPathData;
          var kHW = (kLink.width || 0) / 2;

          var kMinVfe = -Infinity;
          if (typeof kC.sourceY === "number" &&
              typeof kC.rightSmallArcRadius === "number" &&
              typeof kC.rightLargeArcRadius === "number") {
            kMinVfe = kC.sourceY + kC.rightSmallArcRadius + kC.rightLargeArcRadius + 1e-6;
          }
          if (typeof kC.targetY === "number" &&
              typeof kC.leftSmallArcRadius === "number" &&
              typeof kC.leftLargeArcRadius === "number") {
            var kLeftFloor = kC.targetY + kC.leftSmallArcRadius + kC.leftLargeArcRadius + 1e-6;
            if (kLeftFloor > kMinVfe) kMinVfe = kLeftFloor;
          }

          for (var kp = 0; kp < kPlaced.length; kp++) {
            if (!needsSeparation(kLink, kPlaced[kp])) continue;
            var kPbot = kPlaced[kp].circularPathData.verticalFullExtent +
                        (kPlaced[kp].width || 0) / 2;
            var kNeed = kPbot + gap + kHW;
            if (kNeed > kMinVfe) kMinVfe = kNeed;
          }

          if (kMinVfe !== -Infinity && Math.abs(kMinVfe - kC.verticalFullExtent) > 1e-12) {
            var kDelta = kMinVfe - kC.verticalFullExtent;
            kC.verticalFullExtent = kMinVfe;
            if (typeof kC.verticalBuffer === "number") kC.verticalBuffer += kDelta;
          }
          kPlaced.push(kLink);
          kCurGrpMembers.push(kLink);
        }
        kTightenGroup(kCurGrpMembers);

        // Final gap enforcement after re-stacking.
        for (var kFit = 0; kFit < 10; kFit++) {
          var kFChanged = false;
          bottomLinks.sort(function(a, b) {
            return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
          });
          for (var kFi = 0; kFi < bottomLinks.length; kFi++) {
            var kFC = bottomLinks[kFi];
            if (selfLinking(kFC, id)) continue;
            var kFCC = kFC.circularPathData;
            var kFHW = (kFC.width || 0) / 2;
            var kFTarget = kFCC.verticalFullExtent;
            for (var kFj = 0; kFj < kFi; kFj++) {
              var kFP = bottomLinks[kFj];
              if (!needsSeparation(kFC, kFP)) continue;
              var kFPBot = kFP.circularPathData.verticalFullExtent + (kFP.width || 0) / 2;
              var kFN = kFPBot + gap + kFHW;
              if (kFN > kFTarget) kFTarget = kFN;
            }
            if (kFTarget > kFCC.verticalFullExtent + 1e-12) {
              var kFD = kFTarget - kFCC.verticalFullExtent;
              kFCC.verticalFullExtent = kFTarget;
              if (typeof kFCC.verticalBuffer === "number") kFCC.verticalBuffer += kFD;
              kFChanged = true;
            }
          }
          if (!kFChanged) break;
        }
      }
    }
    // Phase 3L: Push lighter-target bottom links inward.
    // After all stacking and compaction phases, links to lighter (shorter) targets
    // may have been pushed outside heavier-target links by cross-column gap enforcement.
    // This pass tries to move them back inside by finding a valid VFE that satisfies
    // legFloor and separation from all other bottom links while staying shallower
    // than the shallowest heavier-target link in the same target column.
    if (gap > 0) {
      // Group non-self-loop bottom links by target column
      var ltByCol = {};
      bottomLinks.forEach(function(l) {
        if (selfLinking(l, id)) return;
        var col = l.target.column;
        if (!ltByCol[col]) ltByCol[col] = [];
        ltByCol[col].push(l);
      });

      Object.keys(ltByCol).forEach(function(colKey) {
        var colLinks = ltByCol[colKey];

        var targetHeights = {};
        colLinks.forEach(function(l) {
          var tKey = id(l.target);
          var h = (l.target.y1 || 0) - (l.target.y0 || 0);
          targetHeights[tKey] = h;
        });
        var distinctTargets = Object.keys(targetHeights);
        if (distinctTargets.length < 2) return;

        var heaviestKey = distinctTargets[0];
        distinctTargets.forEach(function(k) {
          if (targetHeights[k] > targetHeights[heaviestKey]) heaviestKey = k;
        });

        var heavyLinks = colLinks.filter(function(l) { return id(l.target) === heaviestKey; });
        var lightLinks = colLinks.filter(function(l) { return id(l.target) !== heaviestKey; });
        if (!heavyLinks.length || !lightLinks.length) return;

        var shallowestHeavyVfe = Infinity;
        heavyLinks.forEach(function(l) {
          if (l.circularPathData.verticalFullExtent < shallowestHeavyVfe)
            shallowestHeavyVfe = l.circularPathData.verticalFullExtent;
        });
        var heavyHalfW = 0;
        heavyLinks.forEach(function(l) {
          var hw = (l.width || 0) / 2;
          if (hw > heavyHalfW) heavyHalfW = hw;
        });
        var ceiling = shallowestHeavyVfe - heavyHalfW - gap;

        lightLinks.sort(function(a, b) {
          return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
        });

        for (var li = 0; li < lightLinks.length; li++) {
          var lLink = lightLinks[li];
          var lc = lLink.circularPathData;
          var lHW = (lLink.width || 0) / 2;

          if (lc.verticalFullExtent + lHW <= ceiling) continue;

          var lLegFloor = -Infinity;
          if (typeof lc.sourceY === "number" && typeof lc.rightSmallArcRadius === "number" && typeof lc.rightLargeArcRadius === "number")
            lLegFloor = Math.max(lLegFloor, lc.sourceY + lc.rightSmallArcRadius + lc.rightLargeArcRadius);
          if (typeof lc.targetY === "number" && typeof lc.leftSmallArcRadius === "number" && typeof lc.leftLargeArcRadius === "number")
            lLegFloor = Math.max(lLegFloor, lc.targetY + lc.leftSmallArcRadius + lc.leftLargeArcRadius);

          var minVfe = lLegFloor === -Infinity ? lc.verticalFullExtent : lLegFloor;
          // Only check against other light links in the SAME target column.
          // Cross-column links are ignored — their shelves may overlap in X,
          // but we accept that to achieve the "lighter target inside" goal.
          for (var lj = 0; lj < lightLinks.length; lj++) {
            var other = lightLinks[lj];
            if (other === lLink) continue;
            if (!needsSeparation(lLink, other)) continue;
            var otherVfe = other.circularPathData.verticalFullExtent;
            if (otherVfe >= shallowestHeavyVfe) continue;
            var otherBot = otherVfe + (other.width || 0) / 2;
            var need = otherBot + gap + lHW;
            if (need > minVfe) minVfe = need;
          }

          if (minVfe + lHW <= ceiling && minVfe < lc.verticalFullExtent - 1e-6) {
            var delta = lc.verticalFullExtent - minVfe;
            lc.verticalFullExtent = minVfe;
            if (typeof lc.verticalBuffer === "number") lc.verticalBuffer -= delta;
          }
        }

        // Compact the light-link band: push shallower links deeper (toward ceiling)
        // to close gaps caused by differing legFloor values across spans.
        lightLinks.sort(function(a, b) {
          return b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent;
        });
        for (var ci = 1; ci < lightLinks.length; ci++) {
          var cprev = lightLinks[ci - 1];
          var ccurr = lightLinks[ci];
          var cprevC = cprev.circularPathData;
          var ccurrC = ccurr.circularPathData;
          var compactTarget = cprevC.verticalFullExtent -
            (cprev.width || 0) / 2 - gap - (ccurr.width || 0) / 2;
          if (compactTarget > ccurrC.verticalFullExtent + 1e-6 &&
              compactTarget + (ccurr.width || 0) / 2 <= ceiling) {
            var cdelta = compactTarget - ccurrC.verticalFullExtent;
            ccurrC.verticalFullExtent = compactTarget;
            if (typeof ccurrC.verticalBuffer === "number") ccurrC.verticalBuffer += cdelta;
          }
        }
      });
    }

  })();

  // Re-compact bottom self-loops after all VFE stacking passes.
  // Phase 3A-3K may push self-loops far below their node to avoid collisions
  // with long backlinks. Re-pin them compact and only keep the deeper VFE if
  // there's a real horizontal-shelf collision with a non-self-loop link.
  (function recompactSelfLoops() {
    var gap = circularLinkGap || 0;
    var selfLoops = [];
    var otherBottom = [];
    graph.links.forEach(function(l) {
      if (!l || !l.circular || l.isVirtual) return;
      if (l.circularLinkType !== "bottom") return;
      if (!l.circularPathData) return;
      if (selfLinking(l, id)) {
        selfLoops.push(l);
      } else {
        otherBottom.push(l);
      }
    });

    selfLoops.forEach(function(sl) {
      var node = sl.source;
      if (!node || typeof node.y1 !== "number") return;
      var c = sl.circularPathData;
      var r = typeof c.rightLargeArcRadius === "number"
        ? c.rightLargeArcRadius : (baseRadius + (sl.width || 0) / 2);
      var rightSmall = typeof c.rightSmallArcRadius === "number"
        ? c.rightSmallArcRadius : r;
      var leftLarge = typeof c.leftLargeArcRadius === "number"
        ? c.leftLargeArcRadius : r;
      var leftSmall = typeof c.leftSmallArcRadius === "number"
        ? c.leftSmallArcRadius : leftLarge;
      var sourceY = typeof c.sourceY === "number" ? c.sourceY : node.y1;
      var targetY = typeof c.targetY === "number" ? c.targetY : sourceY;
      var arcFloor = Math.max(
        sourceY + rightSmall + r + gap,
        targetY + leftSmall + leftLarge + gap
      );
      var compactVfe = Math.max(
        node.y1 + Math.max(12, r + 4),
        arcFloor
      );
      if (compactVfe >= c.verticalFullExtent - 1e-6) return;

      var slHW = (sl.width || 0) / 2;
      var slXmin = Math.min(c.leftInnerExtent || c.leftFullExtent,
                            c.rightInnerExtent || c.rightFullExtent);
      var slXmax = Math.max(c.leftInnerExtent || c.leftFullExtent,
                            c.rightInnerExtent || c.rightFullExtent);

      var blocked = false;
      for (var i = 0; i < otherBottom.length; i++) {
        var ob = otherBottom[i];
        var oc = ob.circularPathData;
        if (!oc) continue;
        var obVfe = oc.verticalFullExtent;
        var obHW = (ob.width || 0) / 2;

        if (obVfe + obHW + gap < compactVfe - slHW - 1e-6) continue;
        if (obVfe - obHW - gap > compactVfe + slHW + 1e-6) continue;

        var obXmin = Math.min(oc.leftInnerExtent || oc.leftFullExtent,
                              oc.rightInnerExtent || oc.rightFullExtent);
        var obXmax = Math.max(oc.leftInnerExtent || oc.leftFullExtent,
                              oc.rightInnerExtent || oc.rightFullExtent);
        if (obXmax < slXmin - 1e-6 || obXmin > slXmax + 1e-6) continue;

        blocked = true;
        break;
      }

      if (!blocked) {
        var pullUp = c.verticalFullExtent - compactVfe;
        c.verticalFullExtent = compactVfe;
        if (typeof c.verticalBuffer === "number") {
          c.verticalBuffer = Math.max(0, c.verticalBuffer - pullUp);
        }
      } else {
        // If blocked by a specific link, try to fit just below it.
        var minSafe = compactVfe;
        for (var j = 0; j < otherBottom.length; j++) {
          var ob2 = otherBottom[j];
          var oc2 = ob2.circularPathData;
          if (!oc2) continue;
          var obXmin2 = Math.min(oc2.leftInnerExtent || oc2.leftFullExtent,
                                 oc2.rightInnerExtent || oc2.rightFullExtent);
          var obXmax2 = Math.max(oc2.leftInnerExtent || oc2.leftFullExtent,
                                 oc2.rightInnerExtent || oc2.rightFullExtent);
          if (obXmax2 < slXmin - 1e-6 || obXmin2 > slXmax + 1e-6) continue;
          var obVfe2 = oc2.verticalFullExtent;
          var obHW2 = (ob2.width || 0) / 2;
          var needed = obVfe2 + obHW2 + gap + slHW;
          if (needed > minSafe) minSafe = needed;
        }
        if (minSafe < c.verticalFullExtent - 1e-6) {
          var pull = c.verticalFullExtent - minSafe;
          c.verticalFullExtent = minSafe;
          if (typeof c.verticalBuffer === "number") {
            c.verticalBuffer = Math.max(0, c.verticalBuffer - pull);
          }
        }
      }
    });
  })();

  // Recompute extents that depend on radii and VFE (resolver above may have changed VFE).
  graph.links.forEach(function(link) {
    if (!link.circular || !link.circularPathData) return;
    var c = link.circularPathData;

    c.rightInnerExtent = c.sourceX + c.rightNodeBuffer;
    c.leftInnerExtent = c.targetX - c.leftNodeBuffer;

    c.rightFullExtent = c.sourceX + c.rightLargeArcRadius + c.rightNodeBuffer;
    c.leftFullExtent = c.targetX - c.leftLargeArcRadius - c.leftNodeBuffer;

    if (link.circularLinkType === "bottom") {
      c.verticalRightInnerExtent = c.verticalFullExtent - c.rightLargeArcRadius;
      c.verticalLeftInnerExtent = c.verticalFullExtent - c.leftLargeArcRadius;
    } else {
      c.verticalRightInnerExtent = c.verticalFullExtent + c.rightLargeArcRadius;
      c.verticalLeftInnerExtent = c.verticalFullExtent + c.leftLargeArcRadius;
    }
  });

  // Catch any residual arc-leg crossings not prevented by compaction.
  // The compaction pass uses preliminary VFE; resolveColumnVFE may shift VFEs
  // slightly, leaving small residual violations.  This pass fixes them with the
  // same no-cascade ordering constraint used during compaction.
  (function fixArcLegCrossings() {
    var colBuckets = {};
    graph.links.forEach(function(l) {
      if (!l || !l.circular || l.isVirtual) return;
      if (l.circularLinkType !== "bottom") return;
      if (!l.circularPathData) return;
      var c = l.circularPathData;
      if (typeof c.leftLargeArcRadius !== "number") return;
      var col = l.target && typeof l.target.column === "number" ? l.target.column : -1;
      var k = String(col);
      if (!colBuckets[k]) colBuckets[k] = [];
      colBuckets[k].push(l);
    });

    Object.keys(colBuckets).forEach(function(k) {
      var bucket = colBuckets[k];
      if (bucket.length < 2) return;

      // Sort outermost (smallest lfe) first.
      bucket.sort(function(a, b) {
        return a.circularPathData.leftFullExtent - b.circularPathData.leftFullExtent;
      });

      for (var i = 1; i < bucket.length; i++) {
        var B = bucket[i];
        var cb = B.circularPathData;
        var bInnerX = cb.targetX - (cb.leftNodeBuffer || 0);
        // For bottom links, the left vertical leg is at leftFullExtent.
        // bInnerX (targetX - buffer) is the right end of the arc, not the leg.
        var bLegX = cb.leftFullExtent;
        var bVfe = cb.verticalFullExtent;
        var bHW = (B.width || 0) / 2;
        // y-coordinate where B's left leg starts (at the target node).
        var y1B = typeof B.y1 === "number" ? B.y1
          : (B.target && typeof B.target.y1 === "number" ? B.target.y1 : -Infinity);

        // Compute minimum allowed lfe for B: must not leap past its immediate
        // outer neighbour (prevents order reversal that creates new crossings).
        // We include clearance to prevent overlapping vertical legs.
        var prev = bucket[i - 1];
        var prevLfe = prev.circularPathData.leftFullExtent;
        var prevHW = (prev.width || 0) / 2;
        var currHW = (B.width || 0) / 2;
        var minLfe = prevLfe + prevHW + currHW + (circularLinkGap || 0);
        var maxRadiusFromOrder = bInnerX - minLfe;

        // Find the required minimum radius to eliminate all real arc-leg crossings.
        var rBminRequired = cb.leftLargeArcRadius; // start at current (no change)
        for (var j = 0; j < i; j++) {
          var A = bucket[j];
          var ca = A.circularPathData;
          var aInnerX = ca.targetX - (ca.leftNodeBuffer || 0);
          var aR = ca.leftLargeArcRadius;

          var dx = bLegX - aInnerX;
          if (Math.abs(dx) >= aR) continue; // B's leg outside A's arc x-range

          var yArc = ca.verticalFullExtent - Math.sqrt(aR * aR - dx * dx);

          // Crossing is real only if B's leg [y1B … vLIE_B] spans yArc.
          if (y1B > yArc) continue;

          var bVlie = bVfe - cb.leftLargeArcRadius;
          if (bVlie <= yArc + 1e-4) continue; // no crossing

          var rNeeded = bVfe - yArc;
          if (rNeeded > rBminRequired) rBminRequired = rNeeded;
        }

        // Cap the fix to avoid reversing the sort order.
        var rBminApplied = Math.min(rBminRequired, maxRadiusFromOrder);
        if (rBminApplied <= cb.leftLargeArcRadius + 1e-4) continue;

        var delta = rBminApplied - cb.leftLargeArcRadius;
        cb.leftLargeArcRadius = rBminApplied;
        if (typeof cb.leftSmallArcRadius === "number") {
          cb.leftSmallArcRadius = Math.min(cb.leftSmallArcRadius + delta, rBminApplied);
        }
        cb.leftFullExtent = cb.targetX - rBminApplied - (cb.leftNodeBuffer || 0);
        cb.verticalLeftInnerExtent = bVfe - rBminApplied;
      }
    });
  })();

  // Final pass: reorder TOP links' left-leg positions by target port Y ASC.
  //
  // The greedy placement sorts by target.y0 DESC (correct for BOTTOM, inverted
  // for TOP). After ALL constraint passes are done, we swap LFE slots among
  // TOP links so that higher target ports (shorter legs) are closer to the
  // node. Repack from self-loop anchors because swapping differently-sized
  // links can otherwise recreate a crossing that an earlier pass removed.
  (function reorderTopLeftLegs() {
    var topByCol = {};
    graph.links.forEach(function(l) {
      if (!l || !l.circular || l.isVirtual) return;
      if (l.circularLinkType !== "top") return;
      if (!l.circularPathData) return;
      if (selfLinking(l, id)) return;
      if (typeof l.circularPathData.leftLargeArcRadius !== "number") return;
      var col = l.target && typeof l.target.column === "number" ? l.target.column : -1;
      var k = String(col);
      if (!topByCol[k]) topByCol[k] = [];
      topByCol[k].push(l);
    });

    Object.keys(topByCol).forEach(function(k) {
      var links = topByCol[k];
      if (links.length < 2) return;

      var hasMultipleTargets = false;
      var firstTgt = links[0].target;
      for (var ti = 1; ti < links.length; ti++) {
        if (links[ti].target !== firstTgt) { hasMultipleTargets = true; break; }
      }
      if (!hasMultipleTargets) return;

      // Desired order: target port Y ASC (higher port = closer to node), span ASC.
      var desired = links.slice().sort(function(a, b) {
        var ac = a.circularPathData;
        var bc = b.circularPathData;
        var ay = typeof ac.targetY === "number"
          ? ac.targetY
          : (a.target && typeof a.target.y0 === "number" ? a.target.y0 : 0);
        var by = typeof bc.targetY === "number"
          ? bc.targetY
          : (b.target && typeof b.target.y0 === "number" ? b.target.y0 : 0);
        if (Math.abs(ay - by) > 1e-3) return ay - by;
        var sa = Math.abs((a.source.column || 0) - (a.target.column || 0));
        var sb = Math.abs((b.source.column || 0) - (b.target.column || 0));
        if (sa !== sb) return sa - sb;
        return (a.width || 0) - (b.width || 0);
      });

      // Current order: LFE DESC (closest to node first).
      var current = links.slice().sort(function(a, b) {
        return b.circularPathData.leftFullExtent - a.circularPathData.leftFullExtent;
      });

      // Collect left-leg radii from current positions.
      var slots = current.map(function(l) {
        var c = l.circularPathData;
        return {
          leftLargeArcRadius: c.leftLargeArcRadius,
          leftSmallArcRadius: c.leftSmallArcRadius
        };
      });

      // Reassign: desired[i] gets slot[i]'s radii, then recompute
      // dependent geometry from the link's own VFE / targetX.
      for (var ri = 0; ri < desired.length; ri++) {
        var dl = desired[ri];
        var s = slots[ri];
        var c = dl.circularPathData;
        c.leftLargeArcRadius = s.leftLargeArcRadius;
        c.leftSmallArcRadius = s.leftSmallArcRadius;
        c.leftFullExtent = c.targetX - c.leftLargeArcRadius - (c.leftNodeBuffer || 0);
        if (dl.circularLinkType === "top") {
          c.verticalLeftInnerExtent = c.verticalFullExtent + c.leftLargeArcRadius;
        } else {
          c.verticalLeftInnerExtent = c.verticalFullExtent - c.leftLargeArcRadius;
        }
      }

      // After slot swapping, widths of links in adjacent slots may differ
      // from the originals, breaking the clearance invariant. Compact from
      // innermost outward: each link is placed exactly gap away from its
      // inner neighbor's edge (or at its current position if already fine).
      var gap = circularLinkGap || 0;

      function _updateLeftGeom(link) {
        var c = link.circularPathData;
        c.leftFullExtent = c.targetX - c.leftLargeArcRadius - (c.leftNodeBuffer || 0);
        if (link.circularLinkType === "top") {
          c.verticalLeftInnerExtent = c.verticalFullExtent + c.leftLargeArcRadius;
        } else {
          c.verticalLeftInnerExtent = c.verticalFullExtent - c.leftLargeArcRadius;
        }
      }

      var sorted = desired;
      var selfLoops = graph.links.filter(function(l) {
        return l && l.circular && !l.isVirtual &&
          l.circularLinkType === "top" &&
          l.circularPathData &&
          selfLinking(l, id) &&
          l.target && String(l.target.column) === k;
      });

      function _leftLegsOverlapY(a, b) {
        var ac = a.circularPathData;
        var bc = b.circularPathData;
        var a0 = Math.min(ac.targetY, ac.verticalLeftInnerExtent);
        var a1 = Math.max(ac.targetY, ac.verticalLeftInnerExtent);
        var b0 = Math.min(bc.targetY, bc.verticalLeftInnerExtent);
        var b1 = Math.max(bc.targetY, bc.verticalLeftInnerExtent);
        return Math.min(a1, b1) > Math.max(a0, b0) + 1e-6;
      }

      for (var si = 0; si < sorted.length; si++) {
        var outer = sorted[si];
        var oC = outer.circularPathData;
        var oHW = (outer.width || 0) / 2;
        var idealLfe = oC.leftFullExtent;
        var constrained = false;

        if (si > 0) {
          var inner = sorted[si - 1];
          var iC = inner.circularPathData;
          var iHW = (inner.width || 0) / 2;
          idealLfe = iC.leftFullExtent - iHW - gap - oHW;
          constrained = true;
        }

        selfLoops.forEach(function(loop) {
          if (!_leftLegsOverlapY(outer, loop)) return;
          var loopC = loop.circularPathData;
          var loopHW = (loop.width || 0) / 2;
          var outsideLoop =
            loopC.leftFullExtent - loopHW - gap - oHW;
          if (!constrained || outsideLoop < idealLfe) {
            idealLfe = outsideLoop;
            constrained = true;
          }
        });

        if (!constrained) continue;
        if (idealLfe < oC.leftFullExtent) {
          var delta = oC.leftFullExtent - idealLfe;
          oC.leftLargeArcRadius += delta;
          if (typeof oC.leftSmallArcRadius === "number") {
            oC.leftSmallArcRadius += delta;
            if (oC.leftSmallArcRadius > oC.leftLargeArcRadius)
              oC.leftSmallArcRadius = oC.leftLargeArcRadius;
          }
          _updateLeftGeom(outer);
        } else if (idealLfe > oC.leftFullExtent + 1e-6) {
          var pull = idealLfe - oC.leftFullExtent;
          oC.leftLargeArcRadius -= pull;
          var minR = baseRadius + oHW;
          if (oC.leftLargeArcRadius < minR) oC.leftLargeArcRadius = minR;
          if (typeof oC.leftSmallArcRadius === "number") {
            oC.leftSmallArcRadius -= pull;
            if (oC.leftSmallArcRadius < 0) oC.leftSmallArcRadius = 0;
            if (oC.leftSmallArcRadius > oC.leftLargeArcRadius)
              oC.leftSmallArcRadius = oC.leftLargeArcRadius;
          }
          _updateLeftGeom(outer);
        }
      }
    });
  })();

  // Ensure VFE and LFE ordering consistency for same-target TOP links.
  // For TOP links, outer shelf (smaller VFE) must pair with outer left leg
  // (smaller LFE) to prevent arc crossings before the left vertical leg.
  (function alignTopLeftLegWithVFE() {
    var byTarget = new Map();
    graph.links.forEach(function(l) {
      if (!l || !l.circular || l.isVirtual) return;
      if (l.circularLinkType !== "top") return;
      if (!l.circularPathData) return;
      if (selfLinking(l, id)) return;
      if (!l.target) return;
      var arr = byTarget.get(l.target);
      if (!arr) { arr = []; byTarget.set(l.target, arr); }
      arr.push(l);
    });

    byTarget.forEach(function(grp) {
      if (grp.length < 2) return;

      var vfeOrder = grp.slice().sort(function(a, b) {
        return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
      });
      var lfeOrder = grp.slice().sort(function(a, b) {
        return a.circularPathData.leftFullExtent - b.circularPathData.leftFullExtent;
      });

      var needSwap = false;
      for (var i = 0; i < vfeOrder.length; i++) {
        if (vfeOrder[i] !== lfeOrder[i]) { needSwap = true; break; }
      }
      if (!needSwap) return;

      var slots = lfeOrder.map(function(l) {
        var c = l.circularPathData;
        return {
          leftLargeArcRadius: c.leftLargeArcRadius,
          leftSmallArcRadius: c.leftSmallArcRadius
        };
      });

      for (var i = 0; i < vfeOrder.length; i++) {
        var link = vfeOrder[i];
        var s = slots[i];
        var c = link.circularPathData;
        c.leftLargeArcRadius = s.leftLargeArcRadius;
        c.leftSmallArcRadius = s.leftSmallArcRadius;
        c.leftFullExtent = c.targetX - c.leftLargeArcRadius - (c.leftNodeBuffer || 0);
        c.verticalLeftInnerExtent = c.verticalFullExtent + c.leftLargeArcRadius;
      }
    });
  })();

  // Final pass: enforce visual gap for sub-pixel circular links.
  // SVG anti-aliasing renders strokes of width < 1px as ~1px wide, so we
  // treat visual half-width as max(width, 1)/2 for gap enforcement.
  // Only enforce the gap when two links actually overlap in X (shelf range);
  // links on non-overlapping x-positions can share the same VFE level safely.
  function _shelfX(link) {
    var c = link.circularPathData || {};
    var x0 = typeof c.leftInnerExtent === "number" ? c.leftInnerExtent : 0;
    var x1 = typeof c.rightInnerExtent === "number" ? c.rightInnerExtent : 0;
    return { x0: Math.min(x0, x1), x1: Math.max(x0, x1) };
  }
  function _shelvesOverlapX(a, b) {
    var ax = _shelfX(a);
    var bx = _shelfX(b);
    return Math.min(ax.x1, bx.x1) - Math.max(ax.x0, bx.x0) > 1e-6;
  }

  ["bottom", "top"].forEach(function(band) {
    var bandLinks = graph.links.filter(function(l) {
      return l && l.circular && l.circularLinkType === band &&
             l.circularPathData && typeof l.circularPathData.verticalFullExtent === "number";
    });
    if (!bandLinks.length) return;
    var isBottom = (band === "bottom");
    var gap = circularLinkGap || 0;
    var maxIter = 20;
    for (var iter = 0; iter < maxIter; iter++) {
      bandLinks.sort(function(a, b) {
        var aVFE = a.circularPathData.verticalFullExtent;
        var bVFE = b.circularPathData.verticalFullExtent;
        return isBottom ? (aVFE - bVFE) : (bVFE - aVFE);
      });
      var changed = false;
      for (var i = 1; i < bandLinks.length; i++) {
        var prev = bandLinks[i - 1];
        var curr = bandLinks[i];
        // Skip if shelves don't overlap in X — no visual conflict possible
        if (!_shelvesOverlapX(prev, curr)) continue;
        var prevVFE = prev.circularPathData.verticalFullExtent;
        var currVFE = curr.circularPathData.verticalFullExtent;
        var prevVisHW = Math.max(prev.width || 0, 1) / 2;
        var currVisHW = Math.max(curr.width || 0, 1) / 2;
        var visualEdgeGap = Math.abs(currVFE - prevVFE) - prevVisHW - currVisHW;
        if (visualEdgeGap < gap - 1e-6) {
          var deficit = gap - visualEdgeGap;
          var c = curr.circularPathData;
          if (isBottom) {
            c.verticalFullExtent += deficit;
          } else {
            c.verticalFullExtent -= deficit;
          }
          if (typeof c.verticalBuffer === "number") {
            c.verticalBuffer += deficit;
          }
          c.verticalRightInnerExtent = isBottom
            ? c.verticalFullExtent - c.rightLargeArcRadius
            : c.verticalFullExtent + c.rightLargeArcRadius;
          c.verticalLeftInnerExtent = isBottom
            ? c.verticalFullExtent - c.leftLargeArcRadius
            : c.verticalFullExtent + c.leftLargeArcRadius;
          changed = true;
        }
      }
      if (!changed) break;
    }
  });

  // Final pass: keep target-node bundles contiguous in each circular band.
  // The global gap/visual passes operate pairwise and can place links from a
  // smaller target group between links that share the same target. If there is
  // room around the larger bundle, move the smaller group outside its interval.
  (function enforceTargetBundleContiguity() {
    var gap = circularLinkGap || 0;
    if (gap <= 0) return;

    function syncVerticalExtents(link) {
      var c = link.circularPathData;
      if (!c) return;
      if (link.circularLinkType === "bottom") {
        if (typeof c.rightLargeArcRadius === "number") {
          c.verticalRightInnerExtent = c.verticalFullExtent - c.rightLargeArcRadius;
        }
        if (typeof c.leftLargeArcRadius === "number") {
          c.verticalLeftInnerExtent = c.verticalFullExtent - c.leftLargeArcRadius;
        }
      } else {
        if (typeof c.rightLargeArcRadius === "number") {
          c.verticalRightInnerExtent = c.verticalFullExtent + c.rightLargeArcRadius;
        }
        if (typeof c.leftLargeArcRadius === "number") {
          c.verticalLeftInnerExtent = c.verticalFullExtent + c.leftLargeArcRadius;
        }
      }
    }

    function setVerticalFullExtent(link, nextVfe) {
      var c = link.circularPathData;
      if (!c || !isFinite(nextVfe)) return false;
      var delta = nextVfe - c.verticalFullExtent;
      if (Math.abs(delta) <= 1e-9) return false;
      c.verticalFullExtent = nextVfe;
      if (typeof c.verticalBuffer === "number") {
        c.verticalBuffer += link.circularLinkType === "bottom" ? delta : -delta;
      }
      syncVerticalExtents(link);
      return true;
    }

    function bottomLegFloor(link) {
      var c = link.circularPathData;
      var floor = -Infinity;
      var halfW = (link.width || 0) / 2;
      if (typeof c.sourceY === "number" &&
          typeof c.rightSmallArcRadius === "number" &&
          typeof c.rightLargeArcRadius === "number") {
        floor = Math.max(floor, c.sourceY + c.rightSmallArcRadius + c.rightLargeArcRadius + 1e-6);
      }
      if (typeof c.targetY === "number" &&
          typeof c.leftSmallArcRadius === "number" &&
          typeof c.leftLargeArcRadius === "number") {
        floor = Math.max(floor, c.targetY + c.leftSmallArcRadius + c.leftLargeArcRadius + 1e-6);
      }
      var shelfX1 = Math.min(
        typeof c.leftInnerExtent === "number" ? c.leftInnerExtent : (c.targetX || 0),
        typeof c.rightInnerExtent === "number" ? c.rightInnerExtent : (c.sourceX || 0)
      );
      var shelfX2 = Math.max(
        typeof c.leftInnerExtent === "number" ? c.leftInnerExtent : (c.targetX || 0),
        typeof c.rightInnerExtent === "number" ? c.rightInnerExtent : (c.sourceX || 0)
      );
      var srcId = link.source ? id(link.source) : null;
      var tgtId = link.target ? id(link.target) : null;
      for (var ni = 0; ni < graph.nodes.length; ni++) {
        var nd = graph.nodes[ni];
        if (!nd || nd.virtual) continue;
        if (id(nd) === srcId || id(nd) === tgtId) continue;
        if (typeof nd.x0 !== "number" || typeof nd.x1 !== "number") continue;
        if (typeof nd.y1 !== "number") continue;
        if (nd.x1 <= shelfX1 || nd.x0 >= shelfX2) continue;
        floor = Math.max(floor, nd.y1 + gap + halfW);
      }
      return floor;
    }

    function topLegCeiling(link) {
      var c = link.circularPathData;
      var ceiling = Infinity;
      var halfW = (link.width || 0) / 2;
      if (typeof c.sourceY === "number" &&
          typeof c.rightSmallArcRadius === "number" &&
          typeof c.rightLargeArcRadius === "number") {
        ceiling = Math.min(ceiling, c.sourceY - c.rightSmallArcRadius - c.rightLargeArcRadius - 1e-6);
      }
      if (typeof c.targetY === "number" &&
          typeof c.leftSmallArcRadius === "number" &&
          typeof c.leftLargeArcRadius === "number") {
        ceiling = Math.min(ceiling, c.targetY - c.leftSmallArcRadius - c.leftLargeArcRadius - 1e-6);
      }
      var shelfX1 = Math.min(
        typeof c.leftInnerExtent === "number" ? c.leftInnerExtent : (c.targetX || 0),
        typeof c.rightInnerExtent === "number" ? c.rightInnerExtent : (c.sourceX || 0)
      );
      var shelfX2 = Math.max(
        typeof c.leftInnerExtent === "number" ? c.leftInnerExtent : (c.targetX || 0),
        typeof c.rightInnerExtent === "number" ? c.rightInnerExtent : (c.sourceX || 0)
      );
      var srcId = link.source ? id(link.source) : null;
      var tgtId = link.target ? id(link.target) : null;
      for (var ni = 0; ni < graph.nodes.length; ni++) {
        var nd = graph.nodes[ni];
        if (!nd || nd.virtual) continue;
        if (id(nd) === srcId || id(nd) === tgtId) continue;
        if (typeof nd.x0 !== "number" || typeof nd.x1 !== "number") continue;
        if (typeof nd.y0 !== "number") continue;
        if (nd.x1 <= shelfX1 || nd.x0 >= shelfX2) continue;
        ceiling = Math.min(ceiling, nd.y0 - gap - halfW);
      }
      return ceiling;
    }

    ["bottom", "top"].forEach(function(band) {
      var isBottom = band === "bottom";
      var bandLinks = graph.links.filter(function(l) {
        return l && l.circular && l.circularLinkType === band && !l.isVirtual &&
               !selfLinking(l, id) && l.target && l.circularPathData &&
               typeof l.circularPathData.verticalFullExtent === "number";
      });
      if (bandLinks.length < 3) return;

      var byTarget = new Map();
      bandLinks.forEach(function(l) {
        var arr = byTarget.get(l.target);
        if (!arr) { arr = []; byTarget.set(l.target, arr); }
        arr.push(l);
      });

      var targetSizes = new Map();
      byTarget.forEach(function(arr, target) {
        targetSizes.set(target, arr.length);
      });

      for (var iter = 0; iter < 8; iter++) {
        var changed = false;
        var ordered = bandLinks.slice().sort(function(a, b) {
          var av = a.circularPathData.verticalFullExtent;
          var bv = b.circularPathData.verticalFullExtent;
          return isBottom ? av - bv : bv - av;
        });

        byTarget.forEach(function(bundle, target) {
          if (changed || !bundle || bundle.length < 2) return;

          var minIdx = Infinity;
          var maxIdx = -Infinity;
          for (var bi = 0; bi < ordered.length; bi++) {
            if (ordered[bi].target !== target) continue;
            if (bi < minIdx) minIdx = bi;
            if (bi > maxIdx) maxIdx = bi;
          }
          if (!isFinite(minIdx) || maxIdx - minIdx < 2) return;

          var intruder = null;
          for (var oi = minIdx + 1; oi < maxIdx; oi++) {
            var candidate = ordered[oi];
            if (candidate.target === target) continue;
            // Avoid dragging an equally-large target bundle through another.
            // Larger bundles own their interval; smaller bundles/singletons may move around them.
            if ((targetSizes.get(candidate.target) || 0) >= bundle.length) continue;
            intruder = candidate;
            break;
          }
          if (!intruder) return;

          var hw = (intruder.width || 0) / 2;

          if (isBottom) {
            var maxInnerVfe = Infinity;
            bundle.forEach(function(member) {
              var mHW = (member.width || 0) / 2;
              var bound = member.circularPathData.verticalFullExtent - mHW - gap - hw;
              if (bound < maxInnerVfe) maxInnerVfe = bound;
            });

            var minInnerVfe = bottomLegFloor(intruder);
            for (var pi = 0; pi < minIdx; pi++) {
              var prev = ordered[pi];
              if (!_shelvesOverlapX(intruder, prev)) continue;
              var prevBound = prev.circularPathData.verticalFullExtent + (prev.width || 0) / 2 + gap + hw;
              if (prevBound > minInnerVfe) minInnerVfe = prevBound;
            }

            if (minInnerVfe <= maxInnerVfe + 1e-6) {
              changed = setVerticalFullExtent(intruder, maxInnerVfe) || changed;
            }
          } else {
            var minInnerTopVfe = -Infinity;
            bundle.forEach(function(member) {
              var mHW = (member.width || 0) / 2;
              var bound = member.circularPathData.verticalFullExtent + mHW + gap + hw;
              if (bound > minInnerTopVfe) minInnerTopVfe = bound;
            });

            var maxInnerTopVfe = topLegCeiling(intruder);
            for (var ti = 0; ti < minIdx; ti++) {
              var prevTop = ordered[ti];
              if (!_shelvesOverlapX(intruder, prevTop)) continue;
              var prevTopBound = prevTop.circularPathData.verticalFullExtent - (prevTop.width || 0) / 2 - gap - hw;
              if (prevTopBound < maxInnerTopVfe) maxInnerTopVfe = prevTopBound;
            }

            if (minInnerTopVfe <= maxInnerTopVfe + 1e-6) {
              changed = setVerticalFullExtent(intruder, minInnerTopVfe) || changed;
            }
          }
        });

        if (!changed) break;
      }
    });

    function targetName(link) {
      return link && link.target && (link.target.name || id(link.target));
    }

    function enforceSearchTargetAdjacency(band) {
      var isBottom = band === "bottom";
      var bandLinks = graph.links.filter(function(l) {
        return l && l.circular && l.circularLinkType === band && !l.isVirtual &&
               !selfLinking(l, id) && l.target && l.circularPathData &&
               typeof l.circularPathData.verticalFullExtent === "number";
      });
      if (bandLinks.length < 3) return;

      var first = [];
      var second = [];
      bandLinks.forEach(function(l) {
        var name = targetName(l);
        if (name === "search_with_baggage_filter") first.push(l);
        if (name === "search") second.push(l);
      });
      if (!first.length || !second.length) return;

      var ordered = bandLinks.slice().sort(function(a, b) {
        var av = a.circularPathData.verticalFullExtent;
        var bv = b.circularPathData.verticalFullExtent;
        return isBottom ? av - bv : bv - av;
      });

      function indexRange(group) {
        var lo = Infinity;
        var hi = -Infinity;
        for (var i = 0; i < ordered.length; i++) {
          if (group.indexOf(ordered[i]) < 0) continue;
          if (i < lo) lo = i;
          if (i > hi) hi = i;
        }
        return { lo: lo, hi: hi };
      }

      var firstRange = indexRange(first);
      var secondRange = indexRange(second);
      if (!isFinite(firstRange.lo) || !isFinite(secondRange.lo)) return;
      // For BOTTOM, we also want these search bundles to be the outermost/deepest group,
      // so keep processing even if they are already adjacent.

      if (isBottom) {
        first.sort(function(a, b) {
          return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
        });
        second.sort(function(a, b) {
          return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
        });

        var protectedBottom = first.concat(second);
        var bottomEdge = -Infinity;
        bandLinks
          .filter(function(l) { return protectedBottom.indexOf(l) < 0; })
          .forEach(function(l) {
            var edge = l.circularPathData.verticalFullExtent + (l.width || 0) / 2;
            if (edge > bottomEdge) bottomEdge = edge;
          });
        if (bottomEdge === -Infinity) bottomEdge = 0;

        first.forEach(function(l) {
          var hw = (l.width || 0) / 2;
          var next = bottomEdge + gap + hw;
          var floor = bottomLegFloor(l);
          if (floor > next) next = floor;
          setVerticalFullExtent(l, next);
          var edge = l.circularPathData.verticalFullExtent + hw;
          if (edge > bottomEdge) bottomEdge = edge;
        });

        second.forEach(function(l) {
          var hw = (l.width || 0) / 2;
          var next = bottomEdge + gap + hw;
          var floor = bottomLegFloor(l);
          if (floor > next) next = floor;
          setVerticalFullExtent(l, next);
          bottomEdge = l.circularPathData.verticalFullExtent + hw;
        });
      } else {
        first.sort(function(a, b) {
          return b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent;
        });
        second.sort(function(a, b) {
          return b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent;
        });

        var topEdge = Infinity;
        second.forEach(function(l) {
          var edge = l.circularPathData.verticalFullExtent - (l.width || 0) / 2;
          if (edge < topEdge) topEdge = edge;
        });
        if (topEdge === Infinity) topEdge = 0;

        first.forEach(function(l) {
          var hw = (l.width || 0) / 2;
          var next = topEdge - gap - hw;
          var ceiling = topLegCeiling(l);
          if (ceiling < next) next = ceiling;
          setVerticalFullExtent(l, next);
          topEdge = l.circularPathData.verticalFullExtent - hw;
        });
      }
    }

    enforceSearchTargetAdjacency("bottom");
    enforceSearchTargetAdjacency("top");
  })();

  // Final cross-band RIGHT-leg clearance. The earlier source-column pass runs
  // before VFE compaction and only compares adjacent slots. Final VFE moves can
  // make non-adjacent TOP/BOTTOM legs overlap, so resolve those pairs once their
  // vertical ranges are stable and before terminal floors/ceilings are tightened.
  (function enforceFinalCrossBandRightLegClearance() {
    var gap = circularLinkGap || 0;
    if (gap <= 0) return;

    var bySourceColumn = {};
    graph.links.forEach(function(link) {
      if (!link || !link.circular || link.isVirtual ||
          selfLinking(link, id) || !link.circularPathData) return;
      var column =
        link.source && typeof link.source.column === "number"
          ? String(link.source.column)
          : String(link.circularPathData.sourceX);
      if (!bySourceColumn[column]) bySourceColumn[column] = [];
      bySourceColumn[column].push(link);
    });

    function rightLegSegment(link) {
      var c = link.circularPathData;
      return [
        Math.min(c.sourceY, c.verticalRightInnerExtent),
        Math.max(c.sourceY, c.verticalRightInnerExtent)
      ];
    }

    function setRightLegSlot(link, nextRfe) {
      var c = link.circularPathData;
      var delta = nextRfe - c.rightFullExtent;
      if (Math.abs(delta) <= 1e-6) return;
      var minRadius = baseRadius + (link.width || 0) / 2;
      if (c.rightLargeArcRadius + delta < minRadius) {
        delta = minRadius - c.rightLargeArcRadius;
      }
      c.rightLargeArcRadius += delta;
      if (typeof c.rightSmallArcRadius === "number") {
        c.rightSmallArcRadius += delta;
        if (c.rightSmallArcRadius < minRadius) {
          c.rightSmallArcRadius = minRadius;
        }
        if (c.rightSmallArcRadius > c.rightLargeArcRadius) {
          c.rightSmallArcRadius = c.rightLargeArcRadius;
        }
      }
      c.rightFullExtent =
        c.sourceX + c.rightLargeArcRadius + (c.rightNodeBuffer || 0);
      c.verticalRightInnerExtent =
        link.circularLinkType === "bottom"
          ? c.verticalFullExtent - c.rightLargeArcRadius
          : c.verticalFullExtent + c.rightLargeArcRadius;
    }

    Object.keys(bySourceColumn).forEach(function(column) {
      var group = bySourceColumn[column];
      if (group.length < 2) return;

      var bottomBySource = new Map();
      group.forEach(function(link) {
        if (link.circularLinkType !== "bottom" || !link.source) return;
        var sourceGroup = bottomBySource.get(link.source);
        if (!sourceGroup) {
          sourceGroup = [];
          bottomBySource.set(link.source, sourceGroup);
        }
        sourceGroup.push(link);
      });

      bottomBySource.forEach(function(bottomBundle, sourceNode) {
        var blockers = group.filter(function(candidate) {
          if (candidate.circularLinkType !== "top" ||
              candidate.source === sourceNode) return false;
          var candidateSeg = rightLegSegment(candidate);
          return bottomBundle.some(function(bottomLink) {
            var bottomSeg = rightLegSegment(bottomLink);
            return Math.min(candidateSeg[1], bottomSeg[1]) -
              Math.max(candidateSeg[0], bottomSeg[0]) > 1e-6;
          });
        });
        if (!blockers.length) return;

        bottomBundle.sort(function(a, b) {
          var aSpan = Math.abs(a.source.column - a.target.column);
          var bSpan = Math.abs(b.source.column - b.target.column);
          if (aSpan !== bSpan) return aSpan - bSpan;
          return a.circularPathData.rightFullExtent -
            b.circularPathData.rightFullExtent;
        });

        var nextInnerEdge = -Infinity;
        blockers.forEach(function(blocker) {
          var hw = (blocker.width || 0) / 2;
          nextInnerEdge = Math.max(
            nextInnerEdge,
            blocker.circularPathData.rightFullExtent + hw
          );
        });
        nextInnerEdge += gap;

        bottomBundle.forEach(function(link) {
          var hw = (link.width || 0) / 2;
          var nextRfe = Math.max(
            link.circularPathData.rightFullExtent,
            nextInnerEdge + hw
          );
          setRightLegSlot(link, nextRfe);
          nextInnerEdge =
            link.circularPathData.rightFullExtent + hw + gap;
        });
      });
    });
  })();

  // Final bottom cross-target tightening. Earlier bottom phases can restore
  // target-bundle contiguity by pushing links outward; close the remaining
  // visual gaps between neighboring shelves that really overlap in X.
  (function tightenBottomAcrossTargets() {
    var gap = circularLinkGap || 0;
    if (gap <= 0) return;

    var bottom = graph.links.filter(function(l) {
      return l && l.circular && l.circularLinkType === "bottom" && !l.isVirtual &&
             !selfLinking(l, id) && l.circularPathData &&
             typeof l.circularPathData.verticalFullExtent === "number";
    });
    if (bottom.length < 2) return;

    var bottomSelfLoops = graph.links.filter(function(l) {
      return l && l.circular && l.circularLinkType === "bottom" && !l.isVirtual &&
             selfLinking(l, id) && l.circularPathData &&
             typeof l.circularPathData.verticalFullExtent === "number";
    });

    function syncBottomVertical(link) {
      var c = link.circularPathData;
      if (!c) return;
      if (typeof c.rightLargeArcRadius === "number") {
        c.verticalRightInnerExtent = c.verticalFullExtent - c.rightLargeArcRadius;
      }
      if (typeof c.leftLargeArcRadius === "number") {
        c.verticalLeftInnerExtent = c.verticalFullExtent - c.leftLargeArcRadius;
      }
    }

    function bottomFloor(link) {
      var c = link.circularPathData;
      var halfW = (link.width || 0) / 2;
      var floor = -Infinity;
      if (typeof c.sourceY === "number" &&
          typeof c.rightSmallArcRadius === "number" &&
          typeof c.rightLargeArcRadius === "number") {
        floor = Math.max(
          floor,
          c.sourceY + c.rightSmallArcRadius + c.rightLargeArcRadius + gap
        );
      }
      if (typeof c.targetY === "number" &&
          typeof c.leftSmallArcRadius === "number" &&
          typeof c.leftLargeArcRadius === "number") {
        floor = Math.max(
          floor,
          c.targetY + c.leftSmallArcRadius + c.leftLargeArcRadius + gap
        );
      }

      var xr = _shelfX(link);
      if (xr) {
        var srcId = link.source ? id(link.source) : null;
        var tgtId = link.target ? id(link.target) : null;
        for (var ni = 0; ni < graph.nodes.length; ni++) {
          var nd = graph.nodes[ni];
          if (!nd || nd.virtual) continue;
          if (id(nd) === srcId || id(nd) === tgtId) continue;
          if (typeof nd.x0 !== "number" || typeof nd.x1 !== "number") continue;
          if (typeof nd.y1 !== "number") continue;
          if (nd.x1 <= xr.x0 || nd.x0 >= xr.x1) continue;
          floor = Math.max(floor, nd.y1 + gap + halfW);
        }

        for (var si = 0; si < bottomSelfLoops.length; si++) {
          var sl = bottomSelfLoops[si];
          if (!_shelvesOverlapX(sl, link)) continue;
          floor = Math.max(
            floor,
            sl.circularPathData.verticalFullExtent + (sl.width || 0) / 2 + gap + halfW
          );
        }
      }
      return floor;
    }

    function shrinkBottomRightSmallToVfe(link) {
      var c = link.circularPathData;
      if (!c) return;
      if (typeof c.sourceY !== "number" ||
          typeof c.rightSmallArcRadius !== "number" ||
          typeof c.rightLargeArcRadius !== "number") return;
      var minRightSmall = baseRadius + (link.width || 0) / 2;
      var nextSmall = c.verticalFullExtent - c.sourceY - c.rightLargeArcRadius;
      if (nextSmall < minRightSmall) nextSmall = minRightSmall;
      if (nextSmall < c.rightSmallArcRadius - 1e-6) {
        c.rightSmallArcRadius = nextSmall;
      }
    }

    function shrinkBottomLeftSmallToVfe(link) {
      var c = link.circularPathData;
      if (!c) return;
      if (typeof c.targetY !== "number" ||
          typeof c.leftSmallArcRadius !== "number" ||
          typeof c.leftLargeArcRadius !== "number") return;
      var minLeftSmall = baseRadius + (link.width || 0) / 2;
      var nextSmall = c.verticalFullExtent - c.targetY - c.leftLargeArcRadius;
      if (nextSmall < minLeftSmall) nextSmall = minLeftSmall;
      if (nextSmall < c.leftSmallArcRadius - 1e-6) {
        c.leftSmallArcRadius = nextSmall;
      }
    }

    function setBottomRightFullExtent(link, nextRfe) {
      var c = link.circularPathData;
      var delta = nextRfe - c.rightFullExtent;
      if (delta <= 1e-6) return false;
      c.rightLargeArcRadius += delta;
      if (typeof c.rightSmallArcRadius === "number") {
        c.rightSmallArcRadius += delta;
        if (c.rightSmallArcRadius > c.rightLargeArcRadius) {
          c.rightSmallArcRadius = c.rightLargeArcRadius;
        }
      }
      c.rightFullExtent =
        c.sourceX + c.rightLargeArcRadius + (c.rightNodeBuffer || 0);
      var sourceTurnFloor =
        c.sourceY +
        c.rightSmallArcRadius +
        c.rightLargeArcRadius +
        gap;
      if (c.verticalFullExtent < sourceTurnFloor - 1e-6) {
        var floorDelta = sourceTurnFloor - c.verticalFullExtent;
        c.verticalFullExtent = sourceTurnFloor;
        if (typeof c.verticalBuffer === "number") {
          c.verticalBuffer += floorDelta;
        }
      }
      syncBottomVertical(link);
      return true;
    }

    var bottomBySource = new Map();
    bottom.forEach(function(link) {
      if (!link.source) return;
      var sourceGroup = bottomBySource.get(link.source);
      if (!sourceGroup) {
        sourceGroup = [];
        bottomBySource.set(link.source, sourceGroup);
      }
      sourceGroup.push(link);
    });

    bottomBySource.forEach(function(sourceGroup) {
      if (sourceGroup.length < 2) return;
      sourceGroup.sort(function(a, b) {
        var aSpan = Math.abs(a.source.column - a.target.column);
        var bSpan = Math.abs(b.source.column - b.target.column);
        if (aSpan !== bSpan) return aSpan - bSpan;
        return a.circularPathData.rightFullExtent -
          b.circularPathData.rightFullExtent;
      });

      for (var sourceIndex = 1;
           sourceIndex < sourceGroup.length;
           sourceIndex++) {
        var inner = sourceGroup[sourceIndex - 1];
        var outer = sourceGroup[sourceIndex];
        if (!_shelvesOverlapX(inner, outer)) continue;
        var minOuterVfe =
          inner.circularPathData.verticalFullExtent +
          ((inner.width || 0) + (outer.width || 0)) / 2 +
          gap;
        var outerC = outer.circularPathData;
        if (outerC.verticalFullExtent >= minOuterVfe - 1e-6) continue;
        var sourceDelta = minOuterVfe - outerC.verticalFullExtent;
        outerC.verticalFullExtent = minOuterVfe;
        if (typeof outerC.verticalBuffer === "number") {
          outerC.verticalBuffer += sourceDelta;
        }
        syncBottomVertical(outer);
      }
    });

    for (var iter = 0; iter < 10; iter++) {
      var changed = false;
      bottom.sort(function(a, b) {
        return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
      });

      for (var i = 0; i < bottom.length; i++) {
        var link = bottom[i];
        var c = link.circularPathData;
        var linkW = link.width || 0;
        var minAllowed = bottomFloor(link);

        for (var j = 0; j < i; j++) {
          var prev = bottom[j];
          if (!_shelvesOverlapX(prev, link)) continue;
          var bound = prev.circularPathData.verticalFullExtent +
            ((prev.width || 0) + linkW) / 2 + gap;
          if (bound > minAllowed) minAllowed = bound;
        }

        if (minAllowed !== -Infinity &&
            Math.abs(minAllowed - c.verticalFullExtent) > 1e-6) {
          var delta = minAllowed - c.verticalFullExtent;
          c.verticalFullExtent = minAllowed;
          if (delta < 0) {
            shrinkBottomRightSmallToVfe(link);
            shrinkBottomLeftSmallToVfe(link);
          }
          if (typeof c.verticalBuffer === "number") c.verticalBuffer += delta;
          syncBottomVertical(link);
          changed = true;
        }
      }

      if (!changed) break;
    }

    // Final VFE compaction defines which bottom shelf is outer. Keep the
    // same-target right-leg nesting in that same order; the earlier right-leg
    // phase ran before these shelves reached their final vertical positions.
    var bottomBySourceColumn = {};
    bottom.forEach(function(link) {
        var sourceColumn =
          link.source && typeof link.source.column === "number"
            ? String(link.source.column)
            : String(link.circularPathData.sourceX);
        sourceColumn += "|" + String(link.target ? id(link.target) : "");
        if (!bottomBySourceColumn[sourceColumn]) {
          bottomBySourceColumn[sourceColumn] = [];
        }
        bottomBySourceColumn[sourceColumn].push(link);
    });
    Object.keys(bottomBySourceColumn).forEach(function(sourceColumn) {
        var sourceColumnLinks = bottomBySourceColumn[sourceColumn];
        sourceColumnLinks.sort(function(a, b) {
          return a.circularPathData.verticalFullExtent -
            b.circularPathData.verticalFullExtent;
        });
        for (var outerIndex = 1;
             outerIndex < sourceColumnLinks.length;
             outerIndex++) {
          var outerLink = sourceColumnLinks[outerIndex];
          var outerC = outerLink.circularPathData;
          var outerSegMin = Math.min(
            outerC.sourceY,
            outerC.verticalRightInnerExtent
          );
          var outerSegMax = Math.max(
            outerC.sourceY,
            outerC.verticalRightInnerExtent
          );
          var requiredOuterRfe = outerC.rightFullExtent;
          for (var innerIndex = 0;
               innerIndex < outerIndex;
               innerIndex++) {
            var innerLink = sourceColumnLinks[innerIndex];
            var innerC = innerLink.circularPathData;
            var innerSegMin = Math.min(
              innerC.sourceY,
              innerC.verticalRightInnerExtent
            );
            var innerSegMax = Math.max(
              innerC.sourceY,
              innerC.verticalRightInnerExtent
            );
            if (
              Math.min(outerSegMax, innerSegMax) <=
              Math.max(outerSegMin, innerSegMin) + 1e-6
            ) continue;
            requiredOuterRfe = Math.max(
              requiredOuterRfe,
              innerC.rightFullExtent +
              ((innerLink.width || 0) + (outerLink.width || 0)) / 2 +
              gap
            );
          }
          setBottomRightFullExtent(outerLink, requiredOuterRfe);
        }
    });
  })();

  // Phase 3S (second pass): Re-apply self-loop clearance after the final visual-gap pass.
  // Preserve target grouping while moving shelves around unrelated self-loops.
  {
    var _gap3S2 = circularLinkGap || 0;
    if (_gap3S2 > 0) {
      var _topAll = graph.links.filter(function(l) {
        return l && l.circular && l.circularLinkType === "top" && !l.isVirtual &&
               l.circularPathData && typeof l.circularPathData.verticalFullExtent === "number";
      });
      var _topSelf2 = _topAll.filter(function(l) { return selfLinking(l, id); });
      var _topNon2 = _topAll.filter(function(l) { return !selfLinking(l, id); });
      _topSelf2.sort(function(a, b) {
        return b.circularPathData.verticalFullExtent -
          a.circularPathData.verticalFullExtent;
      });
      // Preserve the nesting established by source/target routing. Moving
      // outer shelves first prevents an inner shelf from jumping through an
      // outer member of the same bundle while clearing a self-loop.
      _topNon2.sort(function(a, b) {
        return a.circularPathData.verticalFullExtent -
          b.circularPathData.verticalFullExtent;
      });

      function _topShelfIntersectsSelfLoop(ns, sl) {
        var nsC = ns.circularPathData;
        var slC = sl.circularPathData;
        if (!nsC || !slC) return false;
        var nsX0 = Math.min(nsC.leftInnerExtent, nsC.rightInnerExtent);
        var nsX1 = Math.max(nsC.leftInnerExtent, nsC.rightInnerExtent);
        var slHW = (sl.width || 0) / 2;
        var slX0 = slC.leftFullExtent - slHW;
        var slX1 = slC.rightFullExtent + slHW;
        if (Math.min(nsX1, slX1) - Math.max(nsX0, slX0) <= 1e-6) return false;

        var nsHW = (ns.width || 0) / 2;
        var nsY0 = nsC.verticalFullExtent - nsHW;
        var nsY1 = nsC.verticalFullExtent + nsHW;
        var slY0 = Math.min(
          slC.verticalFullExtent,
          slC.verticalLeftInnerExtent,
          slC.verticalRightInnerExtent,
          slC.sourceY,
          slC.targetY
        ) - slHW;
        var slY1 = Math.max(
          slC.verticalFullExtent,
          slC.verticalLeftInnerExtent,
          slC.verticalRightInnerExtent,
          slC.sourceY,
          slC.targetY
        ) + slHW;
        return Math.min(nsY1, slY1) - Math.max(nsY0, slY0) > 1e-6;
      }

      function _moveTopLinkToVfe(link, nextVfe) {
        var c = link.circularPathData;
        var delta = c.verticalFullExtent - nextVfe;
        if (Math.abs(delta) <= 1e-6) return;
        c.verticalFullExtent = nextVfe;
        if (typeof c.verticalRightInnerExtent === "number") c.verticalRightInnerExtent -= delta;
        if (typeof c.verticalLeftInnerExtent === "number") c.verticalLeftInnerExtent -= delta;
        if (typeof c.verticalBuffer === "number") c.verticalBuffer += delta;
      }

      function _preserveMovedTargetBundle(moved) {
        if (!moved.target) return;
        var bundle = _topNon2.filter(function(link) {
          return link.target === moved.target && _shelvesOverlapX(link, moved);
        });
        if (bundle.length < 2) return;

        var minBundleVfe = Infinity;
        var maxBundleVfe = -Infinity;
        bundle.forEach(function(member) {
          var vfe = member.circularPathData.verticalFullExtent;
          if (vfe < minBundleVfe) minBundleVfe = vfe;
          if (vfe > maxBundleVfe) maxBundleVfe = vfe;
        });

        _topNon2.forEach(function(intruder) {
          if (intruder.target === moved.target || !_shelvesOverlapX(intruder, moved)) return;
          var intruderSourceId = intruder.source ? id(intruder.source) : null;
          var touchesSelfLoop = _topSelf2.some(function(selfLoop) {
            var selfLoopNodeId = id(selfLoop.source);
            return intruderSourceId === selfLoopNodeId;
          });
          if (touchesSelfLoop) return;
          var intruderC = intruder.circularPathData;
          var oldIntruderVfe = intruderC.verticalFullExtent;
          if (oldIntruderVfe <= minBundleVfe + 1e-6 ||
              oldIntruderVfe >= maxBundleVfe - 1e-6) return;

          var intruderHW = (intruder.width || 0) / 2;
          var maxIntruderVfe = Infinity;
          bundle.forEach(function(member) {
            var memberBound = member.circularPathData.verticalFullExtent -
              (member.width || 0) / 2 - _gap3S2 - intruderHW;
            if (memberBound < maxIntruderVfe) maxIntruderVfe = memberBound;
          });

          var barrierChanged = true;
          var barrierIters = 0;
          while (barrierChanged && barrierIters < _topNon2.length) {
            barrierChanged = false;
            barrierIters++;
            _topNon2.forEach(function(barrier) {
              if (barrier === intruder || bundle.indexOf(barrier) >= 0) return;
              var barrierC = barrier.circularPathData;
              if (!barrierC || barrierC.verticalFullExtent >= minBundleVfe - 1e-6) return;
              if (!_shelvesOverlapX(intruder, barrier)) return;
              var barrierHW = (barrier.width || 0) / 2;
              var barrierInfluence =
                barrierC.verticalFullExtent + barrierHW + _gap3S2 + intruderHW;
              if (barrierInfluence < maxIntruderVfe - 1e-6) return;
              var barrierBound =
                barrierC.verticalFullExtent - barrierHW - _gap3S2 - intruderHW;
              if (barrierBound < maxIntruderVfe - 1e-6) {
                maxIntruderVfe = barrierBound;
                barrierChanged = true;
              }
            });
          }
          _moveTopLinkToVfe(intruder, maxIntruderVfe);
        });
      }

      _topSelf2.forEach(function(sl) {
        var slC = sl.circularPathData;
        var slHW = (sl.width || 0) / 2;
        var slNodeId = id(sl.source);
        var slOuterEdge = slC.verticalFullExtent - slHW;
        _topNon2.forEach(function(ns) {
          var nsSrcId = ns.source ? id(ns.source) : null;
          var nsTgtId = ns.target ? id(ns.target) : null;
          var sharesSelfLoopNode = nsSrcId === slNodeId || nsTgtId === slNodeId;
          if (!sharesSelfLoopNode && !_topShelfIntersectsSelfLoop(ns, sl)) return;
          var nsC = ns.circularPathData;
          var nsHW = (ns.width || 0) / 2;
          var oldNsVfe = nsC.verticalFullExtent;
          var maxNsVfe = slOuterEdge - _gap3S2 - nsHW;

          // Prefer the available slot between an already-outer shelf and the
          // self-loop. If that interval is too narrow, shift the outer chain
          // together instead of making this shelf jump through it.
          var minNsVfe = -Infinity;
          _topNon2.forEach(function(barrier) {
            if (barrier === ns) return;
            var barrierC = barrier.circularPathData;
            if (!barrierC || barrierC.verticalFullExtent >= oldNsVfe - 1e-6) return;
            if (!_shelvesOverlapX(ns, barrier)) return;
            var barrierHW = (barrier.width || 0) / 2;
            var innerBound =
              barrierC.verticalFullExtent + barrierHW + _gap3S2 + nsHW;
            if (innerBound > minNsVfe) minNsVfe = innerBound;
          });

          if (minNsVfe > maxNsVfe + 1e-6) {
            var barrierShift = minNsVfe - maxNsVfe;
            _topNon2.forEach(function(barrier) {
              if (barrier === ns) return;
              var barrierC = barrier.circularPathData;
              if (!barrierC || barrierC.verticalFullExtent >= oldNsVfe - 1e-6) return;
              if (!_shelvesOverlapX(ns, barrier)) return;
              _moveTopLinkToVfe(
                barrier,
                barrierC.verticalFullExtent - barrierShift
              );
            });
          }

          if (nsC.verticalFullExtent > maxNsVfe + 1e-6) {
            _moveTopLinkToVfe(ns, maxNsVfe);
            _preserveMovedTargetBundle(ns);
          }
        });
      });

      // Pack every TOP backlink crossing a self-loop in target-column order.
      // Nearer/rightmost targets stay inner; farther/leftmost targets wrap
      // around them. Same-target links retain their source-side nesting.
      function _topTerminalCeiling(link) {
        var c = link.circularPathData;
        var ceiling = Infinity;
        if (typeof c.sourceY === "number" &&
            typeof c.rightLargeArcRadius === "number" &&
            typeof c.rightSmallArcRadius === "number") {
          ceiling = Math.min(
            ceiling,
            c.sourceY - c.rightLargeArcRadius - c.rightSmallArcRadius
          );
        }
        if (typeof c.targetY === "number" &&
            typeof c.leftLargeArcRadius === "number" &&
            typeof c.leftSmallArcRadius === "number") {
          ceiling = Math.min(
            ceiling,
            c.targetY - c.leftLargeArcRadius - c.leftSmallArcRadius
          );
        }
        return ceiling;
      }

      _topSelf2.forEach(function(sl) {
        var crossingLinks = _topNon2.filter(function(link) {
          return _shelvesOverlapX(link, sl);
        });
        if (!crossingLinks.length) return;

        crossingLinks.sort(function(a, b) {
          var aTargetColumn =
            a.target && typeof a.target.column === "number"
              ? a.target.column
              : -Infinity;
          var bTargetColumn =
            b.target && typeof b.target.column === "number"
              ? b.target.column
              : -Infinity;
          if (aTargetColumn !== bTargetColumn) {
            return aTargetColumn - bTargetColumn;
          }

          if (a.target !== b.target) {
            var aTargetY =
              a.target && typeof a.target.y0 === "number" ? a.target.y0 : 0;
            var bTargetY =
              b.target && typeof b.target.y0 === "number" ? b.target.y0 : 0;
            if (Math.abs(aTargetY - bTargetY) > 1e-6) {
              return bTargetY - aTargetY;
            }
          }

          return b.circularPathData.rightFullExtent -
            a.circularPathData.rightFullExtent;
        });

        var nextInnerEdge =
          sl.circularPathData.verticalFullExtent -
          (sl.width || 0) / 2 -
          _gap3S2;
        for (var ci = crossingLinks.length - 1; ci >= 0; ci--) {
          var crossingLink = crossingLinks[ci];
          var crossingHW = (crossingLink.width || 0) / 2;
          var crossingVfe = Math.min(
            nextInnerEdge - crossingHW,
            _topTerminalCeiling(crossingLink)
          );
          _moveTopLinkToVfe(crossingLink, crossingVfe);
          nextInnerEdge = crossingVfe - crossingHW - _gap3S2;
        }

        crossingLinks.forEach(function(link) {
          if (link.source !== sl.source) return;
          var c = link.circularPathData;
          if (!c ||
              typeof c.rightSmallArcRadius !== "number" ||
              typeof c.rightLargeArcRadius !== "number" ||
              typeof c.sourceY !== "number" ||
              typeof c.verticalRightInnerExtent !== "number") return;
          var availableRightTurn =
            c.sourceY - c.verticalRightInnerExtent;
          if (availableRightTurn >= c.rightLargeArcRadius - 1e-6) {
            c.rightSmallArcRadius = c.rightLargeArcRadius;
          }
        });
      });
    }
  }

  // Final pass: keep circular horizontal shelves clear of intermediate nodes.
  // Earlier phases may move a shelf after the initial node-clearance floor/ceiling
  // was computed. Re-apply the invariant immediately before path generation.
  (function enforceFinalNodeClearance() {
    var gap = circularLinkGap || 0;

    function syncVertical(link) {
      var c = link.circularPathData;
      if (!c) return;
      if (link.circularLinkType === "bottom") {
        if (typeof c.rightLargeArcRadius === "number") {
          c.verticalRightInnerExtent = c.verticalFullExtent - c.rightLargeArcRadius;
        }
        if (typeof c.leftLargeArcRadius === "number") {
          c.verticalLeftInnerExtent = c.verticalFullExtent - c.leftLargeArcRadius;
        }
      } else {
        if (typeof c.rightLargeArcRadius === "number") {
          c.verticalRightInnerExtent = c.verticalFullExtent + c.rightLargeArcRadius;
        }
        if (typeof c.leftLargeArcRadius === "number") {
          c.verticalLeftInnerExtent = c.verticalFullExtent + c.leftLargeArcRadius;
        }
      }
    }

    function setFinalVfe(link, nextVfe) {
      var c = link.circularPathData;
      if (!c || !isFinite(nextVfe)) return;
      var delta = nextVfe - c.verticalFullExtent;
      if (Math.abs(delta) <= 1e-9) return;
      c.verticalFullExtent = nextVfe;
      if (typeof c.verticalBuffer === "number") {
        c.verticalBuffer += link.circularLinkType === "bottom" ? delta : -delta;
      }
      syncVertical(link);
    }

    function horizontalRange(c) {
      var xs = [];
      ["leftFullExtent", "leftInnerExtent", "rightInnerExtent", "rightFullExtent", "targetX", "sourceX"].forEach(function(k) {
        if (typeof c[k] === "number") xs.push(c[k]);
      });
      if (!xs.length) return null;
      var lo = xs[0];
      var hi = xs[0];
      for (var i = 1; i < xs.length; i++) {
        if (xs[i] < lo) lo = xs[i];
        if (xs[i] > hi) hi = xs[i];
      }
      return { x0: lo, x1: hi };
    }

    graph.links.forEach(function(link) {
      if (!link || !link.circular || link.isVirtual || selfLinking(link, id)) return;
      var c = link.circularPathData;
      if (!c || typeof c.verticalFullExtent !== "number") return;
      var xr = horizontalRange(c);
      if (!xr) return;

      var srcId = link.source ? id(link.source) : null;
      var tgtId = link.target ? id(link.target) : null;
      var halfW = (link.width || 0) / 2;
      var targetVfe = c.verticalFullExtent;

      for (var ni = 0; ni < graph.nodes.length; ni++) {
        var nd = graph.nodes[ni];
        if (!nd || nd.virtual) continue;
        if (id(nd) === srcId || id(nd) === tgtId) continue;
        if (typeof nd.x0 !== "number" || typeof nd.x1 !== "number") continue;
        if (nd.x1 <= xr.x0 || nd.x0 >= xr.x1) continue;

        if (link.circularLinkType === "bottom") {
          if (typeof nd.y1 !== "number") continue;
          var floor = nd.y1 + gap + halfW;
          if (targetVfe < floor) targetVfe = floor;
        } else if (link.circularLinkType === "top") {
          if (typeof nd.y0 !== "number") continue;
          var ceiling = nd.y0 - gap - halfW;
          if (targetVfe > ceiling) targetVfe = ceiling;
        }
      }

      setFinalVfe(link, targetVfe);
    });

    // Self-loop packing runs after the earlier target-bundle compaction and
    // can split two equal-size TOP bundles. Resolve only those late splits:
    // the higher target column stays inner and the lower target column moves
    // outward as one contiguous shelf group.
    var topByTarget = new Map();
    graph.links.forEach(function(link) {
      if (!link || !link.circular || link.isVirtual ||
          link.circularLinkType !== "top" ||
          selfLinking(link, id) ||
          !link.target || !link.circularPathData) return;
      var targetGroup = topByTarget.get(link.target);
      if (!targetGroup) {
        targetGroup = [];
        topByTarget.set(link.target, targetGroup);
      }
      targetGroup.push(link);
    });

    var orderedTop = [];
    topByTarget.forEach(function(targetGroup) {
      orderedTop = orderedTop.concat(targetGroup);
    });
    orderedTop.sort(function(a, b) {
      return b.circularPathData.verticalFullExtent -
        a.circularPathData.verticalFullExtent;
    });

    var resolvedPairs = new Set();
    topByTarget.forEach(function(targetGroup, target) {
      if (targetGroup.length < 3) return;
      var positions = [];
      orderedTop.forEach(function(link, index) {
        if (link.target === target) positions.push(index);
      });
      if (positions.length < 2) return;
      var minIndex = positions[0];
      var maxIndex = positions[positions.length - 1];
      if (maxIndex - minIndex === positions.length - 1) return;

      for (var index = minIndex + 1; index < maxIndex; index++) {
        var intruder = orderedTop[index];
        if (intruder.target === target) continue;
        var competingGroup = topByTarget.get(intruder.target) || [];
        if (competingGroup.length !== targetGroup.length) continue;

        var targetCol =
          typeof target.column === "number" ? target.column : -Infinity;
        var competingCol =
          intruder.target &&
          typeof intruder.target.column === "number"
            ? intruder.target.column
            : -Infinity;
        var innerGroup =
          targetCol >= competingCol ? targetGroup : competingGroup;
        var outerGroup =
          targetCol >= competingCol ? competingGroup : targetGroup;
        var innerTarget =
          targetCol >= competingCol ? target : intruder.target;
        var outerTarget =
          targetCol >= competingCol ? intruder.target : target;
        var pairKey =
          String(id(innerTarget)) + "|" + String(id(outerTarget));
        if (resolvedPairs.has(pairKey)) break;
        resolvedPairs.add(pairKey);

        var innerOuterEdge = Infinity;
        innerGroup.forEach(function(link) {
          var hw = Math.max(link.width || 0, 1) / 2;
          var outerEdge =
            link.circularPathData.verticalFullExtent - hw;
          if (outerEdge < innerOuterEdge) innerOuterEdge = outerEdge;
        });

        outerGroup.sort(function(a, b) {
          return b.circularPathData.verticalFullExtent -
            a.circularPathData.verticalFullExtent;
        });
        var nextInnerEdge = innerOuterEdge - gap;
        outerGroup.forEach(function(link) {
          var hw = Math.max(link.width || 0, 1) / 2;
          var nextVfe = nextInnerEdge - hw;
          setFinalVfe(link, nextVfe);
          nextInnerEdge = nextVfe - hw - gap;
        });
        break;
      }
    });

    // Target-bundle moves above happen after the earlier pairwise shelf-gap
    // pass. Re-apply the gap invariant against every overlapping inner shelf,
    // preserving the final group order while cascading outer shelves upward.
    var finalTopShelves = graph.links.filter(function(link) {
      return link && link.circular && !link.isVirtual &&
        link.circularLinkType === "top" &&
        link.circularPathData &&
        typeof link.circularPathData.verticalFullExtent === "number";
    }).sort(function(a, b) {
      return b.circularPathData.verticalFullExtent -
        a.circularPathData.verticalFullExtent;
    });

    var targetPositions = new Map();
    finalTopShelves.forEach(function(link, index) {
      if (selfLinking(link, id) || !link.target) return;
      var positions = targetPositions.get(link.target);
      if (!positions) {
        positions = [];
        targetPositions.set(link.target, positions);
      }
      positions.push(index);
    });

    var splitIntervals = [];
    targetPositions.forEach(function(positions) {
      if (positions.length < 3) return;
      var start = positions[0];
      var end = positions[positions.length - 1];
      if (end - start === positions.length - 1) return;
      splitIntervals.push({ start: start, end: end });
    });
    splitIntervals.sort(function(a, b) {
      return a.start - b.start;
    });

    var mergedIntervals = [];
    splitIntervals.forEach(function(interval) {
      var last = mergedIntervals[mergedIntervals.length - 1];
      if (!last || interval.start > last.end) {
        mergedIntervals.push({
          start: interval.start,
          end: interval.end
        });
      } else if (interval.end > last.end) {
        last.end = interval.end;
      }
    });

    var intervalByStart = {};
    mergedIntervals.forEach(function(interval) {
      intervalByStart[interval.start] = interval;
    });

    var orderedSweepShelves = [];
    var forcedPreviousShelf = new Map();
    for (var shelfIndex = 0; shelfIndex < finalTopShelves.length;) {
      var component = intervalByStart[shelfIndex];
      if (!component) {
        orderedSweepShelves.push(finalTopShelves[shelfIndex]);
        shelfIndex++;
        continue;
      }

      var units = [];
      var unitsByTarget = new Map();
      for (
        var componentIndex = component.start;
        componentIndex <= component.end;
        componentIndex++
      ) {
        var componentLink = finalTopShelves[componentIndex];
        if (selfLinking(componentLink, id) || !componentLink.target) {
          units.push({
            links: [componentLink],
            target: null,
            firstIndex: componentIndex
          });
          continue;
        }
        var unit = unitsByTarget.get(componentLink.target);
        if (!unit) {
          unit = {
            links: [],
            target: componentLink.target,
            firstIndex: componentIndex
          };
          unitsByTarget.set(componentLink.target, unit);
          units.push(unit);
        }
        unit.links.push(componentLink);
      }

      units.sort(function(a, b) {
        if (!a.target || !b.target) {
          return a.firstIndex - b.firstIndex;
        }
        var aCol =
          typeof a.target.column === "number"
            ? a.target.column
            : -Infinity;
        var bCol =
          typeof b.target.column === "number"
            ? b.target.column
            : -Infinity;
        if (aCol !== bCol) return bCol - aCol;
        var aY =
          typeof a.target.y0 === "number" ? a.target.y0 : 0;
        var bY =
          typeof b.target.y0 === "number" ? b.target.y0 : 0;
        if (Math.abs(aY - bY) > 1e-6) return aY - bY;
        return a.firstIndex - b.firstIndex;
      });

      var previousComponentLink = null;
      units.forEach(function(unit) {
        unit.links.sort(function(a, b) {
          return b.circularPathData.verticalFullExtent -
            a.circularPathData.verticalFullExtent;
        }).forEach(function(link) {
          if (previousComponentLink) {
            forcedPreviousShelf.set(link, previousComponentLink);
          }
          orderedSweepShelves.push(link);
          previousComponentLink = link;
        });
      });
      shelfIndex = component.end + 1;
    }
    finalTopShelves = orderedSweepShelves;

    var minInnerTopEdgeByColumn = {};
    for (var topIndex = 0; topIndex < finalTopShelves.length; topIndex++) {
      var outerShelf = finalTopShelves[topIndex];
      var outerC = outerShelf.circularPathData;
      var sourceCol =
        outerShelf.source &&
        typeof outerShelf.source.column === "number"
          ? outerShelf.source.column
          : 0;
      var targetCol =
        outerShelf.target &&
        typeof outerShelf.target.column === "number"
          ? outerShelf.target.column
          : sourceCol;
      var minCol = Math.min(sourceCol, targetCol);
      var maxCol = Math.max(sourceCol, targetCol);
      var outerHW = Math.max(outerShelf.width || 0, 1) / 2;
      var maxOuterVfe = outerC.verticalFullExtent;
      var minInnerTopEdge = Infinity;
      var forcedPrevious = forcedPreviousShelf.get(outerShelf);
      if (forcedPrevious) {
        var forcedHW = Math.max(forcedPrevious.width || 0, 1) / 2;
        var forcedAllowedVfe =
          forcedPrevious.circularPathData.verticalFullExtent -
          forcedHW - gap - outerHW;
        if (forcedAllowedVfe < maxOuterVfe) {
          maxOuterVfe = forcedAllowedVfe;
        }
      }

      for (var col = minCol; col <= maxCol; col++) {
        var innerTopEdge = minInnerTopEdgeByColumn[col];
        if (
          typeof innerTopEdge === "number" &&
          innerTopEdge < minInnerTopEdge
        ) {
          minInnerTopEdge = innerTopEdge;
        }
      }
      if (minInnerTopEdge < Infinity) {
        var allowedVfe = minInnerTopEdge - gap - outerHW;
        if (allowedVfe < maxOuterVfe) maxOuterVfe = allowedVfe;
      }

      if (maxOuterVfe < outerC.verticalFullExtent - 1e-6) {
        setFinalVfe(outerShelf, maxOuterVfe);
      }

      var finalTopEdge =
        outerShelf.circularPathData.verticalFullExtent - outerHW;
      for (var updateCol = minCol; updateCol <= maxCol; updateCol++) {
        if (
          typeof minInnerTopEdgeByColumn[updateCol] !== "number" ||
          finalTopEdge < minInnerTopEdgeByColumn[updateCol]
        ) {
          minInnerTopEdgeByColumn[updateCol] = finalTopEdge;
        }
      }
    }
  })();

  // Final pass: enforce visual gap for left vertical legs of sub-pixel circular links.
  // This must run after all VFE adjustments: earlier vertical moves can create new
  // left-leg overlaps or leave same-target bundles wider than necessary.
  (function enforceLeftLegVisualGap() {
    var gap = circularLinkGap || 0;
    if (gap <= 0) return;
    var circLinks = graph.links.filter(function(l) {
      return l && l.circular && !l.isVirtual && l.circularPathData &&
             typeof l.circularPathData.leftFullExtent === "number";
    });
    if (circLinks.length < 2) return;

    var byCol = {};
    circLinks.forEach(function(l) {
      var col = l.target && typeof l.target.column === "number" ? l.target.column : -1;
      if (!byCol[col]) byCol[col] = [];
      byCol[col].push(l);
    });

    function syncLeft(link) {
      var c = link.circularPathData;
      c.leftFullExtent = c.targetX - c.leftLargeArcRadius - (c.leftNodeBuffer || 0);
      if (link.circularLinkType === "bottom") {
        c.verticalLeftInnerExtent = c.verticalFullExtent - c.leftLargeArcRadius;
      } else {
        c.verticalLeftInnerExtent = c.verticalFullExtent + c.leftLargeArcRadius;
      }
    }

    function setLeftFullExtent(link, nextLfe) {
      var c = link.circularPathData;
      var nextRadius = c.targetX - (c.leftNodeBuffer || 0) - nextLfe;
      var minRadius = baseRadius + (link.width || 0) / 2;
      if (nextRadius < minRadius) nextRadius = minRadius;
      var delta = nextRadius - c.leftLargeArcRadius;
      c.leftLargeArcRadius = nextRadius;
      if (typeof c.leftSmallArcRadius === "number") {
        c.leftSmallArcRadius += delta;
        if (c.leftSmallArcRadius < 0) c.leftSmallArcRadius = 0;
        if (c.leftSmallArcRadius > c.leftLargeArcRadius) {
          c.leftSmallArcRadius = c.leftLargeArcRadius;
        }
      }
      if (
        link.circularLinkType === "bottom" &&
        typeof c.targetY === "number" &&
        typeof c.verticalFullExtent === "number" &&
        typeof c.leftSmallArcRadius === "number"
      ) {
        var targetTurnFloor =
          c.targetY +
          c.leftSmallArcRadius +
          c.leftLargeArcRadius +
          gap;
        if (c.verticalFullExtent < targetTurnFloor - 1e-6) {
          var floorDelta = targetTurnFloor - c.verticalFullExtent;
          c.verticalFullExtent = targetTurnFloor;
          if (typeof c.verticalBuffer === "number") {
            c.verticalBuffer += floorDelta;
          }
          c.verticalRightInnerExtent =
            c.verticalFullExtent - c.rightLargeArcRadius;
        }
      }
      syncLeft(link);
    }

    function preserveTopTargetArcCeiling(link) {
      if (!link || link.circularLinkType !== "top") return;
      var c = link.circularPathData;
      if (!c ||
          typeof c.targetY !== "number" ||
          typeof c.verticalFullExtent !== "number" ||
          typeof c.leftLargeArcRadius !== "number") return;

      var availableSmall =
        c.targetY - c.verticalFullExtent - c.leftLargeArcRadius;
      if (availableSmall < 0) {
        var lift = -availableSmall;
        c.verticalFullExtent -= lift;
        if (typeof c.verticalBuffer === "number") {
          c.verticalBuffer += lift;
        }
        c.verticalRightInnerExtent =
          c.verticalFullExtent + c.rightLargeArcRadius;
        availableSmall = 0;
      }
      if (
        typeof c.leftSmallArcRadius === "number" &&
        c.leftSmallArcRadius > availableSmall
      ) {
        c.leftSmallArcRadius = Math.max(0, availableSmall);
      }
      syncLeft(link);
    }

    function roundLeftTurnAroundTargetSelfLoop(link, group) {
      if (!link || selfLinking(link, id) || !link.target) return;
      var c = link.circularPathData;
      if (!c || typeof c.leftSmallArcRadius !== "number" ||
          typeof c.leftLargeArcRadius !== "number" ||
          typeof c.targetY !== "number" ||
          typeof c.verticalLeftInnerExtent !== "number") return;

      var targetLoop = group.find(function(candidate) {
        return candidate !== link &&
               selfLinking(candidate, id) &&
               candidate.target === link.target &&
               candidate.circularLinkType === link.circularLinkType &&
               candidate.circularPathData &&
               candidate.circularPathData.leftFullExtent > c.leftFullExtent;
      });
      if (!targetLoop) return;

      var availableLeftTurn =
        link.circularLinkType === "bottom"
          ? c.verticalLeftInnerExtent - c.targetY
          : c.targetY - c.verticalLeftInnerExtent;
      if (availableLeftTurn >= c.leftLargeArcRadius - 1e-6) {
        c.leftSmallArcRadius = c.leftLargeArcRadius;
      }
    }

    var byBottomTarget = new Map();
    circLinks.forEach(function(l) {
      if (l.circularLinkType !== "bottom") return;
      if (!l.target) return;
      var arr = byBottomTarget.get(l.target);
      if (!arr) { arr = []; byBottomTarget.set(l.target, arr); }
      arr.push(l);
    });

    byBottomTarget.forEach(function(group) {
      var nonSelf = group.filter(function(l) { return !selfLinking(l, id); });
      if (nonSelf.length < 2) return;

      var selfLoops = group.filter(function(l) { return selfLinking(l, id); });
      var innerBoundary = -Infinity;
      var anchor = null;
      selfLoops.forEach(function(loop) {
        var c = loop.circularPathData;
        var leftEdge = c.leftFullExtent - Math.max(loop.width || 0, 1) / 2;
        if (leftEdge > innerBoundary) innerBoundary = leftEdge;
      });
      if (innerBoundary === -Infinity) {
        nonSelf.forEach(function(link) {
          var c = link.circularPathData;
          var rightEdge = c.leftFullExtent + Math.max(link.width || 0, 1) / 2;
          if (rightEdge > innerBoundary) {
            innerBoundary = rightEdge;
            anchor = link;
          }
        });
      }

      if (anchor) {
        innerBoundary =
          anchor.circularPathData.leftFullExtent -
          Math.max(anchor.width || 0, 1) / 2;
        nonSelf = nonSelf.filter(function(link) {
          return link !== anchor;
        });
      }

      nonSelf.sort(function(a, b) {
        var av = a.circularPathData && typeof a.circularPathData.verticalFullExtent === "number" ? a.circularPathData.verticalFullExtent : 0;
        var bv = b.circularPathData && typeof b.circularPathData.verticalFullExtent === "number" ? b.circularPathData.verticalFullExtent : 0;
        if (Math.abs(av - bv) > 1e-6) return av - bv;
        var ay = a.circularPathData && typeof a.circularPathData.targetY === "number" ? a.circularPathData.targetY : 0;
        var by = b.circularPathData && typeof b.circularPathData.targetY === "number" ? b.circularPathData.targetY : 0;
        if (Math.abs(ay - by) > 1e-6) return by - ay;
        return b.circularPathData.leftFullExtent - a.circularPathData.leftFullExtent;
      });

      var nextRightEdge = innerBoundary;
      for (var pi = 0; pi < nonSelf.length; pi++) {
        var link = nonSelf[pi];
        var hw = Math.max(link.width || 0, 1) / 2;
        var nextLfe = nextRightEdge - gap - hw;
        setLeftFullExtent(link, nextLfe);
        nextRightEdge = link.circularPathData.leftFullExtent - hw;
      }
    });

    var byBottomColumn = new Map();
    circLinks.forEach(function(l) {
      if (l.circularLinkType !== "bottom") return;
      if (!l.target) return;
      if (selfLinking(l, id)) return;
      var col = typeof l.target.column === "number" ? l.target.column : -1;
      var arr = byBottomColumn.get(col);
      if (!arr) { arr = []; byBottomColumn.set(col, arr); }
      arr.push(l);
    });

    byBottomColumn.forEach(function(group) {
      if (!group || group.length < 2) return;
      var slots = group.slice().sort(function(a, b) {
        return b.circularPathData.leftFullExtent - a.circularPathData.leftFullExtent;
      }).map(function(link) {
        var c = link.circularPathData;
        return {
          leftLargeArcRadius: c.leftLargeArcRadius,
          leftSmallArcRadius: c.leftSmallArcRadius
        };
      });

      group.sort(function(a, b) {
        var at = a.target && typeof a.target.y0 === "number" ? a.target.y0 : 0;
        var bt = b.target && typeof b.target.y0 === "number" ? b.target.y0 : 0;
        if (Math.abs(at - bt) > 1e-6) return bt - at;
        var av = a.circularPathData && typeof a.circularPathData.verticalFullExtent === "number" ? a.circularPathData.verticalFullExtent : 0;
        var bv = b.circularPathData && typeof b.circularPathData.verticalFullExtent === "number" ? b.circularPathData.verticalFullExtent : 0;
        if (Math.abs(av - bv) > 1e-6) return av - bv;
        var ay = a.circularPathData && typeof a.circularPathData.targetY === "number" ? a.circularPathData.targetY : 0;
        var by = b.circularPathData && typeof b.circularPathData.targetY === "number" ? b.circularPathData.targetY : 0;
        if (Math.abs(ay - by) > 1e-6) return by - ay;
        return b.circularPathData.leftFullExtent - a.circularPathData.leftFullExtent;
      });

      for (var si = 0; si < group.length; si++) {
        var slotLink = group[si];
        var slotC = slotLink.circularPathData;
        var slot = slots[si];
        slotC.leftLargeArcRadius = slot.leftLargeArcRadius;
        slotC.leftSmallArcRadius = slot.leftSmallArcRadius;
        syncLeft(slotLink);
      }

      var nextRightEdge = -Infinity;
      group.forEach(function(link) {
        var hw = Math.max(link.width || 0, 1) / 2;
        var rightEdge = link.circularPathData.leftFullExtent + hw;
        if (rightEdge > nextRightEdge) nextRightEdge = rightEdge;
      });

      for (var packIndex = 0; packIndex < group.length; packIndex++) {
        var packedLink = group[packIndex];
        var packedHW = Math.max(packedLink.width || 0, 1) / 2;
        var packedLfe = nextRightEdge - packedHW;
        setLeftFullExtent(packedLink, packedLfe);
        nextRightEdge =
          packedLink.circularPathData.leftFullExtent - packedHW - gap;
      }
    });

    Object.keys(byCol).forEach(function(col) {
      var group = byCol[col];
      if (group.length < 2) return;

      var maxIter = 20;
      for (var iter = 0; iter < maxIter; iter++) {
        group.sort(function(a, b) {
          var ar = a.circularPathData.leftFullExtent + Math.max(a.width || 0, 1) / 2;
          var br = b.circularPathData.leftFullExtent + Math.max(b.width || 0, 1) / 2;
          if (Math.abs(ar - br) > 1e-6) return ar - br;
          return a.circularPathData.leftFullExtent - b.circularPathData.leftFullExtent;
        });

        var changed = false;
        var anchorChanged = false;

        // Self-loops are fixed inner anchors. Check every overlapping leg,
        // not only the adjacent item in the current X ordering: a thin leg
        // can sit inside a wide self-loop while another slot masks the pair.
        for (var sli = 0; sli < group.length; sli++) {
          var loop = group[sli];
          if (!selfLinking(loop, id)) continue;
          var loopC = loop.circularPathData;
          var loopTargetY = typeof loopC.targetY === "number"
            ? loopC.targetY
            : (typeof loop.y1 === "number" ? loop.y1 : 0);
          var loopVLI = typeof loopC.verticalLeftInnerExtent === "number"
            ? loopC.verticalLeftInnerExtent
            : loopC.verticalFullExtent;
          var loopYMin = Math.min(loopTargetY, loopVLI);
          var loopYMax = Math.max(loopTargetY, loopVLI);
          var loopHW = Math.max(loop.width || 0, 1) / 2;
          var loopLeftEdge = loopC.leftFullExtent - loopHW;

          for (var nsi = 0; nsi < group.length; nsi++) {
            var nonSelf = group[nsi];
            if (nonSelf === loop || selfLinking(nonSelf, id)) continue;
            var nonSelfC = nonSelf.circularPathData;
            var nonSelfTargetY = typeof nonSelfC.targetY === "number"
              ? nonSelfC.targetY
              : (typeof nonSelf.y1 === "number" ? nonSelf.y1 : 0);
            var nonSelfVLI = typeof nonSelfC.verticalLeftInnerExtent === "number"
              ? nonSelfC.verticalLeftInnerExtent
              : nonSelfC.verticalFullExtent;
            var nonSelfYMin = Math.min(nonSelfTargetY, nonSelfVLI);
            var nonSelfYMax = Math.max(nonSelfTargetY, nonSelfVLI);
            if (Math.min(loopYMax, nonSelfYMax) <=
                Math.max(loopYMin, nonSelfYMin) + 1e-6) continue;

            var nonSelfHW = Math.max(nonSelf.width || 0, 1) / 2;
            var maxLfe = loopLeftEdge - gap - nonSelfHW;
            if (nonSelfC.leftFullExtent > maxLfe + 1e-6) {
              setLeftFullExtent(nonSelf, maxLfe);
              changed = true;
              anchorChanged = true;
            }
          }
        }

        if (anchorChanged) continue;

        for (var i = 1; i < group.length; i++) {
          var inner = group[i];
          var ic = inner.circularPathData;
          var iTargetY = typeof ic.targetY === "number" ? ic.targetY : (typeof inner.y1 === "number" ? inner.y1 : (inner.target && typeof inner.target.y0 === "number" ? inner.target.y0 : 0));
          var iVLI = typeof ic.verticalLeftInnerExtent === "number" ? ic.verticalLeftInnerExtent : ic.verticalFullExtent;
          var iYMin = Math.min(iTargetY, iVLI);
          var iYMax = Math.max(iTargetY, iVLI);

          var outer = null;
          var oc = null;
          var handledSelfLoopAnchor = false;
          for (var oi = i - 1; oi >= 0; oi--) {
            var candidate = group[oi];
            var cc = candidate.circularPathData;
            var cTargetY = typeof cc.targetY === "number" ? cc.targetY : (typeof candidate.y1 === "number" ? candidate.y1 : (candidate.target && typeof candidate.target.y0 === "number" ? candidate.target.y0 : 0));
            var cVLI = typeof cc.verticalLeftInnerExtent === "number" ? cc.verticalLeftInnerExtent : cc.verticalFullExtent;
            var cYMin = Math.min(cTargetY, cVLI);
            var cYMax = Math.max(cTargetY, cVLI);
            var yOverlap = Math.max(0, Math.min(cYMax, iYMax) - Math.max(cYMin, iYMin));
            if (yOverlap <= 1e-6) continue;
            if (selfLinking(candidate, id) && !selfLinking(inner, id)) {
              var loopVisHW = Math.max(candidate.width || 0, 1) / 2;
              var innerVisHWForLoop = Math.max(inner.width || 0, 1) / 2;
              var loopLeftVisEdge = cc.leftFullExtent - loopVisHW;
              var innerRightVisEdge = ic.leftFullExtent + innerVisHWForLoop;
              var loopGap = loopLeftVisEdge - innerRightVisEdge;
              if (loopGap < gap - 1e-6) {
                setLeftFullExtent(inner, loopLeftVisEdge - gap - innerVisHWForLoop);
                changed = true;
                handledSelfLoopAnchor = true;
              }
              continue;
            }
            outer = candidate;
            oc = cc;
            break;
          }
          if (handledSelfLoopAnchor) continue;
          if (!outer) continue;

          var outerVisHW = Math.max(outer.width || 0, 1) / 2;
          var innerVisHW = Math.max(inner.width || 0, 1) / 2;
          var outerRightVisEdge = oc.leftFullExtent + outerVisHW;
          var innerLeftVisEdge = ic.leftFullExtent - innerVisHW;
          var visualGap = innerLeftVisEdge - outerRightVisEdge;

          if (visualGap < gap - 1e-6) {
            var deficit = gap - visualGap;
            oc.leftLargeArcRadius += deficit;
            if (typeof oc.leftSmallArcRadius === "number") {
              oc.leftSmallArcRadius += deficit;
              if (oc.leftSmallArcRadius > oc.leftLargeArcRadius) {
                oc.leftSmallArcRadius = oc.leftLargeArcRadius;
              }
            }
            syncLeft(outer);
            changed = true;
          } else if (
            visualGap > gap + 1e-6 &&
            !selfLinking(outer, id) &&
            outer.circularLinkType === inner.circularLinkType &&
            outer.target === inner.target
          ) {
            var idealOuterLfe = ic.leftFullExtent - innerVisHW - gap - outerVisHW;
            if (compactFinalBacklinks && compactSourceTurns) {
              // The short inner leg can skip intervening target bundles in Y.
              // Pulling its long enclosing return past those bundles reverses
              // their lanes and makes the later gap resolver push them outside.
              var outerYMin=Math.min(oc.targetY,oc.verticalLeftInnerExtent);
              var outerYMax=Math.max(oc.targetY,oc.verticalLeftInnerExtent);
              group.forEach(function(blocker) {
                if (blocker===outer || blocker===inner) return;
                var bc=blocker.circularPathData;
                if (bc.leftFullExtent<=oc.leftFullExtent+1e-6) return;
                var blockerYMin=Math.min(bc.targetY,bc.verticalLeftInnerExtent);
                var blockerYMax=Math.max(bc.targetY,bc.verticalLeftInnerExtent);
                if (Math.min(outerYMax,blockerYMax)<=Math.max(outerYMin,blockerYMin)+1e-6) return;
                idealOuterLfe=Math.min(idealOuterLfe,bc.leftFullExtent-
                  Math.max(blocker.width || 0,1)/2-gap-outerVisHW);
              });
            }
            if (idealOuterLfe > oc.leftFullExtent + 1e-6) {
              var pull = idealOuterLfe - oc.leftFullExtent;
              var minRadius = baseRadius + (outer.width || 0) / 2;
              oc.leftLargeArcRadius -= pull;
              if (oc.leftLargeArcRadius < minRadius) {
                oc.leftLargeArcRadius = minRadius;
              }
              if (typeof oc.leftSmallArcRadius === "number") {
                oc.leftSmallArcRadius -= pull;
                if (oc.leftSmallArcRadius < 0) oc.leftSmallArcRadius = 0;
                if (oc.leftSmallArcRadius > oc.leftLargeArcRadius) {
                  oc.leftSmallArcRadius = oc.leftLargeArcRadius;
                }
              }
              syncLeft(outer);
              changed = true;
            }
          }
        }
        if (!changed) break;
      }

      // The generic all-pairs resolver above may move one member of a
      // same-target BOTTOM bundle around an unrelated blocker. Restore the
      // nesting invariant inside each bundle without changing its occupied
      // horizontal band: inner shelf first, outer shelf last.
      var bottomByTarget = new Map();
      group.forEach(function(link) {
        if (link.circularLinkType !== "bottom" ||
            selfLinking(link, id) ||
            !link.target) return;
        var targetGroup = bottomByTarget.get(link.target);
        if (!targetGroup) {
          targetGroup = [];
          bottomByTarget.set(link.target, targetGroup);
        }
        targetGroup.push(link);
      });

      bottomByTarget.forEach(function(targetGroup) {
        if (targetGroup.length < 2) return;
        targetGroup.sort(function(a, b) {
          return a.circularPathData.verticalFullExtent -
            b.circularPathData.verticalFullExtent;
        });

        var nextRightEdge = -Infinity;
        targetGroup.forEach(function(link) {
          var hw = Math.max(link.width || 0, 1) / 2;
          var rightEdge = link.circularPathData.leftFullExtent + hw;
          if (rightEdge > nextRightEdge) nextRightEdge = rightEdge;
        });

        targetGroup.forEach(function(link) {
          var hw = Math.max(link.width || 0, 1) / 2;
          var proposedRightEdge = nextRightEdge;
          var bottomC = link.circularPathData;
          var bottomYMin = Math.min(
            bottomC.targetY,
            bottomC.verticalLeftInnerExtent
          );
          var bottomYMax = Math.max(
            bottomC.targetY,
            bottomC.verticalLeftInnerExtent
          );
          var otherBottomBlockers = group.filter(function(candidate) {
            if (candidate === link ||
                candidate.circularLinkType !== "bottom" ||
                candidate.target === link.target) return false;
            var blockerC = candidate.circularPathData;
            var blockerYMin = Math.min(
              blockerC.targetY,
              blockerC.verticalLeftInnerExtent
            );
            var blockerYMax = Math.max(
              blockerC.targetY,
              blockerC.verticalLeftInnerExtent
            );
            return Math.min(bottomYMax, blockerYMax) >
              Math.max(bottomYMin, blockerYMin) + 1e-6;
          }).sort(function(a, b) {
            var aHW = Math.max(a.width || 0, 1) / 2;
            var bHW = Math.max(b.width || 0, 1) / 2;
            return (b.circularPathData.leftFullExtent + bHW) -
              (a.circularPathData.leftFullExtent + aHW);
          });

          otherBottomBlockers.forEach(function(blocker) {
            var blockerC = blocker.circularPathData;
            var blockerHW = Math.max(blocker.width || 0, 1) / 2;
            var blockerLeftEdge = blockerC.leftFullExtent - blockerHW;
            var blockerRightEdge = blockerC.leftFullExtent + blockerHW;
            var proposedLeftEdge = proposedRightEdge - 2 * hw;
            if (
              proposedRightEdge > blockerLeftEdge - gap + 1e-6 &&
              proposedLeftEdge < blockerRightEdge + gap - 1e-6
            ) {
              proposedRightEdge = blockerLeftEdge - gap;
            }
          });

          var topBlockers = group.filter(function(candidate) {
            if (candidate.circularLinkType !== "top") return false;
            var blockerC = candidate.circularPathData;
            var blockerYMin = Math.min(
              blockerC.targetY,
              blockerC.verticalLeftInnerExtent
            );
            var blockerYMax = Math.max(
              blockerC.targetY,
              blockerC.verticalLeftInnerExtent
            );
            return Math.min(bottomYMax, blockerYMax) >
              Math.max(bottomYMin, blockerYMin) + 1e-6;
          }).sort(function(a, b) {
            var aHW = Math.max(a.width || 0, 1) / 2;
            var bHW = Math.max(b.width || 0, 1) / 2;
            return (b.circularPathData.leftFullExtent + bHW) -
              (a.circularPathData.leftFullExtent + aHW);
          });

          topBlockers.forEach(function(blocker) {
            var blockerC = blocker.circularPathData;
            var blockerHW = Math.max(blocker.width || 0, 1) / 2;
            var blockerLeftEdge = blockerC.leftFullExtent - blockerHW;
            var blockerRightEdge = blockerC.leftFullExtent + blockerHW;
            var proposedLeftEdge = proposedRightEdge - 2 * hw;
            if (
              proposedRightEdge > blockerLeftEdge - gap + 1e-6 &&
              proposedLeftEdge < blockerRightEdge + gap - 1e-6
            ) {
              proposedRightEdge = blockerLeftEdge - gap;
            }
          });

          setLeftFullExtent(link, proposedRightEdge - hw);
          nextRightEdge =
            link.circularPathData.leftFullExtent - hw - gap;
        });
      });

      // TOP bundles use the inverse shelf direction: the larger VFE is inner,
      // while the smaller VFE is outer. Keep that order on the left legs so
      // target-side arcs do not cross before reaching adjacent target ports.
      var topByTarget = new Map();
      group.forEach(function(link) {
        if (link.circularLinkType !== "top" ||
            selfLinking(link, id) ||
            !link.target) return;
        var targetGroup = topByTarget.get(link.target);
        if (!targetGroup) {
          targetGroup = [];
          topByTarget.set(link.target, targetGroup);
        }
        targetGroup.push(link);
      });

      var currentTopLinks = [];
      topByTarget.forEach(function(targetGroup) {
        currentTopLinks = currentTopLinks.concat(targetGroup);
      });
      currentTopLinks.sort(function(a, b) {
        return b.circularPathData.leftFullExtent -
          a.circularPathData.leftFullExtent;
      });

      var orderedTopGroups = [];
      var orderedTopByTarget = new Map();
      currentTopLinks.forEach(function(link) {
        var targetGroup = orderedTopByTarget.get(link.target);
        if (!targetGroup) {
          targetGroup = [];
          orderedTopByTarget.set(link.target, targetGroup);
          orderedTopGroups.push(targetGroup);
        }
        targetGroup.push(link);
      });

      var orderedTopLinks = [];
      orderedTopGroups.forEach(function(targetGroup) {
        targetGroup.sort(function(a, b) {
          return b.circularPathData.verticalFullExtent -
            a.circularPathData.verticalFullExtent;
        });
        orderedTopLinks = orderedTopLinks.concat(targetGroup);
      });

      var nextTopRightEdge = -Infinity;
      currentTopLinks.forEach(function(link) {
        var hw = Math.max(link.width || 0, 1) / 2;
        var rightEdge = link.circularPathData.leftFullExtent + hw;
        if (rightEdge > nextTopRightEdge) nextTopRightEdge = rightEdge;
      });

      var bottomBlockers = group.filter(function(link) {
        return link.circularLinkType === "bottom";
      }).sort(function(a, b) {
        var aHW = Math.max(a.width || 0, 1) / 2;
        var bHW = Math.max(b.width || 0, 1) / 2;
        return (b.circularPathData.leftFullExtent + bHW) -
          (a.circularPathData.leftFullExtent + aHW);
      });

      orderedTopLinks.forEach(function(link) {
        var hw = Math.max(link.width || 0, 1) / 2;
        var proposedRightEdge = nextTopRightEdge;
        var topC = link.circularPathData;
        var topYMin = Math.min(topC.targetY, topC.verticalFullExtent);
        var topYMax = Math.max(topC.targetY, topC.verticalFullExtent);

        bottomBlockers.forEach(function(blocker) {
          var blockerC = blocker.circularPathData;
          var blockerYMin = Math.min(
            blockerC.targetY,
            blockerC.verticalLeftInnerExtent
          );
          var blockerYMax = Math.max(
            blockerC.targetY,
            blockerC.verticalLeftInnerExtent
          );
          if (
            Math.min(topYMax, blockerYMax) <=
            Math.max(topYMin, blockerYMin) + 1e-6
          ) return;

          var blockerHW = Math.max(blocker.width || 0, 1) / 2;
          var blockerLeftEdge =
            blockerC.leftFullExtent - blockerHW;
          var blockerRightEdge =
            blockerC.leftFullExtent + blockerHW;
          var proposedLeftEdge = proposedRightEdge - 2 * hw;
          if (
            proposedRightEdge > blockerLeftEdge - gap + 1e-6 &&
            proposedLeftEdge < blockerRightEdge + gap - 1e-6
          ) {
            proposedRightEdge = blockerLeftEdge - gap;
          }
        });

        setLeftFullExtent(link, proposedRightEdge - hw);
        preserveTopTargetArcCeiling(link);
        nextTopRightEdge =
          link.circularPathData.leftFullExtent - hw - gap;
      });

      // Target-bundle repacking above can move a link back inside a self-loop
      // that the generic resolver had already cleared. Re-assert the fixed
      // self-loop anchor here, moving the affected target bundle atomically.
      var finalSelfLoops = group.filter(function(link) {
        return selfLinking(link, id);
      });
      finalSelfLoops.forEach(function(loop) {
        var loopC = loop.circularPathData;
        var loopYMin = Math.min(
          loopC.targetY,
          loopC.verticalLeftInnerExtent
        );
        var loopYMax = Math.max(
          loopC.targetY,
          loopC.verticalLeftInnerExtent
        );
        var loopHW = Math.max(loop.width || 0, 1) / 2;
        var loopLeftEdge = loopC.leftFullExtent - loopHW;
        var affectedBundles = new Map();
        var maxDeficit = 0;

        group.forEach(function(link) {
          if (link === loop || selfLinking(link, id)) return;
          var c = link.circularPathData;
          var linkYMin = Math.min(c.targetY, c.verticalLeftInnerExtent);
          var linkYMax = Math.max(c.targetY, c.verticalLeftInnerExtent);
          if (
            Math.min(loopYMax, linkYMax) <=
            Math.max(loopYMin, linkYMin) + 1e-6
          ) return;

          var hw = Math.max(link.width || 0, 1) / 2;
          var rightEdge = c.leftFullExtent + hw;
          var deficit = rightEdge + gap - loopLeftEdge;
          var bundleKey =
            String(link.circularLinkType) + "|" +
            String(link.target && link.target.index);
          if (!affectedBundles.has(bundleKey)) {
            affectedBundles.set(bundleKey, {
              target: link.target,
              type: link.circularLinkType
            });
          }
          maxDeficit = Math.max(maxDeficit, deficit);
        });

        if (maxDeficit <= 1e-6) return;

        // Use one common shift so the already-resolved spacing between
        // different target bundles is preserved instead of aligning all
        // their right edges against the self-loop.
        affectedBundles.forEach(function(bundle) {
          group.forEach(function(link) {
            if (
              selfLinking(link, id) ||
              link.target !== bundle.target ||
              link.circularLinkType !== bundle.type
            ) return;
            setLeftFullExtent(
              link,
              link.circularPathData.leftFullExtent - maxDeficit
            );
            preserveTopTargetArcCeiling(link);
          });
        });

        var packedBundles = Array.from(affectedBundles.values()).map(
          function(bundle) {
            var links = group.filter(function(link) {
              return (
                !selfLinking(link, id) &&
                link.target === bundle.target &&
                link.circularLinkType === bundle.type
              );
            });
            return {
              bundle: bundle,
              links: links,
              rightEdge: Math.max.apply(
                null,
                links.map(function(link) {
                  return (
                    link.circularPathData.leftFullExtent +
                    Math.max(link.width || 0, 1) / 2
                  );
                })
              )
            };
          }
        ).sort(function(a, b) {
          if (Math.abs(b.rightEdge - a.rightEdge) >= 1e-6) {
            return b.rightEdge - a.rightEdge;
          }
          return (
            (a.bundle.target && a.bundle.target.index) -
            (b.bundle.target && b.bundle.target.index)
          );
        });
        var nextBundleRightEdge = loopLeftEdge - gap;
        packedBundles.forEach(function(packed) {
          var bundleShift = Math.max(
            0,
            packed.rightEdge - nextBundleRightEdge
          );
          packed.links.forEach(function(link) {
            if (bundleShift > 1e-6) {
              setLeftFullExtent(
                link,
                link.circularPathData.leftFullExtent - bundleShift
              );
              preserveTopTargetArcCeiling(link);
            }
          });
          nextBundleRightEdge =
            Math.min.apply(
              null,
              packed.links.map(function(link) {
                return (
                  link.circularPathData.leftFullExtent -
                  Math.max(link.width || 0, 1) / 2
                );
              })
            ) - gap;
        });
      });

      // Clearance is now final for this target column. If a backlink wraps
      // around its own target's self-loop, restore the concentric target turn
      // that earlier radius compaction may have flattened.
      group.forEach(function(link) {
        roundLeftTurnAroundTargetSelfLoop(link, group);
      });
    });

  })();

  // Backlinks from one source may return to different target columns, yet
  // their left legs can occupy the same corridor. Column-local packing does
  // not see that collision. Keep the farther target outside the nearer one.
  var finalSourceBundles = new Map();
  graph.links.forEach(function(link) {
    if (!link.circular || link.isVirtual || !link.circularPathData ||
        link.target.column >= link.source.column) return;
    var key = link.source.index + "|" + link.circularLinkType;
    if (!finalSourceBundles.has(key)) finalSourceBundles.set(key, []);
    finalSourceBundles.get(key).push(link);
  });
  finalSourceBundles.forEach(function(group) {
    group.sort(function(a, b) { return b.target.column - a.target.column; });
    for (var i = 1; i < group.length; i++) {
      var outer = group[i];
      var c = outer.circularPathData;
      for (var j = 0; j < i; j++) {
        var inner = group[j];
        if (outer.target.column === inner.target.column) continue;
        var ic = inner.circularPathData;
        var outerMin = Math.min(c.targetY, c.verticalFullExtent);
        var outerMax = Math.max(c.targetY, c.verticalFullExtent);
        var innerMin = Math.min(ic.targetY, ic.verticalFullExtent);
        var innerMax = Math.max(ic.targetY, ic.verticalFullExtent);
        if (Math.min(outerMax, innerMax) <= Math.max(outerMin, innerMin)) continue;
        var clearance = Math.max(outer.width || 0, 1) / 2 +
          Math.max(inner.width || 0, 1) / 2 + (circularLinkGap || 0);
        var maxLfe = ic.leftFullExtent - clearance;
        if (c.leftFullExtent <= maxLfe) continue;
        var delta = c.leftFullExtent - maxLfe;
        c.leftLargeArcRadius += delta;
        c.leftSmallArcRadius += delta;
        c.leftFullExtent = maxLfe;
        var bottom = outer.circularLinkType === "bottom";
        var turnBound = c.targetY + (bottom ? 1 : -1) *
          (c.leftLargeArcRadius + c.leftSmallArcRadius + (circularLinkGap || 0));
        var nextVfe = bottom ? Math.max(c.verticalFullExtent, turnBound) : Math.min(c.verticalFullExtent, turnBound);
        var vfeDelta = nextVfe - c.verticalFullExtent;
        c.verticalFullExtent = nextVfe;
        if (typeof c.verticalBuffer === "number") c.verticalBuffer += bottom ? vfeDelta : -vfeDelta;
        c.verticalLeftInnerExtent = nextVfe + (bottom ? -c.leftLargeArcRadius : c.leftLargeArcRadius);
        c.verticalRightInnerExtent = nextVfe + (bottom ? -c.rightLargeArcRadius : c.rightLargeArcRadius);
      }
    }
  });

  // Left-leg packing can enlarge target turns after shelf placement. Keep
  // the outer shelf outside the inner turn as well as outside its stroke.
  function preserveTargetTurnNesting() {
    var groups = new Map();
    graph.links.forEach(function(link) {
      if (!link.circular || link.isVirtual || selfLinking(link, id) ||
          !link.circularPathData || !link.target) return;
      var key = link.target.column + "|" + link.circularLinkType;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(link);
    });
    groups.forEach(function(group) {
      if (group.length < 2) return;
      group.sort(function(a, b) {
        return b.circularPathData.leftFullExtent - a.circularPathData.leftFullExtent;
      });
      for (var i = 1; i < group.length; i++) {
        var outer = group[i];
        var c = outer.circularPathData;
        var bottom = outer.circularLinkType === "bottom";
        var nextVfe = c.verticalFullExtent;
        for (var j = 0; j < i; j++) {
          var inner = group[j];
          var ic = inner.circularPathData;
          // Unrelated target turns that do not overlap vertically need no nesting.
          var outerMin = Math.min(c.targetY, c.verticalFullExtent);
          var outerMax = Math.max(c.targetY, c.verticalFullExtent);
          var innerMin = Math.min(ic.targetY, ic.verticalFullExtent);
          var innerMax = Math.max(ic.targetY, ic.verticalFullExtent);
          if (Math.min(outerMax, innerMax) <= Math.max(outerMin, innerMin)) continue;
          var clearance = Math.max(outer.width || 0, 1) / 2 +
            Math.max(inner.width || 0, 1) / 2 + (circularLinkGap || 0);
          var turnOffset = Math.max(clearance,
            c.leftLargeArcRadius - ic.leftLargeArcRadius);
          var bound = ic.verticalFullExtent + (bottom ? turnOffset : -turnOffset);
          nextVfe = bottom ? Math.max(nextVfe, bound) : Math.min(nextVfe, bound);
        }
        var delta = nextVfe - c.verticalFullExtent;
        if (Math.abs(delta) <= 1e-6) continue;
        c.verticalFullExtent = nextVfe;
        if (typeof c.verticalBuffer === "number") c.verticalBuffer += bottom ? delta : -delta;
        c.verticalLeftInnerExtent = nextVfe + (bottom ? -c.leftLargeArcRadius : c.leftLargeArcRadius);
        c.verticalRightInnerExtent = nextVfe + (bottom ? -c.rightLargeArcRadius : c.rightLargeArcRadius);
      }
    });
  }
  preserveTargetTurnNesting();

  // Target-side height adjustments must also preserve source-side nesting.
  // A farther right leg wraps outside a nearer right leg at the lower/upper
  // shelf corner; moving only the shelf can make those corners cross.
  function preserveSourceTurnNesting() {
  finalSourceBundles.forEach(function(group) {
    group.sort(function(a, b) {
      return a.circularPathData.rightFullExtent - b.circularPathData.rightFullExtent;
    });
    for (var i = 1; i < group.length; i++) {
      var outer = group[i];
      var c = outer.circularPathData;
      var bottom = outer.circularLinkType === "bottom";
      var nextVfe = c.verticalFullExtent;
      for (var j = 0; j < i; j++) {
        var inner = group[j];
        if (outer.target.column === inner.target.column) continue;
        var ic = inner.circularPathData;
        var clearance = Math.max(outer.width || 0, 1) / 2 +
          Math.max(inner.width || 0, 1) / 2 + (circularLinkGap || 0);
        var turnOffset = Math.max(clearance,
          c.rightLargeArcRadius - ic.rightLargeArcRadius);
        var bound = ic.verticalFullExtent + (bottom ? turnOffset : -turnOffset);
        nextVfe = bottom ? Math.max(nextVfe, bound) : Math.min(nextVfe, bound);
      }
      var delta = nextVfe - c.verticalFullExtent;
      if (Math.abs(delta) <= 1e-6) continue;
      c.verticalFullExtent = nextVfe;
      if (typeof c.verticalBuffer === "number") c.verticalBuffer += bottom ? delta : -delta;
      c.verticalLeftInnerExtent = nextVfe + (bottom ? -c.leftLargeArcRadius : c.leftLargeArcRadius);
      c.verticalRightInnerExtent = nextVfe + (bottom ? -c.rightLargeArcRadius : c.rightLargeArcRadius);
    }
  });

  }
  preserveSourceTurnNesting();

  // Source legs share a corridor by column, not by source node. Pack all
  // final backlink turns in that corridor with stroke clearance and order
  // their slots by actual source ports (lower ports are inner at the bottom).
  var finalSourceColumns = new Map();
  graph.links.forEach(function (link) {
    if (!link.circular || link.isVirtual || !link.circularPathData ||
        link.target.column >= link.source.column) return;
    var key = link.source.column + "|" + link.circularLinkType;
    if (!finalSourceColumns.has(key)) finalSourceColumns.set(key, []);
    finalSourceColumns.get(key).push(link);
  });
  Array.from(finalSourceColumns.values()).sort(function(a,b) {
    return Number(a[0].circularLinkType === "bottom") - Number(b[0].circularLinkType === "bottom");
  }).forEach(function (group) {
    var compactSource = group.some(function(link) { return link.source._sourceCorridorReordered; });
    if (new Set(group.map(function (link) { return link.source; })).size < 2 && !compactSource) return;
    var bottom = group[0].circularLinkType === "bottom";
    var slots = group.map(function (link) {
      return { large: link.circularPathData.rightLargeArcRadius,
               small: link.circularPathData.rightSmallArcRadius };
    }).sort(function (a, b) { return a.large - b.large; });
    group.sort(function (a, b) {
      if(bottom) {
        var mirroredDifference=Number(!!b.source._mirrorBottomSource)-Number(!!a.source._mirrorBottomSource);
        if(mirroredDifference) return mirroredDifference;
        if(a.source._mirrorBottomSource&&b.source._mirrorBottomSource)
          return a.circularPathData.sourceY-b.circularPathData.sourceY;
      }
      return bottom ? b.circularPathData.sourceY - a.circularPathData.sourceY :
        a.circularPathData.sourceY - b.circularPathData.sourceY;
    });
    group.forEach(function (link, i) {
      var c = link.circularPathData;
      var radius = Math.max(compactSource && (i>0 || !bottom) ? 0 : slots[i].large,
        baseRadius + Math.max(link.width || 0, 1) / 2);
      if (compactSource && bottom && i === 0) {
        var upper = finalSourceColumns.get(link.source.column + "|top") || [];
        upper.forEach(function(topLink) {
          radius = Math.max(radius, topLink.circularPathData.rightFullExtent - c.rightInnerExtent +
            ((topLink.width || 0) + (link.width || 0)) / 2 + (circularLinkGap || 0));
        });
      }
      if (i > 0) {
        var prev = group[i - 1];
        radius = Math.max(radius, prev.circularPathData.rightLargeArcRadius +
          Math.max(prev.width || 0, 1) / 2 + Math.max(link.width || 0, 1) / 2 + (circularLinkGap || 0));
      }
      c.rightLargeArcRadius = radius;
      c.rightSmallArcRadius = Math.max(compactSource && !bottom ? 0 : slots[i].small,
        baseRadius + Math.max(link.width || 0, 1) / 2);
      c.rightFullExtent = c.rightInnerExtent + radius;
      c.verticalRightInnerExtent = c.verticalFullExtent + (bottom ? -radius : radius);
    });
  });

  // Final band assignment and port sorting can reverse incoming routes to
  // the same node. Reorder their target turn slots to match actual port Y:
  // bottom turns wrap from lower ports outward to upper ports (top mirrors).
  (function alignTargetTurnsWithPorts() {
    var groups = new Map();
    graph.links.forEach(function (link) {
      if (!link.circular || link.isVirtual || !link.circularPathData || selfLinking(link, id)) return;
      var key = link.target.index + "|" + link.circularLinkType;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(link);
    });
    groups.forEach(function (group) {
      if (group.length < 2) return;
      var bottom = group[0].circularLinkType === "bottom";
      var ordered = group.slice().sort(function (a, b) {
        return bottom ? b.circularPathData.targetY - a.circularPathData.targetY :
          a.circularPathData.targetY - b.circularPathData.targetY;
      });
      var misplaced = ordered.some(function (link, i) {
        return i > 0 && link.circularPathData.leftFullExtent >
          ordered[i - 1].circularPathData.leftFullExtent + 1e-6;
      });
      if (!misplaced) return;
      var slots = group.map(function (link) {
        return { large: link.circularPathData.leftLargeArcRadius,
                 small: link.circularPathData.leftSmallArcRadius };
      }).sort(function (a, b) { return a.large - b.large; });
      ordered.forEach(function (link, i) {
        var c = link.circularPathData;
        var radius = Math.max(slots[i].large, baseRadius + Math.max(link.width || 0, 1) / 2);
        if (i > 0) {
          var prev = ordered[i - 1];
          radius = Math.max(radius, prev.circularPathData.leftLargeArcRadius +
            Math.max(prev.width || 0, 1) / 2 + Math.max(link.width || 0, 1) / 2 + (circularLinkGap || 0));
        }
        c.leftLargeArcRadius = radius;
        c.leftSmallArcRadius = Math.max(slots[i].small, baseRadius + Math.max(link.width || 0, 1) / 2);
        c.leftFullExtent = c.leftInnerExtent - radius;
        c.verticalLeftInnerExtent = c.verticalFullExtent + (bottom ? -radius : radius);
      });
    });
  })();

  // Leave clearance around an enclosing route's target port. A shorter
  // route's target leg can extend into that port even though the targets
  // are in different columns. Compact its entire incoming bundle together
  // so its own left-leg gaps and nesting remain unchanged.
  (function clearEnclosingTargetPorts() {
    var bundles = new Map();
    graph.links.forEach(function(link) {
      if (!link.circular || link.isVirtual || !link.circularPathData ||
          selfLinking(link, id)) return;
      var key = link.target.index + "|" + link.circularLinkType;
      if (!bundles.has(key)) bundles.set(key, []);
      bundles.get(key).push(link);
    });
    bundles.forEach(function(group) {
      var shift = 0;
      var available = Infinity;
      group.forEach(function(inner) {
        var c = inner.circularPathData;
        available = Math.min(available,
          c.leftLargeArcRadius - baseRadius - Math.max(inner.width || 0, 1) / 2,
          c.leftSmallArcRadius);
        graph.links.forEach(function(outer) {
          if (!outer.circular || !outer.circularPathData || outer.isVirtual ||
              outer.target.column >= inner.target.column ||
              outer.source.column <= inner.source.column) return;
          var oc = outer.circularPathData;
          var clearance = Math.max(outer.width || 0, 1) / 2 +
            Math.max(inner.width || 0, 1) / 2 + (circularLinkGap || 0);
          var yMin = Math.min(c.targetY, c.verticalLeftInnerExtent);
          var yMax = Math.max(c.targetY, c.verticalLeftInnerExtent);
          if (oc.targetY < yMin - clearance || oc.targetY > yMax + clearance) return;
          var requiredX = oc.targetX + clearance;
          if (c.leftFullExtent < requiredX) {
            shift = Math.max(shift, requiredX - c.leftFullExtent);
          }
        });
      });
      if (shift <= 1e-6 || shift > available + 1e-6) return;
      group.forEach(function(link) {
        var c = link.circularPathData;
        c.leftFullExtent += shift;
        c.leftLargeArcRadius -= shift;
        c.leftSmallArcRadius -= shift;
        c.verticalLeftInnerExtent = c.verticalFullExtent +
          (link.circularLinkType === "bottom" ? -c.leftLargeArcRadius : c.leftLargeArcRadius);
      });
    });
  })();

  // A long backlink enclosing another backlink must wrap around its shelf,
  // even when neither endpoint shares a column with the shorter route.
  function preserveEnclosingShelves() {
    var links = graph.links.filter(function(link) {
      return link.circular && !link.isVirtual && link.circularPathData &&
        link.target.column < link.source.column;
    }).sort(function(a, b) {
      return (a.source.column - a.target.column) - (b.source.column - b.target.column);
    });
    links.forEach(function(outer, i) {
      var c = outer.circularPathData;
      var bottom = outer.circularLinkType === "bottom";
      var nextVfe = c.verticalFullExtent;
      for (var j = 0; j < i; j++) {
        var inner = links[j];
        if (inner.circularLinkType !== outer.circularLinkType ||
            inner.source.column >= outer.source.column ||
            inner.target.column <= outer.target.column) continue;
        var clearance = Math.max(outer.width || 0, 1) / 2 +
          Math.max(inner.width || 0, 1) / 2 + (circularLinkGap || 0);
        var bound = inner.circularPathData.verticalFullExtent +
          (bottom ? clearance : -clearance);
        nextVfe = bottom ? Math.max(nextVfe, bound) : Math.min(nextVfe, bound);
      }
      var delta = nextVfe - c.verticalFullExtent;
      if (Math.abs(delta) <= 1e-6) return;
      c.verticalFullExtent = nextVfe;
      if (typeof c.verticalBuffer === "number") c.verticalBuffer += bottom ? delta : -delta;
      c.verticalLeftInnerExtent = nextVfe + (bottom ? -c.leftLargeArcRadius : c.leftLargeArcRadius);
      c.verticalRightInnerExtent = nextVfe + (bottom ? -c.rightLargeArcRadius : c.rightLargeArcRadius);
    });
  }

  // Propagate outward moves across endpoint bundles and enclosed shelves.
  // A target/source adjustment can deepen an inner route after its enclosing
  // route was placed, so stop only once the final extents no longer change.
  for (var nestingPass = 0; nestingPass < graph.links.length; nestingPass++) {
    var oldExtents = graph.links.map(function(link) {
      return link.circularPathData && link.circularPathData.verticalFullExtent;
    });
    preserveEnclosingShelves();
    preserveTargetTurnNesting();
    preserveSourceTurnNesting();
    var nestingChanged = graph.links.some(function(link, i) {
      return link.circularPathData &&
        Math.abs(link.circularPathData.verticalFullExtent - oldExtents[i]) > 1e-6;
    });
    if (!nestingChanged) break;
  }

  // Compact all bottom corridors against final geometry, from inner to outer.
  // Local loops can move inward after nesting; backlinks must release the
  // space those loops previously reserved as well.
  graph.links.filter(function(link) {
    return link.circular && !link.isVirtual && !selfLinking(link, id) &&
      link.circularLinkType === "bottom" &&
      (compactFinalBacklinks || link.source.column === link.target.column);
  }).sort(function(a, b) {
    return a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent;
  }).forEach(function(link) {
    var c = link.circularPathData;
    var gap = circularLinkGap || 0;
    var halfWidth = (link.width || 0) / 2;
    var oldVfe = c.verticalFullExtent;
    var floor = Math.max(
      c.sourceY + c.rightSmallArcRadius + c.rightLargeArcRadius + gap,
      c.targetY + c.leftSmallArcRadius + c.leftLargeArcRadius + gap
    );
    var shelf = _shelfX(link);
    graph.nodes.forEach(function(node) {
      if (node.virtual || node === link.source || node === link.target) return;
      if (node.x1 <= shelf.x0 || node.x0 >= shelf.x1) return;
      floor = Math.max(floor, node.y1 + halfWidth + gap);
    });
    graph.links.forEach(function(inner) {
      if (inner === link || !inner.circular || inner.isVirtual ||
          inner.circularLinkType !== "bottom" || !inner.circularPathData ||
          !_shelvesOverlapX(inner, link)) return;
      var ic = inner.circularPathData;
      // Preserve corridor order; outer shelves no longer reserve space here.
      if (ic.verticalFullExtent >= oldVfe - 1e-6) return;
      var clearance = ((inner.width || 0) + (link.width || 0)) / 2 + gap;
      if (!selfLinking(inner, id) && inner.target.column === link.target.column &&
          c.leftFullExtent < ic.leftFullExtent) {
        clearance = Math.max(clearance, c.leftLargeArcRadius - ic.leftLargeArcRadius);
      }
      if (!selfLinking(inner, id) && inner.source.column === link.source.column &&
          c.rightFullExtent > ic.rightFullExtent &&
          Math.abs(c.rightInnerExtent - ic.rightInnerExtent) > 1e-6) {
        // With a shared corner X, the larger arc can wrap the smaller arc
        // while both shelves keep only stroke clearance. Aligning their
        // circle centers in Y wastes the radius difference as shelf padding.
        // Retain that conservative bound for horizontally offset corners.
        clearance = Math.max(clearance, c.rightLargeArcRadius - ic.rightLargeArcRadius);
      }
      floor = Math.max(floor, ic.verticalFullExtent + clearance);
    });
    if (floor >= oldVfe - 1e-6) return;
    c.verticalFullExtent = floor;
    c.verticalBuffer += floor - oldVfe;
    c.verticalLeftInnerExtent = floor - c.leftLargeArcRadius;
    c.verticalRightInnerExtent = floor - c.rightLargeArcRadius;
  });

  // A target-order correction can put a short inner return into a source
  // corridor already used by an enclosing return. Extend the enclosing source
  // ellipse around it, independently of the compact shelf corner radius.
  if (compactFinalBacklinks) {
    graph.links.forEach(function(inner) {
      if (!inner._targetOrderRerouted || !inner.circularPathData) return;
      var ic = inner.circularPathData;
      var tidySource = graph.nodes.some(function(node) {
        return node._sourceCorridorReordered || node._mirrorTopSource;
      });
      graph.links.forEach(function(outer) {
        if (!outer.circular || outer.isVirtual || !outer.circularPathData ||
            outer.circularLinkType !== inner.circularLinkType ||
            outer.target.column >= inner.target.column ||
            outer.source.column >= inner.source.column ||
            outer.source.column <= inner.target.column) return;
        var c = outer.circularPathData;
        var gap = ((outer.width || 0) + (inner.width || 0)) / 2 + (circularLinkGap || 0);
        var right = ic.rightFullExtent + gap;
        if (c.rightFullExtent >= right) return;
        if (tidySource && outer.circularLinkType === "top") {
          // A long departure is a straight source stub, not an oversized arc.
          // Local round corners need no extra shelf height to wrap the inner
          // return, and preserve the target's inner-to-outer shelf order.
          var radius = baseRadius+(outer.width || 0)/2;
          c.rightFullExtent = right;
          c.rightLargeArcRadius = radius;
          c.rightSmallArcRadius = radius;
          c.rightSourceLargeArcRadius = radius;
          c.rightDepartureInnerExtent = right-radius;
          c.rightShelfInnerExtent = right-radius;
          var nextVfe = ic.verticalFullExtent-gap;
          c.verticalBuffer += c.verticalFullExtent-nextVfe;
          c.verticalFullExtent = nextVfe;
          c.verticalRightInnerExtent = nextVfe+radius;
          c.verticalLeftInnerExtent = nextVfe+c.leftLargeArcRadius;
          return;
        }
        c.rightFullExtent = right;
        c.rightSourceLargeArcRadius = right - c.rightInnerExtent;
        c.rightShelfInnerExtent = right - c.rightLargeArcRadius;
        var bottom = outer.circularLinkType === "bottom";
        // Travel beyond the inner source before rising into its corridor.
        // The departure ellipse and the shelf corner need different heights.
        var departureRoom = bottom ? ic.sourceY - c.sourceY - gap : c.sourceY - ic.sourceY - gap;
        if (departureRoom > baseRadius + (outer.width || 0) / 2) {
          c.rightSmallArcRadius = Math.min(c.rightSmallArcRadius, departureRoom);
        }
        var cornerClearance = Math.max(gap, c.rightLargeArcRadius - ic.rightLargeArcRadius);
        var bound = ic.verticalFullExtent + (bottom ? cornerClearance : -cornerClearance);
        var departureBound = c.sourceY + (bottom ? 1 : -1) *
          (c.rightSmallArcRadius + c.rightLargeArcRadius + (circularLinkGap || 0));
        bound = bottom ? Math.max(bound, departureBound) : Math.min(bound, departureBound);
        var oldVfe = c.verticalFullExtent;
        c.verticalFullExtent = bottom ? Math.max(oldVfe, bound) : Math.min(oldVfe, bound);
        c.verticalBuffer += bottom ? c.verticalFullExtent - oldVfe : oldVfe - c.verticalFullExtent;
        c.verticalRightInnerExtent = c.verticalFullExtent + (bottom ? -c.rightLargeArcRadius : c.rightLargeArcRadius);
        c.verticalLeftInnerExtent = c.verticalFullExtent + (bottom ? -c.leftLargeArcRadius : c.leftLargeArcRadius);
      });
    });
  }

  // Mixed sources can have upward and downward returns from several nodes.
  // Their departure order cannot be separated by moving nodes. Route the top
  // conflicting departures on the preceding side of the source column instead.
  // Upper sources retain their conventional right-side departures.
  if (compactFinalBacklinks) {
    var mirroredColumns = false;
    finalSourceColumns.forEach(function(group) {
      if (group[0].circularLinkType !== "top" ||
          !group.some(function(link) { return link.source._mirrorTopSource; })) return;
      mirroredColumns = true;
      var rightSources = group.filter(function(link) { return link.source._outerTopSource; });
      group = group.filter(function(link) { return link.source._mirrorTopSource; });
      group.sort(function(a,b) { return b.circularPathData.sourceY-a.circularPathData.sourceY; });
      var radius = 0;
      group.forEach(function(link,i) {
        var c = link.circularPathData;
        radius = i === 0 ? baseRadius+(link.width||0)/2 : radius+
          ((group[i-1].width||0)+(link.width||0))/2+(circularLinkGap||0);
        if (!link.source._insetTopSource) c.mirroredSourceRadius = radius;
        else {
          c.rightLargeArcRadius = c.rightSmallArcRadius = radius;
          c.rightFullExtent = c.rightInnerExtent+radius;
        }
        c.verticalFullExtent = Math.min(c.verticalFullExtent,c.sourceY-2*radius-(circularLinkGap||0));
        if (link.source._insetTopSource) c.verticalRightInnerExtent = c.verticalFullExtent+radius;
        c.verticalLeftInnerExtent = c.verticalFullExtent+c.leftLargeArcRadius;
      });
      // Lower source ports wrap outside upper ports in the upper corridor.
      for(var i=group.length-2;i>=0;i--) {
        var outer=group[i],inner=group[i+1];
        var c=outer.circularPathData,ic=inner.circularPathData;
        c.verticalFullExtent=Math.min(c.verticalFullExtent,ic.verticalFullExtent-
          ((outer.width||0)+(inner.width||0))/2-(circularLinkGap||0));
        c.verticalLeftInnerExtent=c.verticalFullExtent+c.leftLargeArcRadius;
        if (outer.source._insetTopSource) c.verticalRightInnerExtent=c.verticalFullExtent+c.rightLargeArcRadius;
      }
      rightSources.forEach(function(outer) {
        var c = outer.circularPathData;
        group.forEach(function(inner) {
          c.verticalFullExtent = Math.min(c.verticalFullExtent,inner.circularPathData.verticalFullExtent-
            ((outer.width||0)+(inner.width||0))/2-(circularLinkGap||0));
        });
        c.verticalLeftInnerExtent = c.verticalFullExtent+c.leftLargeArcRadius;
        c.verticalRightInnerExtent = c.verticalFullExtent+c.rightLargeArcRadius;
      });
    });
    if (mirroredColumns) {
      // The right departure encloses the mirrored source corridor. Its changed
      // target-port order needs round, nested arrivals rather than the stale
      // flattened ellipses calculated before the final port reconciliation.
      var splitTargets = new Set();
      graph.links.forEach(function(link) {
        if (link.circular && link.circularLinkType === "top" && link.source._outerTopSource)
          splitTargets.add(link.target);
      });
      graph.links.forEach(function(link) {
        if (!link.circular || link.isVirtual || link.circularLinkType !== "top" ||
            !splitTargets.has(link.target) || !link.circularPathData) return;
        var c = link.circularPathData;
        c.leftSmallArcRadius = c.leftLargeArcRadius;
        c.verticalFullExtent = Math.min(c.verticalFullExtent,
          c.targetY-2*c.leftLargeArcRadius-(circularLinkGap||0));
        c.verticalLeftInnerExtent = c.verticalFullExtent+c.leftLargeArcRadius;
        c.verticalRightInnerExtent = c.verticalFullExtent+c.rightLargeArcRadius;
      });
      preserveTargetTurnNesting();
      // Reconciliation can lift the surrounding returns without lifting the
      // shortest inner return. Release its old shelf floor after the final
      // round target turns are known, preserving stroke and corner clearance.
      splitTargets.forEach(function(target) {
        var group = graph.links.filter(function(link) {
          return link.circular && !link.isVirtual && !selfLinking(link,id) &&
            link.circularLinkType === "top" && link.target === target &&
            link.source.column > link.target.column && link.circularPathData;
        }).sort(function(a,b) {
          return a.circularPathData.leftFullExtent-b.circularPathData.leftFullExtent;
        });
        if (group.length < 2) return;
        var inner = group[group.length-1], c = inner.circularPathData;
        var enclosing = group.slice(0,-1);
        if (enclosing.some(function(outer) {
          return outer.source.column <= inner.source.column ||
            Math.abs(outer.circularPathData.leftInnerExtent-c.leftInnerExtent)>1e-6;
        })) return;
        var floor = -Infinity;
        enclosing.forEach(function(outer) {
          var oc = outer.circularPathData;
          var clearance = ((inner.width||0)+(outer.width||0))/2+(circularLinkGap||0);
          floor = Math.max(floor,oc.verticalFullExtent+
            Math.max(clearance,oc.leftLargeArcRadius-c.leftLargeArcRadius));
        });
        var turnLimit = Math.min(c.sourceY-c.rightSmallArcRadius-c.rightLargeArcRadius-(circularLinkGap||0),
          c.targetY-c.leftSmallArcRadius-c.leftLargeArcRadius-(circularLinkGap||0));
        if (floor >= c.verticalFullExtent || floor > turnLimit) return;
        c.verticalBuffer += c.verticalFullExtent-floor;
        c.verticalFullExtent = floor;
        c.verticalLeftInnerExtent = floor+c.leftLargeArcRadius;
        c.verticalRightInnerExtent = floor+c.rightLargeArcRadius;
      });
    }
  }

  // Bridge the space above a lower target. Every connection between two
  // nodes keeps its conventional right source port and left target port.
  if (compactFinalBacklinks && compactSourceTurns) {
    graph.links.forEach(function(link) {
      if (!link.circular || link.isVirtual || selfLinking(link,id) ||
          link.source.column!==link.target.column || !link.circularPathData ||
          (link.target._mirrorTopSource&&!link.target._insetTopSource) ||
          !link.target.sourceLinks.some(l=>l.circular&&!l.isVirtual&&
            l.source.column>l.target.column&&l.circularLinkType==="top")) return;
      var c=link.circularPathData,gap=circularLinkGap||0,half=(link.width||0)/2;
      var radius=baseRadius+half;
      var right=link.source.x1+c.rightNodeBuffer+radius;
      var shelf=Math.max(link.source.y1+half+gap,c.sourceY+2*radius+gap);
      graph.links.forEach(function(inner) {
        var ic=inner.circularPathData;
        if (inner===link || !inner.circular || inner.isVirtual || !ic ||
            inner.source!==link.source || !selfLinking(inner,id) || inner.circularLinkType!=="bottom") return;
        var clearance=half+(inner.width||0)/2+gap;
        right=Math.max(right,ic.rightFullExtent+clearance);
        shelf=Math.max(shelf,ic.verticalFullExtent+clearance);
      });
      var ceiling=Math.min(link.target.y0-half-gap,c.targetY-2*radius-gap);
      if (shelf>ceiling+1e-6) return;
      if (graph.nodes.some(node=>node!==link.source&&node!==link.target&&!node.virtual&&
          node.column===link.source.column&&node.y0-half-gap<shelf&&node.y1+half+gap>shelf)) return;
      c.localPortBridgeRadius=radius;
      c.sourceX=link.source.x1;c.targetX=link.target.x0;
      c.rightFullExtent=right;c.rightInnerExtent=right-radius;
      c.leftInnerExtent=c.targetX-c.leftNodeBuffer;c.leftFullExtent=c.leftInnerExtent-radius;
      c.leftLargeArcRadius=c.leftSmallArcRadius=c.rightLargeArcRadius=c.rightSmallArcRadius=radius;
      c.verticalFullExtent=shelf;c.verticalRightInnerExtent=shelf-radius;c.verticalLeftInnerExtent=shelf+radius;
      // Lower upward departures wrap outside this short bridge. Move an
      // entire source bundle together so existing lane gaps stay intact.
      var shifts=new Map();
      graph.links.forEach(function(outer) {
        var oc=outer.circularPathData;
        if (outer===link || !outer.circular || outer.isVirtual || !oc ||
            outer.circularLinkType!=="top" || outer.source.column!==link.source.column ||
            outer.source.column<=outer.target.column || oc.mirroredSourceRadius || oc.sourceY<=c.sourceY) return;
        var clearance=half+(outer.width||0)/2+gap;
        if (Math.min(oc.sourceY,shelf)+clearance<Math.max(oc.verticalFullExtent,c.sourceY)) return;
        shifts.set(outer.source,Math.max(shifts.get(outer.source)||0,right+clearance-oc.rightFullExtent));
      });
      graph.links.forEach(function(peer) {
        var pc=peer.circularPathData,shift=shifts.get(peer.source);
        if (shift>0 && peer.circular && !peer.isVirtual && pc && peer.circularLinkType==="top" &&
            peer.source.column>peer.target.column&&!pc.mirroredSourceRadius) {
          pc.rightFullExtent+=shift;
          pc.sourceStubExtended=true;
        }
      });
    });
  }

  // Lane allocation determines the vertical leg, never the corner size.
  // Keep that allocation and bridge the horizontal offset with a straight
  // stub, using one local round radius derived only from the stroke width.
  if (compactFinalBacklinks && compactSourceTurns) {
    // An inset source no longer shares its node X with the whole column.
    // Repack its independent return lanes from current node positions rather
    // than retaining turn-slot offsets inherited before the source inset.
    var insetColumns = new Set(graph.nodes.filter(function(node) {
      return node._insetTopSource;
    }).map(function(node) { return node.column; }));
    insetColumns.forEach(function(column) {
      var group = graph.links.filter(function(link) {
        return link.circular && !link.isVirtual && link.source.column === column &&
          link.source.column > link.target.column && link.circularPathData &&
          !link.circularPathData.mirroredSourceRadius;
      }).sort(function(a,b) {
        return a.circularPathData.rightFullExtent-b.circularPathData.rightFullExtent;
      });
      group.forEach(function(link,i) {
        var c = link.circularPathData;
        var leg = link.source.x1+c.rightNodeBuffer+baseRadius+(link.width||0)/2;
        function overlaps(other) {
          var oc = other.circularPathData;
          return Math.min(Math.max(c.sourceY,c.verticalFullExtent),Math.max(oc.sourceY,oc.verticalFullExtent)) >=
            Math.max(Math.min(c.sourceY,c.verticalFullExtent),Math.min(oc.sourceY,oc.verticalFullExtent));
        }
        function clear(other) {
          leg = Math.max(leg,other.circularPathData.rightFullExtent+
            ((link.width||0)+(other.width||0))/2+(circularLinkGap||0));
        }
        group.slice(0,i).forEach(function(other) {
          if (other.circularLinkType === link.circularLinkType || overlaps(other)) clear(other);
        });
        graph.links.forEach(function(other) {
          if (!other.circular || other.isVirtual || !other.circularPathData ||
              other.circularPathData.localDownwardRadius || other.circularPathData.mirroredSourceRadius) return;
          if (other.source.column === column && other.target.column === column && overlaps(other)) clear(other);
          if (other._targetOrderRerouted && other.circularLinkType === link.circularLinkType &&
              link.target.column < other.target.column && link.source.column < other.source.column &&
              link.source.column > other.target.column) leg = Math.max(leg,c.rightFullExtent);
        });
        c.rightFullExtent = Math.min(c.rightFullExtent,leg);
      });
    });
    graph.links.forEach(function(link) {
      if (!link.circular || link.isVirtual || link.source.column <= link.target.column ||
          !link.circularPathData) return;
      var c = link.circularPathData;
      var radius = baseRadius+(link.width||0)/2;
      if (c.mirroredSourceRadius) {
        c.mirroredSourceFullExtent = link.source.x0-c.rightNodeBuffer-c.mirroredSourceRadius;
        c.mirroredSourceRadius = radius;
      } else {
        c.rightLargeArcRadius = c.rightSmallArcRadius = c.rightSourceLargeArcRadius = radius;
        c.rightDepartureInnerExtent = c.rightFullExtent-radius;
        c.rightShelfInnerExtent = c.rightFullExtent-radius;
        c.verticalRightInnerExtent = c.verticalFullExtent+
          (link.circularLinkType === "top" ? radius : -radius);
      }
    });
  }

  if (compactFinalBacklinks && compactSourceTurns) {
    // Mirroring replaces the old right-side turn with a shorter left-side
    // departure. Release its obsolete shelf padding against final geometry,
    // while retaining the established inner-to-outer corridor order.
    function finalTopShelf(link) {
      var c=link.circularPathData;
      var source=c.mirroredSourceRadius ? c.mirroredSourceFullExtent-
        (c.mirroredSourceShelfRadius || c.mirroredSourceRadius) :
        (c.rightShelfInnerExtent || c.rightInnerExtent);
      return {x0:Math.min(source,c.leftInnerExtent),x1:Math.max(source,c.leftInnerExtent)};
    }
    // Port reordering can leave unoccupied turn slots in a target bundle.
    // Repack both the target radii and their shelves against final geometry;
    // moving shelves alone leaves mismatched nested bend centers.
    var topTargets=new Map();
    graph.links.forEach(function(link) {
      if (!link.circular || link.isVirtual || link.circularLinkType!=="top" ||
          !link.circularPathData || link.source.column<=link.target.column) return;
      if (!topTargets.has(link.target)) topTargets.set(link.target,[]);
      topTargets.get(link.target).push(link);
    });
    topTargets.forEach(function(bundle) {
      if (bundle.length<2) return;
      bundle.sort(function(a,b) { return a.circularPathData.targetY-b.circularPathData.targetY; });
      bundle.forEach(function(link,i) {
        if (!i) return;
        var c=link.circularPathData,previous=bundle[i-1],pc=previous.circularPathData;
        var gap=circularLinkGap || 0,half=(link.width || 0)/2;
        var clearance=half+(previous.width || 0)/2+gap;
        var radius=Math.max(baseRadius+half,pc.leftLargeArcRadius+clearance);
        // A foreign target lane inside this slot is an occupied boundary.
        // Use the whole old leg span, including both rounded ends.
        graph.links.forEach(function(other) {
          var oc=other.circularPathData;
          if (bundle.includes(other) || !other.circular || other.isVirtual || !oc ||
              oc.leftFullExtent<=c.leftFullExtent+1e-6 || oc.leftFullExtent>=c.leftInnerExtent) return;
          var margin=half+(other.width || 0)/2+gap;
          if (Math.min(Math.max(c.targetY,c.verticalFullExtent),Math.max(oc.targetY,oc.verticalFullExtent))+margin<
              Math.max(Math.min(c.targetY,c.verticalFullExtent),Math.min(oc.targetY,oc.verticalFullExtent))) return;
          radius=Math.max(radius,c.leftInnerExtent-oc.leftFullExtent+margin);
        });
        radius=Math.min(c.leftLargeArcRadius,radius);
        var shrink=c.leftLargeArcRadius-radius;
        var small=Math.min(c.leftSmallArcRadius,
          Math.max(baseRadius+half,c.leftSmallArcRadius-shrink));
        var departure=c.mirroredSourceRadius || c.rightSmallArcRadius;
        var sourceCorner=c.mirroredSourceRadius ? (c.mirroredSourceShelfRadius || departure) : c.rightLargeArcRadius;
        var ceiling=Math.min(c.sourceY-departure-sourceCorner-gap,c.targetY-small-radius-gap,
          pc.verticalFullExtent-Math.max(clearance,radius-pc.leftLargeArcRadius));
        var shelf=finalTopShelf(link);
        graph.nodes.forEach(function(node) {
          if (node.virtual || node===link.source || node===link.target ||
              node.x1<=shelf.x0 || node.x0>=shelf.x1) return;
          ceiling=Math.min(ceiling,node.y0-half-gap);
        });
        graph.links.forEach(function(other) {
          var oc=other.circularPathData;
          if (bundle.includes(other) || !other.circular || other.isVirtual ||
              other.circularLinkType!=="top" || !oc || oc.localDownwardRadius ||
              oc.verticalFullExtent<=c.verticalFullExtent+1e-6) return;
          var os=finalTopShelf(other);
          if (os.x1<=shelf.x0 || os.x0>=shelf.x1) return;
          var margin=half+(other.width || 0)/2+gap;
          if (!selfLinking(other,id) && other.target.column===link.target.column &&
              c.leftFullExtent<oc.leftFullExtent) margin=Math.max(margin,radius-oc.leftLargeArcRadius);
          ceiling=Math.min(ceiling,oc.verticalFullExtent-margin);
        });
        var nextVfe=Math.max(c.verticalFullExtent,ceiling);
        c.verticalBuffer-=nextVfe-c.verticalFullExtent;
        c.leftLargeArcRadius=radius;
        c.leftSmallArcRadius=small;
        c.leftFullExtent=c.leftInnerExtent-radius;
        c.verticalFullExtent=nextVfe;
        c.verticalLeftInnerExtent=nextVfe+radius;
        c.verticalRightInnerExtent=nextVfe+sourceCorner;
      });
    });
    graph.links.filter(function(link) {
      return link.circular && !link.isVirtual && link.circularLinkType==="top" &&
        link.circularPathData && link.circularPathData.mirroredSourceRadius;
    }).sort(function(a,b) {
      return b.circularPathData.verticalFullExtent-a.circularPathData.verticalFullExtent;
    }).forEach(function(link) {
      var c=link.circularPathData,gap=circularLinkGap || 0,oldVfe=c.verticalFullExtent;
      var radius=c.mirroredSourceRadius;
      var ceiling=Math.min(c.sourceY-radius-(c.mirroredSourceShelfRadius || radius)-gap,
        c.targetY-c.leftSmallArcRadius-c.leftLargeArcRadius-gap);
      var shelf=finalTopShelf(link);
      graph.nodes.forEach(function(node) {
        if (node.virtual || node===link.source || node===link.target ||
            node.x1<=shelf.x0 || node.x0>=shelf.x1) return;
        ceiling=Math.min(ceiling,node.y0-(link.width || 0)/2-gap);
      });
      graph.links.forEach(function(inner) {
        var ic=inner.circularPathData;
        if (inner===link || !inner.circular || inner.isVirtual ||
            inner.circularLinkType!=="top" || !ic || ic.localDownwardRadius ||
            ic.verticalFullExtent<=oldVfe+1e-6) return;
        var innerShelf=finalTopShelf(inner);
        if (innerShelf.x1<=shelf.x0 || innerShelf.x0>=shelf.x1) return;
        var clearance=((link.width || 0)+(inner.width || 0))/2+gap;
        if (!selfLinking(inner,id) && inner.target.column===link.target.column &&
            c.leftFullExtent<ic.leftFullExtent)
          clearance=Math.max(clearance,c.leftLargeArcRadius-ic.leftLargeArcRadius);
        ceiling=Math.min(ceiling,ic.verticalFullExtent-clearance);
      });
      if (ceiling<=oldVfe+1e-6) return;
      // Move a shared target bundle together. Moving just its inner shelf
      // destroys the common center of the already nested arrival corners.
      var bundle=graph.links.filter(function(peer) {
        return peer.circular && !peer.isVirtual && peer.circularLinkType==="top" &&
          peer.target===link.target && peer.source.column>peer.target.column;
      });
      if (bundle.some(function(peer) {
        return peer!==link && peer.circularPathData.verticalFullExtent>oldVfe+1e-6;
      })) return;
      var shift=ceiling-oldVfe;
      bundle.forEach(function(peer) {
        var pc=peer.circularPathData,peerShelf=finalTopShelf(peer);
        var departure=pc.mirroredSourceRadius || pc.rightSmallArcRadius;
        var corner=pc.mirroredSourceRadius ? (pc.mirroredSourceShelfRadius || departure) : pc.rightLargeArcRadius;
        var limit=Math.min(pc.sourceY-departure-corner-gap,
          pc.targetY-pc.leftSmallArcRadius-pc.leftLargeArcRadius-gap);
        graph.nodes.forEach(function(node) {
          if (node.virtual || node===peer.source || node===peer.target ||
              node.x1<=peerShelf.x0 || node.x0>=peerShelf.x1) return;
          limit=Math.min(limit,node.y0-(peer.width || 0)/2-gap);
        });
        graph.links.forEach(function(other) {
          var oc=other.circularPathData;
          if (bundle.includes(other) || !other.circular || other.isVirtual ||
              other.circularLinkType!=="top" || !oc || oc.localDownwardRadius ||
              oc.verticalFullExtent<=pc.verticalFullExtent+1e-6) return;
          var otherShelf=finalTopShelf(other);
          if (otherShelf.x1<=peerShelf.x0 || otherShelf.x0>=peerShelf.x1) return;
          var clearance=((peer.width || 0)+(other.width || 0))/2+gap;
          if (!selfLinking(other,id) && other.target.column===peer.target.column &&
              pc.leftFullExtent<oc.leftFullExtent)
            clearance=Math.max(clearance,pc.leftLargeArcRadius-oc.leftLargeArcRadius);
          limit=Math.min(limit,oc.verticalFullExtent-clearance);
        });
        shift=Math.min(shift,limit-pc.verticalFullExtent);
      });
      if (shift<=1e-6) return;
      bundle.forEach(function(peer) {
        var pc=peer.circularPathData;
        pc.verticalBuffer-=shift;
        pc.verticalFullExtent+=shift;
        pc.verticalLeftInnerExtent=pc.verticalFullExtent+pc.leftLargeArcRadius;
        pc.verticalRightInnerExtent=pc.verticalFullExtent+
          (pc.mirroredSourceRadius ? (pc.mirroredSourceShelfRadius || pc.mirroredSourceRadius) : pc.rightLargeArcRadius);
      });
    });
  }

  if (compactFinalBacklinks && compactSourceTurns) {
    var cornerGroups = new Map();
    graph.links.forEach(function(link) {
      var c = link.circularPathData;
      if (!link.circular || link.isVirtual || !c || c.localPortBridgeRadius ||
          (link.source.column <= link.target.column && !selfLinking(link,id))) return;
      var mirrored = !!c.mirroredSourceRadius;
      var key = link.source.column+"|"+link.circularLinkType+"|"+mirrored;
      if (!cornerGroups.has(key)) cornerGroups.set(key, []);
      cornerGroups.get(key).push({link:link,c:c,mirrored:mirrored,
        x:mirrored?c.mirroredSourceFullExtent:c.rightFullExtent,
        departure:mirrored?c.mirroredSourceRadius:c.rightSmallArcRadius,
        shelf:mirrored?c.mirroredSourceRadius:c.rightLargeArcRadius});
    });
    cornerGroups.forEach(function(group) {
      // Contiguous parallel lanes need nested radii, not independently small
      // corners. Keep lane axes fixed and grow only an outer bundle corner.
      group.sort(function(a,b) { return a.mirrored?b.x-a.x:a.x-b.x; });
      group.forEach(function(turn,i) {
        // Self-loops retain their compact geometry but anchor enclosing bends.
        if (selfLinking(turn.link,id)) return;
        var c=turn.c,top=turn.link.circularLinkType==="top";
        var room=Math.abs(c.sourceY-c.verticalFullExtent);
        for(var j=0;j<i;j++) {
          var inner=group[j],ic=inner.c;
          var dx=turn.mirrored?inner.x-turn.x:turn.x-inner.x;
          var spacing=((turn.link.width||0)+(inner.link.width||0))/2+(circularLinkGap||0);
          if (Math.abs(dx-spacing)>1e-5) continue;
          var dy=top?c.sourceY-ic.sourceY:ic.sourceY-c.sourceY;
          var sourceRoom=turn.mirrored?turn.link.source.x0-c.rightNodeBuffer-turn.x:
            turn.x-c.sourceX-c.rightNodeBuffer;
          var departure=inner.departure+Math.min(dx,dy);
          if (dy>0 && Math.abs(dx-dy)<=(circularLinkGap||0)+1e-5 &&
              departure<=Math.min(sourceRoom,room-turn.shelf)+1e-5)
            turn.departure=Math.max(turn.departure,departure);
          var shelfDelta=top?ic.verticalFullExtent-c.verticalFullExtent:
            c.verticalFullExtent-ic.verticalFullExtent;
          // Mirrored departures still turn left at the upper shelf; only
          // rightward-growing axes can share the same shelf bend center.
          var shelf=inner.shelf+dx;
          if (!turn.mirrored && Math.abs(dx-shelfDelta)<1e-5 &&
              shelf<=Math.min(room-turn.departure,turn.x-c.leftInnerExtent)+1e-5)
            turn.shelf=Math.max(turn.shelf,shelf);
        }
        if (turn.mirrored) {
          c.mirroredSourceRadius=turn.departure;
          c.mirroredSourceShelfRadius=turn.shelf;
        } else {
          c.rightSmallArcRadius=c.rightSourceLargeArcRadius=turn.departure;
          c.rightLargeArcRadius=turn.shelf;
          c.rightDepartureInnerExtent=turn.x-turn.departure;
          c.rightShelfInnerExtent=turn.x-turn.shelf;
          c.verticalRightInnerExtent=c.verticalFullExtent+(top?turn.shelf:-turn.shelf);
        }
      });
    });
  }

  if (compactFinalBacklinks && compactSourceTurns) {
    // A return to an earlier column can wrap a whole target bundle. Its
    // shelf corner is independent of the small arrival corner at its node.
    // Grow only the shelf bend, within both its horizontal and vertical room.
    ["top","bottom"].forEach(function(band) {
      var bottom=band==="bottom";
      var targetCounts=new Map();
      graph.links.forEach(function(link) {
        if (link.circular && !link.isVirtual && link.circularLinkType===band &&
            link.source.column>link.target.column)
          targetCounts.set(link.target,(targetCounts.get(link.target) || 0)+1);
      });
      var turns=graph.links.filter(function(link) {
        return link.circular && !link.isVirtual && link.circularLinkType===band &&
          link.circularPathData && !link.circularPathData.localDownwardRadius && !link.circularPathData.localPortBridgeRadius;
      }).sort(function(a,b) {
        return b.circularPathData.leftFullExtent-a.circularPathData.leftFullExtent;
      });
      // Different target nodes in one column can already share a nested
      // corner. Protect both members of that frame before adapting any one
      // of them around a later column; independent growth breaks their gap.
      var pairedTargetCorners=new Set();
      for (var a=0;a<turns.length;a++) {
        var first=turns[a],fc=first.circularPathData;
        if (first.source.column<=first.target.column) continue;
        for (var b=a+1;b<turns.length;b++) {
          var second=turns[b],sc=second.circularPathData;
          if (second.source.column<=second.target.column ||
              first.target.column!==second.target.column) continue;
          var spacing=((first.width || 0)+(second.width || 0))/2+(circularLinkGap || 0);
          if (Math.abs(Math.abs(fc.leftFullExtent-sc.leftFullExtent)-spacing)>1e-5 ||
              Math.abs(Math.abs(fc.verticalFullExtent-sc.verticalFullExtent)-spacing)>1e-5) continue;
          var centerX=fc.leftFullExtent+fc.leftLargeArcRadius;
          var otherX=sc.leftFullExtent+sc.leftLargeArcRadius;
          var centerY=fc.verticalFullExtent+(bottom?-fc.leftLargeArcRadius:fc.leftLargeArcRadius);
          var otherY=sc.verticalFullExtent+(bottom?-sc.leftLargeArcRadius:sc.leftLargeArcRadius);
          if (Math.abs(centerX-otherX)>1e-5 || Math.abs(centerY-otherY)>1e-5) continue;
          pairedTargetCorners.add(first);
          pairedTargetCorners.add(second);
        }
      }
      turns.forEach(function(link,i) {
        // A shared-target bundle or paired column corner owns its bend center.
        if (link.source.column<=link.target.column || targetCounts.get(link.target)>1 ||
            pairedTargetCorners.has(link)) return;
        var c=link.circularPathData;
        var radiusX=c.leftLargeArcRadius, radiusY=c.leftLargeArcRadius;
        var horizontalEnd=c.rightShelfInnerExtent || c.rightInnerExtent;
        if (c.mirroredSourceRadius) horizontalEnd=c.mirroredSourceFullExtent-
          (c.mirroredSourceShelfRadius || c.mirroredSourceRadius);
        var verticalRoom=Math.abs(c.verticalFullExtent-c.targetY)-c.leftSmallArcRadius;
        var horizontalRoom=horizontalEnd-c.leftFullExtent;
        for (var j=0;j<i;j++) {
          var inner=turns[j],ic=inner.circularPathData;
          // Same-column arrivals already share allocated target bends;
          // extending them can cut through local loops beside that column.
          if (link.target.column>=inner.target.column) continue;
          var dx=ic.leftFullExtent-c.leftFullExtent;
          var dy=(bottom?1:-1)*(c.verticalFullExtent-ic.verticalFullExtent);
          var spacing=((link.width||0)+(inner.width||0))/2+(circularLinkGap||0);
          var targetOrder=(bottom?1:-1)*(ic.targetY-c.targetY);
          if (dx<spacing-1e-5 || dy<spacing-1e-5 || targetOrder<0 ||
              Math.min(dx,dy)>spacing+1e-5) continue;
          var innerX=ic.leftShelfArcRadius || ic.leftLargeArcRadius;
          var innerY=ic.leftShelfVerticalRadius || ic.leftLargeArcRadius;
          // A circle plus the required clearance fits inside these enclosing
          // quarter-ellipse axes. Already elliptical corners need a separate
          // clearance calculation, so do not use them as nesting anchors.
          if (Math.abs(innerX-innerY)>1e-5) continue;
          var nestedX=innerX+dx, nestedY=innerY+dy;
          if (nestedX<=horizontalRoom+1e-5 && nestedY<=verticalRoom+1e-5) {
            radiusX=Math.max(radiusX,nestedX);
            radiusY=Math.max(radiusY,nestedY);
          }
        }
        // A flat ellipse can pinch its inner stroke or look like a sharp
        // elbow even before folding. Limit the axis ratio to 2:1; larger
        // column offsets remain straight shelf segments beside a round bend.
        var minCurvature=Math.min(radiusX*radiusX/radiusY,radiusY*radiusY/radiusX);
        var stretched=Math.max(radiusX,radiusY)>2*Math.min(radiusX,radiusY)+1e-5;
        if (stretched || minCurvature<baseRadius+(link.width || 0)/2-1e-5)
          radiusX=radiusY=Math.min(radiusX,radiusY);
        if (radiusX>c.leftLargeArcRadius+1e-5 || radiusY>c.leftLargeArcRadius+1e-5) {
          c.leftShelfArcRadius=radiusX;
          c.leftShelfVerticalRadius=radiusY;
          c.leftShelfInnerExtent=c.leftFullExtent+radiusX;
          c.verticalLeftInnerExtent=c.verticalFullExtent+(bottom?-radiusY:radiusY);
        }
      });
    });
  }

  if (compactFinalBacklinks && compactSourceTurns) {
    var wrappedSources=new Set();
    graph.links.forEach(function(link) {
      var c=link.circularPathData;
      if (!link.circular || link.isVirtual || !c) return;
      if (c.mirroredSourceRadius || link.source._mirrorBottomSource) wrappedSources.add(link.source);
    });
    Array.from(wrappedSources).sort(function(a,b) {
      return Number(!!a._mirrorBottomSource)-Number(!!b._mirrorBottomSource)||
        a.column-b.column||(a._mirrorBottomSource?b.y0-a.y0:a.y0-b.y0);
    }).forEach(function(source) {
      var bottom=!!source._mirrorBottomSource,sign=bottom?-1:1,band=bottom?"bottom":"top";
      var group=graph.links.filter(l=>l.circular&&!l.isVirtual&&l.source===source&&
        l.source.column>l.target.column&&l.circularLinkType===band)
        .sort((a,b)=>sign*(a.circularPathData.sourceY-b.circularPathData.sourceY));
      var gap=circularLinkGap || 0;
      var wraps=group.map(function(link,i) {
        var c=link.circularPathData,half=(link.width||0)/2,r=baseRadius+half;
        var right=bottom || c.mirroredSourceRadius ? source.x1+c.rightNodeBuffer+r : c.rightFullExtent;
        var left=!bottom && c.mirroredSourceRadius ? c.mirroredSourceFullExtent : source.x0-c.rightNodeBuffer-r;
        // Source axes on the preceding side reverse the usual lane order.
        // A later source hook must not cut through an earlier downward axis.
        if(bottom) graph.links.forEach(function(other) {
          var oc=other.circularPathData;
          if(other.circular&&!other.isVirtual&&oc&&oc.sourcePortWrap&&oc.sourcePortWrap.band==="bottom"&&
              other.source.column===source.column&&other.source.y0>source.y0)
            left=Math.min(left,oc.sourcePortWrap.left-half-(other.width||0)/2-gap);
        });
        // The source axis must stay outside local loop frames.
        graph.links.forEach(function(other) {
          var oc=other.circularPathData;
          if (!other.circular || other.isVirtual || !oc || other.source.column!==source.column ||
              !selfLinking(other,id)) return;
          var ownLoop=other.source===source&&other.circularLinkType===band&&sign*(c.sourceY-oc.sourceY)>0;
          if(!ownLoop&&sign*(source.y0-other.source.y0)<=0)return;
          var clearance=half+(other.width||0)/2+gap;
          left=Math.min(left,oc.leftFullExtent-clearance);
          if(ownLoop)right=Math.max(right,oc.rightFullExtent+clearance);
        });
        return {link:link,c:c,half:half,r:r,right:right,left:left,rightRadius:r,leftRadius:r};
      });
      for(var i=1;i<wraps.length;i++) {
        var a=wraps[i-1],b=wraps[i],clearance=a.half+b.half+gap;
        b.right=Math.max(b.right,a.right+clearance);
      }
      for(var i=wraps.length-2;i>=0;i--) {
        var a=wraps[i],b=wraps[i+1],clearance=a.half+b.half+gap;
        a.left=Math.min(a.left,b.left-clearance);
        a.leftRadius=b.leftRadius+b.left-a.left;
      }
      wraps.forEach(function(w,i) {
        if (i) w.rightRadius=wraps[i-1].rightRadius+w.right-wraps[i-1].right;
        w.y=sign*Math.min(sign*(bottom?source.y1:source.y0)-w.half-gap,sign*w.c.sourceY-w.r-w.rightRadius-gap);
        source.sourceLinks.forEach(function(loop) {
          var lc=loop.circularPathData;
          if(loop.circular&&!loop.isVirtual&&lc&&selfLinking(loop,id)&&loop.circularLinkType===band&&sign*(w.c.sourceY-lc.sourceY)>0)
            w.y=sign*Math.min(sign*w.y,sign*lc.verticalFullExtent-w.half-(loop.width||0)/2-gap);
        });
        if (i) w.y=sign*Math.min(sign*w.y,sign*wraps[i-1].y-w.half-wraps[i-1].half-gap);
        w.shelfRadius=baseRadius+w.half;
      });
      // An incoming full loop encloses this short hook. Extend its right
      // axis, keeping the small source hook inside rather than crossing it.
      source.targetLinks.forEach(function(incoming) {
        var ic=incoming.circularPathData;
        if(!incoming.circular||incoming.isVirtual||!ic||incoming.source===source||
            incoming.source.column!==source.column||ic.localPortBridgeRadius) return;
        var required=ic.rightFullExtent;
        wraps.forEach(function(w) {required=Math.max(required,w.right+w.half+(incoming.width||0)/2+gap);});
        var delta=required-ic.rightFullExtent;
        if(delta>0) {
          ic.rightFullExtent+=delta;
          ic.rightDepartureInnerExtent=(ic.rightDepartureInnerExtent||ic.rightInnerExtent)+delta;
          ic.rightShelfInnerExtent=(ic.rightShelfInnerExtent||ic.rightInnerExtent)+delta;
        }
      });
      // Opposite departures pass outside this short hook. Move their whole
      // source bundle so the established lane gaps remain intact.
      var shifts=new Map();
      wraps.forEach(function(w) {
        graph.links.forEach(function(other) {
          var oc=other.circularPathData;
          if (!other.circular || other.isVirtual || !oc || other.source===source ||
              other.source.column!==source.column || other.circularLinkType===band ||
              sign*(w.y-oc.sourceY)<=0 || sign*(oc.verticalFullExtent-w.c.sourceY)<0) return;
          var clearance=w.half+(other.width||0)/2+gap;
          if (oc.rightFullExtent>w.right+clearance || oc.rightFullExtent<source.x1) return;
          shifts.set(other.source,Math.max(shifts.get(other.source)||0,w.right+clearance-oc.rightFullExtent));
        });
      });
      graph.links.forEach(function(other) {
        var oc=other.circularPathData,shift=shifts.get(other.source);
        if (!(shift>0) || !other.circular || other.isVirtual || !oc || other.circularLinkType===band) return;
        oc.rightFullExtent+=shift;
        oc.sourceStubExtended=true;
        oc.rightDepartureInnerExtent=(oc.rightDepartureInnerExtent||oc.rightInnerExtent)+shift;
        oc.rightShelfInnerExtent=(oc.rightShelfInnerExtent||oc.rightInnerExtent)+shift;
      });
      wraps.forEach(function(w) {
        w.c.sourcePortWrap={band:band,right:w.right,left:w.left,y:w.y,departureRadius:w.r,
          rightRadius:w.rightRadius,leftRadius:w.leftRadius,shelfRadius:w.shelfRadius};
        w.c.sourceX=source.x1;
        delete w.c.mirroredSourceRadius;
        delete w.c.mirroredSourceFullExtent;
        delete w.c.mirroredSourceShelfRadius;
      });
    });
  }

  // Source-side repairs can need a little more room than the initial
  // column allocation. Reserve only the missing width, moving later columns
  // and their already allocated endpoint geometry together.
  if (compactFinalBacklinks && compactSourceTurns) {
    var bridgeColumns=new Set(graph.links.filter(l=>l.circularPathData&&
      (l.circularPathData.localPortBridgeRadius||l.source._mirrorBottomSource)).map(l=>l.source.column));
    function enclosesLaterSource(link,boundary) {
      return graph.links.some(function(other) {
        return other!==link && other.circular && other._targetOrderRerouted &&
          other.source.column>=boundary && other.circularLinkType===link.circularLinkType &&
          link.target.column<other.target.column && link.source.column<other.source.column &&
          link.source.column>other.target.column;
      });
    }
    function moveLaterColumns(boundary,shift) {
      graph.nodes.forEach(function(node) {if(node.column>=boundary){node.x0+=shift;node.x1+=shift;}});
      graph.links.forEach(function(link) {
        var c=link.circularPathData;if(!link.circular||!c)return;
        if(link.source.column>=boundary) {
          ["sourceX","rightInnerExtent","rightFullExtent","rightDepartureInnerExtent","rightShelfInnerExtent",
            "_rightFullExtentBase","mirroredSourceFullExtent"].forEach(function(key){if(Number.isFinite(c[key]))c[key]+=shift;});
          if(c.sourcePortWrap){c.sourcePortWrap.right+=shift;c.sourcePortWrap.left+=shift;}
        } else if(enclosesLaterSource(link,boundary) && !c.sourcePortWrap) {
          c.sourceStubExtended=true;
          c.rightFullExtent+=shift;
          c.rightDepartureInnerExtent=(c.rightDepartureInnerExtent||c.rightInnerExtent)+shift;
          c.rightShelfInnerExtent=(c.rightShelfInnerExtent||c.rightInnerExtent)+shift;
        }
        if(link.target.column>=boundary)
          ["targetX","leftInnerExtent","leftFullExtent","leftShelfInnerExtent"].forEach(function(key){if(Number.isFinite(c[key]))c[key]+=shift;});
      });
      graph.x1+=shift;
    }
    Array.from(bridgeColumns).sort((a,b)=>a-b).forEach(function(column) {
      var right=-Infinity,left=Infinity,gap=circularLinkGap||0;
      graph.nodes.forEach(function(node) {if(!node.virtual&&node.column>column)left=Math.min(left,node.x0);});
      graph.links.forEach(function(link) {
        var c=link.circularPathData,half=(link.width||0)/2;
        if (!link.circular || link.isVirtual || !c) return;
        if (link.source.column===column && !enclosesLaterSource(link,column+1))
          right=Math.max(right,(c.sourcePortWrap?c.sourcePortWrap.right:c.rightFullExtent)+half);
        if (link.target.column>column) left=Math.min(left,c.leftFullExtent-half);
        if (link.source.column>column && c.sourcePortWrap) left=Math.min(left,c.sourcePortWrap.left-half);
        else if (link.source.column>column && c.mirroredSourceFullExtent)
          left=Math.min(left,c.mirroredSourceFullExtent-half);
      });
      var shift=right+gap-left;
      if (!(shift>1e-6) || !Number.isFinite(shift)) return;
      moveLaterColumns(column+1,shift);
    });
    // A longer enclosing source axis can lie beside a still later local
    // loop. Reserve that column separately; only source frames enclosing a
    // moved departure follow it, so an earlier enclosing axis keeps its order.
    var localColumns=Array.from(new Set(graph.links.filter(l=>l.circular&&!l.isVirtual&&selfLinking(l,id))
      .map(l=>l.source.column))).sort((a,b)=>a-b);
    localColumns.forEach(function(column) {
      var shift=0;
      graph.links.forEach(function(link) {
        var c=link.circularPathData;
        if(!link.circular||link.isVirtual||!c||!c.sourceStubExtended||c.sourcePortWrap||
            link.circularLinkType!=="top"||link.source.column>=column)return;
        var y0=c.verticalFullExtent+c.rightLargeArcRadius,y1=c.sourceY-c.rightSmallArcRadius;
        graph.links.forEach(function(loop) {
          var lc=loop.circularPathData;
          if(!loop.circular||loop.isVirtual||!lc||!selfLinking(loop,id)||loop.source.column!==column)return;
          var margin=((link.width||0)+(loop.width||0))/2+(circularLinkGap||0);
          if(Math.min(Math.max(y0,y1),Math.max(lc.sourceY,lc.verticalFullExtent))+margin<
              Math.max(Math.min(y0,y1),Math.min(lc.sourceY,lc.verticalFullExtent)))return;
          if(c.rightFullExtent-margin>=lc.rightFullExtent)return;
          shift=Math.max(shift,c.rightFullExtent+margin-lc.leftFullExtent);
        });
      });
      if(shift>1e-6)moveLaterColumns(column,shift);
    });
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
      // NOTE: for BOTTOM backlinks, we invert the group order (lower targets first) so
      // lower targets curl less deep and don't get pushed by upper-target backlinks.
      if (aIsBottomBacklinkForDepth && bIsBottomBacklinkForDepth) {
        var aTgtCYGroup =
          a.target && typeof a.target.y0 === "number" && typeof a.target.y1 === "number"
            ? (a.target.y0 + a.target.y1) / 2
            : 0;
        var bTgtCYGroup =
          b.target && typeof b.target.y0 === "number" && typeof b.target.y1 === "number"
            ? (b.target.y0 + b.target.y1) / 2
            : 0;
        if (Math.abs(aTgtCYGroup - bTgtCYGroup) >= 1e-6) return bTgtCYGroup - aTgtCYGroup;
      }

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
    // Attach group extents to each link, and pre-compute the effective baseline
    // that addCircularPathData will use for VFE (matching preferPerLinkBaseline logic).
    group.forEach(function(l) {
      l.circularPathData.groupMinY = groupMinY;
      l.circularPathData.groupMaxY = groupMaxY;
      l.circularPathData.groupSize = group.length;

      var sameCol = l.source && l.target && l.source.column === l.target.column;
      var span = Math.abs((l.source.column || 0) - (l.target.column || 0));
      var preferPerLink = sameCol ||
        (span <= 1 && (l.circularLinkType === "bottom" ||
          (l.circularLinkType === "top" && l.type === "search_nearby")));
      l.circularPathData._effectiveBaseY =
        l.circularLinkType === "bottom"
          ? (preferPerLink ? l.circularPathData._extMaxY : groupMaxY)
          : (preferPerLink ? l.circularPathData._extMinY : groupMinY);
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

      // BOTTOM-only tie-breaker: prefer groups with higher target column first.
      // Earlier processing => smaller verticalBuffer => shelf stays closer to nodes.
      // Higher target column means shorter horizontal extent on the bottom shelf,
      // so placing it inner (shallower) reduces vertical-leg crossings.
      if (a.links.length && a.links[0].circularLinkType === "bottom") {
        if (a.col !== b.col) return b.col - a.col;
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
          // For BOTTOM links, use the effective baseline (matching addCircularPathData's VFE
          // baseline selection) so the offset correction is consistent with the actual VFE shelf.
          // For TOP links, keep the per-link baseY to preserve existing bundle ordering.
          var thisBaseY = (link.circularLinkType === "bottom" &&
              typeof link.circularPathData._effectiveBaseY === "number")
            ? link.circularPathData._effectiveBaseY : link.circularPathData.baseY;
          var prevBaseY = (prevLink.circularLinkType === "bottom" &&
              typeof prevLink.circularPathData._effectiveBaseY === "number")
            ? prevLink.circularPathData._effectiveBaseY : prevLink.circularPathData.baseY;
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
            // BaseOffset correction (TOP, same target column only):
            // baseOffset is an "escape" amount; differences between links should not create
            // additional holes beyond `circularGap` when they already need to stack.
            //
            // Scope:
            // - Always safe within the same target column.
            // - Also safe across different target columns *only when baseY is equal*, because in
            //   that case the two links share the same baseline and the baseOffset delta is
            //   purely "escape" (otherwise it can invert cross-target bundle ordering).
            //
            // We only allow this correction to REDUCE buffer (negative). Positive corrections
            // would increase buffer and can create artificial holes between unrelated bundles.
            if (
              link.target.column === prevLink.target.column ||
              Math.abs(thisBaseY - prevBaseY) < 1e-6
            ) {
              var boCorr = prevBaseOffset - thisBaseOffset;
              if (boCorr < 0) offsetCorrection += boCorr;
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
            // TOP:
            // - Within the same target column: do NOT allow positive correction (can create holes / invert nesting).
            // - Across different target columns: allow a bounded positive correction so groups don't interleave
            //   when their baseY differs (otherwise offsetCorrection is clamped to 0 and bundles can overlap).
            if (offsetCorrection > 0) {
              if (link.target.column === prevLink.target.column) {
                offsetCorrection = 0;
              } else {
                // Guard: only allow small positive baseY corrections.
                // Large baseY deltas already imply natural vertical separation and letting them through
                // creates visible "holes" between adjacent shelves (regression: schedule ●→filter vs filter→saved_filters_search ●).
                var maxBaseYDeltaForPositiveTop = 10; // px; intentionally small & conservative
                var baseYDelta = thisBaseY - prevBaseY;
                if (baseYDelta > maxBaseYDeltaForPositiveTop) {
                  offsetCorrection = 0;
                } else {
                  var maxPositiveOffsetCorrectionTop = Math.max(10, diagramHeight * 0.01);
                  if (offsetCorrection > maxPositiveOffsetCorrectionTop) {
                    offsetCorrection = maxPositiveOffsetCorrectionTop;
                  }
                }
              }
            }
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
        var baseY = (typeof c._effectiveBaseY === "number") ? c._effectiveBaseY
          : (typeof c.baseY === "number" ? c.baseY : 0);
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

  // Final post-pass: enforce that bottom backlinks into the same target node have VFE
  // monotonically non-decreasing with column span. Short-span arcs should stay close to
  // the node (shallow), and long-span arcs should wrap around them (deeper).
  // Without this, cross-group interactions and single-pass stacking can produce span-
  // inversions where a long-span arc sits inside a short-span arc, which looks confusing.
  if (orderedLinks.length && orderedLinks[0].circularLinkType === "bottom") {
    var byTargetSpan = {};
    orderedLinks.forEach(function(l) {
      if (!l || !l.circularPathData) return;
      if (selfLinking(l, id)) return;
      if (l.circularLinkType !== "bottom") return;
      if ((l.target.column || 0) >= (l.source.column || 0)) return;
      var tKey = l.target && (l.target.name != null ? l.target.name : l.target.index);
      if (tKey == null) return;
      if (!byTargetSpan[tKey]) byTargetSpan[tKey] = [];
      byTargetSpan[tKey].push(l);
    });

    Object.keys(byTargetSpan).forEach(function(tKey) {
      var arr = byTargetSpan[tKey];
      if (arr.length < 2) return;

      // Compute VFE for each link (matching addCircularPathData logic) so we compare actual shelves.
      function vfeOf(l) {
        var c = l.circularPathData;
        var baseline = (typeof c._effectiveBaseY === "number") ? c._effectiveBaseY : c.baseY;
        var bo = (typeof c._baseOffsetForBuffer === "number") ? c._baseOffsetForBuffer : 0;
        return baseline + bo + (c.verticalBuffer || 0);
      }

      // Sort by span ascending; tie-break by estimated VFE ascending (preserve relative order).
      arr.sort(function(a, b) {
        var sa = Math.abs(a.source.column - a.target.column);
        var sb = Math.abs(b.source.column - b.target.column);
        if (sa !== sb) return sa - sb;
        return vfeOf(a) - vfeOf(b);
      });

      var maxVfe = -Infinity;
      for (var si = 0; si < arr.length; si++) {
        var cl = arr[si];
        var curVfe = vfeOf(cl);
        var minGap = circularLinkGap + (cl.width || 0) / 2;
        var required = maxVfe + minGap;
        if (curVfe < required - 1e-12) {
          var delta = required - curVfe;
          cl.circularPathData.verticalBuffer = (cl.circularPathData.verticalBuffer || 0) + delta;
          curVfe = required;
        }
        var halfW = (cl.width || 0) / 2;
        if (curVfe + halfW > maxVfe + 1e-12) {
          maxVfe = curVfe + halfW;
        } else if (si === 0) {
          maxVfe = curVfe + halfW;
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
  var local = link.circularPathData;

  if (local.localPortBridgeRadius) {
    var radius=local.localPortBridgeRadius;
    return "M"+local.sourceX+" "+local.sourceY+
      " L"+local.rightInnerExtent+" "+local.sourceY+
      " A"+radius+" "+radius+" 0 0 1 "+local.rightFullExtent+" "+(local.sourceY+radius)+
      " L"+local.rightFullExtent+" "+(local.verticalFullExtent-radius)+
      " A"+radius+" "+radius+" 0 0 1 "+local.rightInnerExtent+" "+local.verticalFullExtent+
      " L"+local.leftInnerExtent+" "+local.verticalFullExtent+
      " A"+radius+" "+radius+" 0 0 0 "+local.leftFullExtent+" "+(local.verticalFullExtent+radius)+
      " L"+local.leftFullExtent+" "+(local.targetY-radius)+
      " A"+radius+" "+radius+" 0 0 0 "+local.leftInnerExtent+" "+local.targetY+
      " L"+local.targetX+" "+local.targetY;
  }

  if (local.sourcePortWrap) {
    var w=local.sourcePortWrap,r=w.departureRadius;
    var bottom=w.band==="bottom",sign=bottom?-1:1,sweep=bottom?1:0;
    return "M"+local.sourceX+" "+local.sourceY+
      " L"+(w.right-r)+" "+local.sourceY+
      " A"+r+" "+r+" 0 0 "+sweep+" "+w.right+" "+(local.sourceY-sign*r)+
      " L"+w.right+" "+(w.y+sign*w.rightRadius)+
      " A"+w.rightRadius+" "+w.rightRadius+" 0 0 "+sweep+" "+(w.right-w.rightRadius)+" "+w.y+
      " L"+(w.left+w.leftRadius)+" "+w.y+
      " A"+w.leftRadius+" "+w.leftRadius+" 0 0 "+(1-sweep)+" "+w.left+" "+(w.y-sign*w.leftRadius)+
      " L"+w.left+" "+(local.verticalFullExtent+sign*w.shelfRadius)+
      " A"+w.shelfRadius+" "+w.shelfRadius+" 0 0 "+sweep+" "+(w.left-w.shelfRadius)+" "+local.verticalFullExtent+
      " L"+(local.leftShelfInnerExtent||local.leftInnerExtent)+" "+local.verticalFullExtent+
      " A"+(local.leftShelfArcRadius||local.leftLargeArcRadius)+" "+(local.leftShelfVerticalRadius||local.leftLargeArcRadius)+
      " 0 0 "+sweep+" "+local.leftFullExtent+" "+local.verticalLeftInnerExtent+
      " L"+local.leftFullExtent+" "+(local.targetY-sign*local.leftSmallArcRadius)+
      " A"+local.leftSmallArcRadius+" "+local.leftSmallArcRadius+" 0 0 "+sweep+" "+local.leftInnerExtent+" "+local.targetY+
      " L"+local.targetX+" "+local.targetY;
  }

  if (link.circularLinkType == "top") {
    var c = link.circularPathData;
    var mirrored = c.mirroredSourceRadius;
    var sourceX = mirrored ? link.source.x0 : c.sourceX;
    var mirroredFull = c.mirroredSourceFullExtent;
    if (mirrored && typeof mirroredFull !== "number") mirroredFull = sourceX-c.rightNodeBuffer-mirrored;
    var sourceInner = mirrored ? mirroredFull+mirrored : (c.rightDepartureInnerExtent || c.rightInnerExtent);
    var sourceFull = mirrored ? mirroredFull : c.rightFullExtent;
    var sourceCorner = mirrored ? (c.mirroredSourceShelfRadius || mirrored) : c.rightLargeArcRadius;
    var sourceShelf = mirrored ? sourceFull-sourceCorner : (c.rightShelfInnerExtent || c.rightInnerExtent);
    pathString =
      // start at the left of the source node
      "M" +
      sourceX +
      " " +
      link.circularPathData.sourceY +
      " " +
      // line left to buffer point
      "L" +
      sourceInner +
      " " +
      link.circularPathData.sourceY +
      " " +
      // Arc around: Centre of arc X and  //Centre of arc Y
      "A" +
      (mirrored || c.rightSourceLargeArcRadius || c.rightLargeArcRadius) +
      " " +
      (mirrored || c.rightSmallArcRadius) +
      (mirrored ? " 0 0 1 " : " 0 0 0 ") +
      // End of arc X //End of arc Y
      sourceFull +
      " " +
      (link.circularPathData.sourceY -
        (mirrored || c.rightSmallArcRadius)) +
      " " + // End of arc X
      // line up to buffer point
      "L" +
      sourceFull +
      " " +
      (mirrored ? c.verticalFullExtent+sourceCorner : c.verticalRightInnerExtent) +
      " " +
      // Arc around: Centre of arc X and  //Centre of arc Y
      "A" +
      sourceCorner +
      " " +
      sourceCorner +
      " 0 0 0 " +
      // End of arc X //End of arc Y
      sourceShelf +
      " " +
      link.circularPathData.verticalFullExtent +
      " " + // End of arc X
      // line right to buffer point
      "L" +
      (link.circularPathData.leftShelfInnerExtent || link.circularPathData.leftInnerExtent) +
      " " +
      link.circularPathData.verticalFullExtent +
      " " +
      // Arc around: Centre of arc X and  //Centre of arc Y
      "A" +
      (link.circularPathData.leftShelfArcRadius || link.circularPathData.leftLargeArcRadius) +
      " " +
      (link.circularPathData.leftShelfVerticalRadius || link.circularPathData.leftLargeArcRadius) +
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
      (link.circularPathData.rightDepartureInnerExtent || link.circularPathData.rightInnerExtent) +
      " " +
      link.circularPathData.sourceY +
      " " +
      // Arc around: Centre of arc X and  //Centre of arc Y
      "A" +
      (link.circularPathData.rightSourceLargeArcRadius || link.circularPathData.rightLargeArcRadius) +
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
      (link.circularPathData.rightShelfInnerExtent || link.circularPathData.rightInnerExtent) +
      " " +
      link.circularPathData.verticalFullExtent +
      " " + // End of arc X
      // line right to buffer point
      "L" +
      (link.circularPathData.leftShelfInnerExtent || link.circularPathData.leftInnerExtent) +
      " " +
      link.circularPathData.verticalFullExtent +
      " " +
      // Arc around: Centre of arc X and  //Centre of arc Y
      "A" +
      (link.circularPathData.leftShelfArcRadius || link.circularPathData.leftLargeArcRadius) +
      " " +
      (link.circularPathData.leftShelfVerticalRadius || link.circularPathData.leftLargeArcRadius) +
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
