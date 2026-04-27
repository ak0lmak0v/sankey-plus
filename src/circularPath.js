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

          var pSrcY = pC.sourceY;
          var pVri = pC.verticalRightInnerExtent;
          var cSrcY = cC.sourceY;
          var cVri = cC.verticalRightInnerExtent;
          var pMin = Math.min(pSrcY, pVri);
          var pMax = Math.max(pSrcY, pVri);
          var cMin = Math.min(cSrcY, cVri);
          var cMax = Math.max(cSrcY, cVri);
          var vOverlap = Math.max(0, Math.min(pMax, cMax) - Math.max(pMin, cMin));
          if (vOverlap <= 1e-6) continue;

          var prevW = prev.width || 0;
          var currW = curr.width || 0;
          var prevRight = pC.rightFullExtent + prevW / 2;
          var currLeft = cC.rightFullExtent - currW / 2;
          var gap = currLeft - prevRight;
          var required = circularLinkGap || 0;

          if (gap < required) {
            var delta = required - gap + 1e-6;
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
    // Group by target column ONLY (not by circularLinkType). This ensures
    // TOP and BOTTOM links in the same column see each other as obstacles,
    // preventing cross-band overlaps that would otherwise need a separate pass.
    var targetKey =
      l.target && typeof l.target.column === "number"
        ? String(l.target.column)
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

    // Pre-populate placed list with self-loops in this target column
    // (immovable obstacles from the self-loop clearance pass).
    var placed = [];
    var firstTarget = group[0] && group[0].target;
    if (selfLoopsByTargetCol && firstTarget && typeof firstTarget.column === "number") {
      var colLoops = selfLoopsByTargetCol[String(firstTarget.column)];
      if (colLoops) {
        for (var sl = 0; sl < colLoops.length; sl++) {
          var loop = colLoops[sl];
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

      // Broad Y range for overlap checking (port to VFE).
      var tY = typeof link.y1 === "number" ? link.y1
        : (link.target && typeof link.target.y1 === "number" ? link.target.y1 : 0);
      var yMin = Math.min(tY, c.verticalFullExtent);
      var yMax = Math.max(tY, c.verticalFullExtent);

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
          typeof outer.y1 === "number"
            ? outer.y1
            : (outer.target && typeof outer.target.y1 === "number" ? outer.target.y1 : 0);
        var oV = outer.circularPathData.verticalLeftInnerExtent;
        var oMin = Math.min(oTargetY, oV);
        var oMax = Math.max(oTargetY, oV);

        var iTargetY =
          typeof inner.y1 === "number"
            ? inner.y1
            : (inner.target && typeof inner.target.y1 === "number" ? inner.target.y1 : 0);
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

        var tY = typeof link.y1 === "number" ? link.y1
          : (link.target && typeof link.target.y1 === "number" ? link.target.y1 : 0);
        var vfe = c.verticalFullExtent;
        var yMin = Math.min(tY, vfe);
        var yMax = Math.max(tY, vfe);

        var maxLfe = c.targetX - (c.leftNodeBuffer || 0) - baseRadius - hw;

        // Constrain by every other link in the bucket.
        // Same minimum Y overlap threshold as the greedy placement.
        var minYOv = 5;
        for (var j = 0; j < bucket.length; j++) {
          if (j === i) continue;
          var other = bucket[j];
          var oc = other.circularPathData;
          var oHW = (other.width || 0) / 2;

          var oTY = typeof other.y1 === "number" ? other.y1
            : (other.target && typeof other.target.y1 === "number" ? other.target.y1 : 0);
          var oVfe = oc.verticalFullExtent;
          var oYMin = Math.min(oTY, oVfe);
          var oYMax = Math.max(oTY, oVfe);
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
      var desiredVfe = node.y1 + Math.max(12, r + 4);
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
      var maxCompactIters = 10;
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

    // Phase 3C: Tighten local (span<=1) TOP links towards their nearest neighbor
    // in the same target-node bundle. Runs after compaction for final word.
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
            if (linkSpan(inner) > 1) continue;
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

            for (var pp2 = 0; pp2 < topAllNonSelf.length; pp2++) {
              var pAbove = topAllNonSelf[pp2];
              if (pAbove === inner) continue;
              if (pAbove.circularPathData.verticalFullExtent <= inner.circularPathData.verticalFullExtent) continue;
              if (!shelvesOverlapX(pAbove, inner)) continue;
              var floorFromAbove = pAbove.circularPathData.verticalFullExtent - ((pAbove.width || 0) + innerW) / 2 - gap;
              if (floorFromAbove > tightenTarget) tightenTarget = floorFromAbove;
            }

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
      var compactVfe = node.y1 + Math.max(12, r + 4);
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

  // Final pass: reorder TOP links' left-leg positions by target.y0 ASC.
  //
  // The greedy placement sorts by target.y0 DESC (correct for BOTTOM, inverted
  // for TOP). After ALL constraint passes are done, we swap LFE slots among
  // TOP links so that higher targets (smaller y0, shorter legs) are closer to
  // the node. Because this runs after all gap/crossing enforcement, the swap
  // is purely cosmetic and doesn't trigger cascading constraint violations.
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

      // Desired order: target.y0 ASC (higher target = closer to node), span ASC.
      var desired = links.slice().sort(function(a, b) {
        var ay = a.target && typeof a.target.y0 === "number" ? a.target.y0 : 0;
        var by = b.target && typeof b.target.y0 === "number" ? b.target.y0 : 0;
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

      var sorted = links.slice().sort(function(a, b) {
        return b.circularPathData.leftFullExtent - a.circularPathData.leftFullExtent;
      });

      for (var si = 1; si < sorted.length; si++) {
        var inner = sorted[si - 1];
        var outer = sorted[si];
        var iC = inner.circularPathData;
        var oC = outer.circularPathData;
        var iHW = (inner.width || 0) / 2;
        var oHW = (outer.width || 0) / 2;
        var idealLfe = iC.leftFullExtent - iHW - gap - oHW;
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

  // Final pass: enforce visual gap for left vertical legs of sub-pixel circular links.
  // Same anti-aliasing compensation as the VFE pass above, but for leftFullExtent (X axis).
  // Only push legs apart if they overlap in Y range (otherwise they don't visually conflict).
  (function enforceLeftLegVisualGap() {
    var gap = circularLinkGap || 0;
    if (gap <= 0) return;
    var circLinks = graph.links.filter(function(l) {
      return l && l.circular && !l.isVirtual && l.circularPathData &&
             typeof l.circularPathData.leftFullExtent === "number";
    });
    if (circLinks.length < 2) return;

    // Group by target column (left legs connect at the target)
    var byCol = {};
    circLinks.forEach(function(l) {
      var col = l.target && typeof l.target.column === "number" ? l.target.column : -1;
      if (!byCol[col]) byCol[col] = [];
      byCol[col].push(l);
    });

    Object.keys(byCol).forEach(function(col) {
      var group = byCol[col];
      if (group.length < 2) return;

      var maxIter = 20;
      for (var iter = 0; iter < maxIter; iter++) {
        // Sort by LFE ascending (further from node = more negative first)
        group.sort(function(a, b) {
          return a.circularPathData.leftFullExtent - b.circularPathData.leftFullExtent;
        });

        var changed = false;
        for (var i = 1; i < group.length; i++) {
          var outer = group[i - 1]; // further from node (smaller LFE)
          var inner = group[i];     // closer to node (larger LFE)
          var oc = outer.circularPathData;
          var ic = inner.circularPathData;

          // Check vertical overlap of left legs
          var oTargetY = typeof outer.y1 === "number" ? outer.y1 : (outer.target && typeof outer.target.y0 === "number" ? outer.target.y0 : 0);
          var oVLI = typeof oc.verticalLeftInnerExtent === "number" ? oc.verticalLeftInnerExtent : oc.verticalFullExtent;
          var oYMin = Math.min(oTargetY, oVLI);
          var oYMax = Math.max(oTargetY, oVLI);

          var iTargetY = typeof inner.y1 === "number" ? inner.y1 : (inner.target && typeof inner.target.y0 === "number" ? inner.target.y0 : 0);
          var iVLI = typeof ic.verticalLeftInnerExtent === "number" ? ic.verticalLeftInnerExtent : ic.verticalFullExtent;
          var iYMin = Math.min(iTargetY, iVLI);
          var iYMax = Math.max(iTargetY, iVLI);

          var yOverlap = Math.max(0, Math.min(oYMax, iYMax) - Math.max(oYMin, iYMin));
          if (yOverlap <= 1e-6) continue;

          var outerVisHW = Math.max(outer.width || 0, 1) / 2;
          var innerVisHW = Math.max(inner.width || 0, 1) / 2;
          var outerRightVisEdge = oc.leftFullExtent + outerVisHW;
          var innerLeftVisEdge = ic.leftFullExtent - innerVisHW;
          var visualGap = innerLeftVisEdge - outerRightVisEdge;

          if (visualGap < gap - 1e-6) {
            var deficit = gap - visualGap;
            // Push outer further left
            oc.leftLargeArcRadius += deficit;
            if (typeof oc.leftSmallArcRadius === "number") {
              oc.leftSmallArcRadius += deficit;
              if (oc.leftSmallArcRadius > oc.leftLargeArcRadius) {
                oc.leftSmallArcRadius = oc.leftLargeArcRadius;
              }
            }
            oc.leftFullExtent = oc.targetX - oc.leftLargeArcRadius - (oc.leftNodeBuffer || 0);
            if (outer.circularLinkType === "bottom") {
              oc.verticalLeftInnerExtent = oc.verticalFullExtent - oc.leftLargeArcRadius;
            } else {
              oc.verticalLeftInnerExtent = oc.verticalFullExtent + oc.leftLargeArcRadius;
            }
            changed = true;
          }
        }
        if (!changed) break;
      }
    });
  })();

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
