const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// UMD bundle expects a global `self` (browser). Provide it for Node.
globalThis.self = globalThis;
const { SankeyChart } = require(path.join("..", "dist", "sankeyPlus.js"));

function makeDesktopChart() {
  const html = fs.readFileSync(path.join(__dirname, "..", "test-debug-desktop.html"), "utf8");
  const nodesMatch = html.match(/\b(?:let|const)\s+nodes\s*=\s*(\[[\s\S]*?\]);/);
  const linksMatch = html.match(/\b(?:let|const)\s+links\s*=\s*(\[[\s\S]*?\]);/);
  assert.ok(nodesMatch, "Failed to parse nodes from test-debug-desktop.html");
  assert.ok(linksMatch, "Failed to parse links from test-debug-desktop.html");
  // eslint-disable-next-line no-new-func
  const nodes = Function(`"use strict"; return (${nodesMatch[1]});`)();
  // eslint-disable-next-line no-new-func
  const links = Function(`"use strict"; return (${linksMatch[1]});`)();

  const chart = new SankeyChart({
    align: "left",
    id: (d) => d.name,
    iterations: 10,
    scale: 0.3,
    padding: 25,
    width: 1200,
    height: 700,
    nodes: {
      data: nodes.map((n) => ({ ...n })),
      width: 15,
      padding: 25,
      minPadding: 30,
      virtualPadding: 7,
      horizontalSort: true,
      verticalSort: true,
      setPositions: false,
      fill: () => "#ccc",
    },
    links: {
      data: links.map((l) => ({ ...l })),
      circularGap: 1,
      circularLinkPortionTopBottom: 0.4,
      circularLinkPortionLeftRight: 0.1,
      useVirtualRoutes: true,
      baseRadius: 5,
      verticalMargin: 20,
      horizontalMargin: 100,
      opacity: 0.7,
      virtualLinkType: "bezier",
      color: "lightgrey",
      sortIterations: 12,
      postSortIterations: 4,
      typeOrder: ["booking", "search_loop", "primary", "secondary", "search_nearby", "schedule"],
      typeAccessor: (d) => d.type,
      types: {},
    },
    arrows: { enabled: false },
  });
  chart.process();
  return chart;
}

test("desktop: listing ●→search ○ should not be noticeably more right-shifted than sosisa ◐→search ○ (right radii)", () => {
  const chart = makeDesktopChart();
  const a = chart.graph.links.find((l) => l.source?.name === "listing ●" && l.target?.name === "search ○");
  const b = chart.graph.links.find((l) => l.source?.name === "sosisa ◐" && l.target?.name === "search ○");
  assert.ok(a && b, "Missing expected desktop links");
  assert.ok(a.circular && b.circular, "Expected both links to be circular");
  assert.equal(a.circularLinkType, "top");
  assert.equal(b.circularLinkType, "top");
  assert.equal(a.type, "search_nearby");
  assert.equal(b.type, "search_nearby");

  const ar = a.circularPathData?.rightLargeArcRadius;
  const br = b.circularPathData?.rightLargeArcRadius;
  assert.ok(Number.isFinite(ar) && Number.isFinite(br), "Missing rightLargeArcRadius");

  // We just want to prevent the "big jump" regression; allow moderate differences.
  // (Exact ordering can vary a bit with other links, but it shouldn't balloon.)
  const delta = Math.abs(ar - br);
  assert.ok(delta <= 10, `Expected right radii delta<=10, got ${delta.toFixed(3)}`);
});

test("desktop: bottom circular shelves should not horizontally overlap (listing ○→search ● vs filter backlinks)", () => {
  const chart = makeDesktopChart();
  const gap = 1; // matches links.circularGap in makeDesktopChart()

  const listingToSearchLoop = chart.graph.links.find(
    (l) => l.source?.name === "listing ○" && l.target?.name === "search ●"
  );
  const scheduleToFilter = chart.graph.links.find(
    (l) => l.source?.name === "schedule ○" && l.target?.name === "filter"
  );
  const filterOffToFilter = chart.graph.links.find(
    (l) => l.source?.name === "filter off" && l.target?.name === "filter"
  );

  assert.ok(listingToSearchLoop && scheduleToFilter && filterOffToFilter, "Missing expected desktop links");
  assert.ok(listingToSearchLoop.circular && scheduleToFilter.circular && filterOffToFilter.circular, "Expected links to be circular");
  assert.equal(listingToSearchLoop.circularLinkType, "bottom");
  assert.equal(scheduleToFilter.circularLinkType, "bottom");
  assert.equal(filterOffToFilter.circularLinkType, "bottom");

  function shelf(link) {
    const c = link.circularPathData;
    assert.ok(c, "Missing circularPathData");
    const x1 = Math.min(c.leftInnerExtent, c.rightInnerExtent);
    const x2 = Math.max(c.leftInnerExtent, c.rightInnerExtent);
    return { vfe: c.verticalFullExtent, x1, x2, w: link.width };
  }
  function xOverlap(a, b) {
    return Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  }

  const a = shelf(listingToSearchLoop);
  const b = shelf(scheduleToFilter);
  const c = shelf(filterOffToFilter);

  function assertNoShelfOverlay(nameA, sa, nameB, sb) {
    const ox = xOverlap(sa, sb);
    if (ox <= 1e-6) return; // no horizontal overlap => OK
    const dy = Math.abs(sa.vfe - sb.vfe);
    const minDy = (sa.w + sb.w) / 2 + gap - 1e-3; // small epsilon
    assert.ok(
      dy >= minDy,
      `Expected no horizontal shelf overlap between ${nameA} and ${nameB}: xOverlap=${ox.toFixed(
        2
      )}, dy=${dy.toFixed(3)} < minDy=${minDy.toFixed(3)}`
    );
  }

  assertNoShelfOverlay("listing ○→search ●", a, "schedule ○→filter", b);
  assertNoShelfOverlay("listing ○→search ●", a, "filter off→filter", c);
});

test("desktop: filter backlinks should not overlap each other on the same bottom shelf (schedule ○→filter vs filter off→filter)", () => {
  const chart = makeDesktopChart();
  const gap = 1;

  const aLink = chart.graph.links.find((l) => l.source?.name === "schedule ○" && l.target?.name === "filter");
  const bLink = chart.graph.links.find((l) => l.source?.name === "filter off" && l.target?.name === "filter");
  assert.ok(aLink && bLink, "Missing expected desktop filter backlinks");
  assert.ok(aLink.circular && bLink.circular, "Expected both links to be circular");
  assert.equal(aLink.circularLinkType, "bottom");
  assert.equal(bLink.circularLinkType, "bottom");

  function shelf(link) {
    const c = link.circularPathData;
    assert.ok(c, "Missing circularPathData");
    const x1 = Math.min(c.leftInnerExtent, c.rightInnerExtent);
    const x2 = Math.max(c.leftInnerExtent, c.rightInnerExtent);
    return { vfe: c.verticalFullExtent, x1, x2, w: link.width };
  }
  function xOverlap(a, b) {
    return Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  }

  const a = shelf(aLink);
  const b = shelf(bLink);
  const ox = xOverlap(a, b);
  assert.ok(ox > 1e-6, "Expected the two filter backlinks to have horizontal overlap in X");

  const dy = Math.abs(a.vfe - b.vfe);
  const minDy = (a.w + b.w) / 2 + gap - 1e-3;
  assert.ok(
    dy >= minDy,
    `Expected schedule ○→filter and filter off→filter to be vertically separated: xOverlap=${ox.toFixed(
      2
    )}, dy=${dy.toFixed(3)} < minDy=${minDy.toFixed(3)}`
  );
});

test("desktop: search ◐→search ○ stays compact (no huge sideways push)", () => {
  const chart = makeDesktopChart();
  const baseRadius = 5; // matches links.baseRadius
  const maxExtra = 6; // allow some bundling slack on the right side

  const link = chart.graph.links.find((l) => l.source?.name === "search ◐" && l.target?.name === "search ○");
  assert.ok(link, "Missing search ◐→search ○");
  assert.ok(link.circular, "Expected link to be circular");

  const c = link.circularPathData;
  assert.ok(c, "Missing circularPathData");

  const expected = baseRadius + link.width / 2;
  assert.ok(
    c.rightLargeArcRadius <= expected + maxExtra,
    `Expected search ◐→search ○ right radius to stay compact: got ${c.rightLargeArcRadius.toFixed(
      3
    )}, expected <= ${(expected + maxExtra).toFixed(3)}`
  );

  // Left side can legitimately expand to clear the target-node self-loop (search ○→search ○)
  // when their left-leg segments overlap. Bound it to "just enough for loop clearance".
  const loop = chart.graph.links.find((l) => l.source?.name === "search ○" && l.target?.name === "search ○");
  if (loop && loop.circular) {
    const lc = loop.circularPathData;
    const segA = [Math.min(c.targetY, c.verticalLeftInnerExtent), Math.max(c.targetY, c.verticalLeftInnerExtent)];
    const segB = [
      Math.min(lc.targetY, lc.verticalLeftInnerExtent),
      Math.max(lc.targetY, lc.verticalLeftInnerExtent),
    ];
    const ov = Math.max(0, Math.min(segA[1], segB[1]) - Math.max(segA[0], segB[0]));
    if (ov > 1e-6) {
      const maxLeft = expected + loop.width + 1; // loop width + circularGap
      assert.ok(
        c.leftLargeArcRadius <= maxLeft + 1e-3,
        `Expected search ◐→search ○ left radius to be only as large as needed to clear loop: got ${c.leftLargeArcRadius.toFixed(
          3
        )}, expected <= ${maxLeft.toFixed(3)}`
      );
    }
  }
});

test("desktop: search ◐→search ○ should sit close to search ○→search ○ (no extra slack beyond circularGap)", () => {
  const chart = makeDesktopChart();
  const gap = chart.config.links.circularGap || 0;

  const loop = chart.graph.links.find((l) => l.source?.name === "search ○" && l.target?.name === "search ○");
  const in1 = chart.graph.links.find((l) => l.source?.name === "search ◐" && l.target?.name === "search ○");
  assert.ok(loop && in1, "Missing expected desktop links (search self-loop / search ◐→search ○)");
  assert.ok(loop.circular && in1.circular, "Expected both links to be circular");
  assert.equal(loop.circularLinkType, "bottom");
  assert.equal(in1.circularLinkType, "bottom");
  assert.ok(loop.circularPathData && in1.circularPathData, "Missing circularPathData");

  const loopBottomEdge = loop.circularPathData.verticalFullExtent + (loop.width || 0) / 2;
  const in1TopEdge = in1.circularPathData.verticalFullExtent - (in1.width || 0) / 2;
  const gapNow = in1TopEdge - loopBottomEdge;

  // Must keep at least circularGap, but should not leave a large extra "hole".
  assert.ok(gapNow >= gap - 1e-6, `Expected gap>=${gap.toFixed(3)}; got ${gapNow.toFixed(3)}`);
  assert.ok(
    gapNow <= gap + 0.25,
    `Expected gap<=${(gap + 0.25).toFixed(3)}; got ${gapNow.toFixed(3)}`
  );
});

test("desktop: filter→listing ○ should not overlap filter→saved_filters_search ● on the right leg", () => {
  const chart = makeDesktopChart();
  const gap = 1;

  const a = chart.graph.links.find((l) => l.source?.name === "filter" && l.target?.name === "listing ○");
  const b = chart.graph.links.find(
    (l) => l.source?.name === "filter" && l.target?.name === "saved_filters_search ●"
  );
  assert.ok(a && b, "Missing expected links");
  assert.ok(a.circular && b.circular, "Expected both links to be circular");
  assert.equal(a.circularLinkType, "top");
  assert.equal(b.circularLinkType, "top");

  // Right-leg Y overlap (use actual port y0), consistent with the right-leg clearance pass.
  function rightLegYRange(link) {
    const c = link.circularPathData;
    assert.ok(c, "Missing circularPathData");
    if (link.circularLinkType === "top") return [c.verticalFullExtent, link.y0];
    return [link.y0, c.verticalFullExtent];
  }
  function yOverlap(a, b) {
    const [a0, a1] = rightLegYRange(a);
    const [b0, b1] = rightLegYRange(b);
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  const ov = yOverlap(a, b);
  assert.ok(ov > 1e-6, "Expected vertical overlap on the right leg for this regression");

  const inner = a.circularPathData.rightFullExtent <= b.circularPathData.rightFullExtent ? a : b;
  const outer = inner === a ? b : a;
  const xGap =
    (outer.circularPathData.rightFullExtent - outer.width / 2) -
    (inner.circularPathData.rightFullExtent + inner.width / 2);
  assert.ok(
    xGap >= gap - 1e-5,
    `Expected right-leg clearance >=${gap}px, got ${xGap.toFixed(3)}px`
  );
});

test("desktop: filter→listing ○ should stay inside filter→saved_filters_search ● on right leg (ordering)", () => {
  const chart = makeDesktopChart();

  const a = chart.graph.links.find((l) => l.source?.name === "filter" && l.target?.name === "listing ○");
  const b = chart.graph.links.find(
    (l) => l.source?.name === "filter" && l.target?.name === "saved_filters_search ●"
  );
  assert.ok(a && b, "Missing expected links");
  assert.ok(a.circular && b.circular, "Expected both links to be circular");
  assert.equal(a.circularLinkType, "top");
  assert.equal(b.circularLinkType, "top");

  // filter→listing ○ is span=0 (same column). filter→saved_filters_search ● is span=1.
  // Span=0 should remain more inner on the right leg.
  assert.ok(
    a.circularPathData.rightFullExtent <= b.circularPathData.rightFullExtent - 1e-6,
    `Expected filter→listing ○ to be inside filter→saved_filters_search ● on right leg: rfeA=${a.circularPathData.rightFullExtent.toFixed(
      3
    )} > rfeB=${b.circularPathData.rightFullExtent.toFixed(3)}`
  );
});

test("desktop: right-leg ordering (column 4): filter→listing ○ then listing ○→search ● then listing ○→saved_filters_search ●; other top backlinks after", () => {
  const chart = makeDesktopChart();
  const eps = 1e-3;

  const filterToListing = chart.graph.links.find((l) => l.source?.name === "filter" && l.target?.name === "listing ○");
  const listingSaved = chart.graph.links.find(
    (l) => l.source?.name === "listing ○" && l.target?.name === "saved_filters_search ●"
  );
  const listingSearch = chart.graph.links.find(
    (l) => l.source?.name === "listing ○" && l.target?.name === "search ●"
  );
  const filterToSearch = chart.graph.links.find((l) => l.source?.name === "filter" && l.target?.name === "search ◐");
  const filterToSaved = chart.graph.links.find(
    (l) => l.source?.name === "filter" && l.target?.name === "saved_filters_search ●"
  );

  assert.ok(filterToListing && listingSaved && listingSearch && filterToSearch && filterToSaved, "Missing expected links");
  assert.ok(
    filterToListing.circular &&
      listingSaved.circular &&
      listingSearch.circular &&
      filterToSearch.circular &&
      filterToSaved.circular,
    "Expected circular links"
  );

  const filterListingRfe = filterToListing.circularPathData.rightFullExtent;
  const savedRfe = listingSaved.circularPathData.rightFullExtent;
  const searchRfe = listingSearch.circularPathData.rightFullExtent;
  const filterSearchRfe = filterToSearch.circularPathData.rightFullExtent;
  const filterSavedRfe = filterToSaved.circularPathData.rightFullExtent;

  assert.ok(
    filterListingRfe <= searchRfe - eps,
    `Expected filter→listing ○ to be before listing ○→search ● (filterListing=${filterListingRfe.toFixed(
      3
    )}, search=${searchRfe.toFixed(3)})`
  );
  assert.ok(
    searchRfe <= savedRfe - eps,
    `Expected listing ○→search ● to be before listing ○→saved_filters_search ● (search=${searchRfe.toFixed(
      3
    )}, saved=${savedRfe.toFixed(3)})`
  );
  assert.ok(
    savedRfe <= filterSearchRfe - eps,
    `Expected listing ○→saved_filters_search ● to be before filter→search ◐ (saved=${savedRfe.toFixed(
      3
    )}, filterSearch=${filterSearchRfe.toFixed(3)})`
  );
  assert.ok(
    savedRfe <= filterSavedRfe - eps,
    `Expected listing ○→saved_filters_search ● to be before filter→saved_filters_search ● (saved=${savedRfe.toFixed(
      3
    )}, filterSaved=${filterSavedRfe.toFixed(3)})`
  );
});

test("desktop: search ○ self-loop should not overlap incoming bottom link on left leg (search ◐→search ○)", () => {
  const chart = makeDesktopChart();
  const gap = 1;

  const other = chart.graph.links.find((l) => l.source?.name === "search ◐" && l.target?.name === "search ○");
  const loop = chart.graph.links.find((l) => l.source?.name === "search ○" && l.target?.name === "search ○");
  assert.ok(other && loop, "Missing expected links");
  assert.ok(other.circular && loop.circular, "Expected both links to be circular");
  assert.equal(other.circularLinkType, "bottom");
  assert.equal(loop.circularLinkType, "bottom");

  function leftLegSeg(link) {
    const c = link.circularPathData;
    assert.ok(c, "Missing circularPathData");
    return [Math.min(c.targetY, c.verticalLeftInnerExtent), Math.max(c.targetY, c.verticalLeftInnerExtent)];
  }
  function yOverlap(a, b) {
    const [a0, a1] = leftLegSeg(a);
    const [b0, b1] = leftLegSeg(b);
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  const ov = yOverlap(other, loop);
  assert.ok(ov > 1e-6, "Expected vertical overlap on the left leg for this regression");

  // other must be left of (outside) the loop by >= circularGap.
  const xGap =
    (loop.circularPathData.leftFullExtent - loop.width / 2) -
    (other.circularPathData.leftFullExtent + other.width / 2);
  assert.ok(
    xGap >= gap - 1e-5,
    `Expected left-leg clearance >=${gap}px, got ${xGap.toFixed(3)}px`
  );
});

test("desktop: filter self-loop should not overlap incoming bottom link on left leg (filter off→filter)", () => {
  const chart = makeDesktopChart();
  const gap = 1;

  const other = chart.graph.links.find((l) => l.source?.name === "filter off" && l.target?.name === "filter");
  const loop = chart.graph.links.find((l) => l.source?.name === "filter" && l.target?.name === "filter");
  assert.ok(other && loop, "Missing expected links");
  assert.ok(other.circular && loop.circular, "Expected both links to be circular");
  assert.equal(other.circularLinkType, "bottom");
  assert.equal(loop.circularLinkType, "bottom");

  function leftLegSeg(link) {
    const c = link.circularPathData;
    assert.ok(c, "Missing circularPathData");
    return [Math.min(c.targetY, c.verticalLeftInnerExtent), Math.max(c.targetY, c.verticalLeftInnerExtent)];
  }
  function yOverlap(a, b) {
    const [a0, a1] = leftLegSeg(a);
    const [b0, b1] = leftLegSeg(b);
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  const ov = yOverlap(other, loop);
  assert.ok(ov > 1e-6, "Expected vertical overlap on the left leg for this regression");

  const xGap =
    (loop.circularPathData.leftFullExtent - loop.width / 2) -
    (other.circularPathData.leftFullExtent + other.width / 2);
  assert.ok(
    xGap >= gap - 1e-5,
    `Expected left-leg clearance >=${gap}px, got ${xGap.toFixed(3)}px`
  );
});

test("desktop: listing ○ self-loop should not overlap filter→listing ○ on right leg (same source column cross-band)", () => {
  const chart = makeDesktopChart();
  const gap = 1;

  const other = chart.graph.links.find((l) => l.source?.name === "filter" && l.target?.name === "listing ○");
  const loop = chart.graph.links.find((l) => l.source?.name === "listing ○" && l.target?.name === "listing ○");
  assert.ok(other && loop, "Missing expected links");
  assert.ok(other.circular && loop.circular, "Expected both links to be circular");

  function rightLegSeg(link) {
    const c = link.circularPathData;
    assert.ok(c, "Missing circularPathData");
    return [
      Math.min(c.sourceY, c.verticalRightInnerExtent),
      Math.max(c.sourceY, c.verticalRightInnerExtent),
    ];
  }
  function yOverlap(a, b) {
    const [a0, a1] = rightLegSeg(a);
    const [b0, b1] = rightLegSeg(b);
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  const ov = yOverlap(other, loop);
  assert.ok(ov > 1e-6, "Expected right-leg vertical overlap for this regression");

  // Ensure OTHER is to the right of LOOP by >= circularGap.
  const xGap =
    (other.circularPathData.rightFullExtent - other.width / 2) -
    (loop.circularPathData.rightFullExtent + loop.width / 2);
  assert.ok(
    xGap >= gap - 1e-5,
    `Expected right-leg clearance >=${gap}px, got ${xGap.toFixed(3)}px`
  );
});

test("desktop: sosisa ◐ self-loop should not overlap listing ●→schedule ○ on right leg (same source column cross-band)", () => {
  const chart = makeDesktopChart();
  const gap = 1;

  const other = chart.graph.links.find((l) => l.source?.name === "listing ●" && l.target?.name === "schedule ○");
  const loop = chart.graph.links.find((l) => l.source?.name === "sosisa ◐" && l.target?.name === "sosisa ◐");
  assert.ok(other && loop, "Missing expected links");
  assert.ok(other.circular && loop.circular, "Expected both links to be circular");

  function rightLegSeg(link) {
    const c = link.circularPathData;
    assert.ok(c, "Missing circularPathData");
    return [
      Math.min(c.sourceY, c.verticalRightInnerExtent),
      Math.max(c.sourceY, c.verticalRightInnerExtent),
    ];
  }
  function yOverlap(a, b) {
    const [a0, a1] = rightLegSeg(a);
    const [b0, b1] = rightLegSeg(b);
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  const ov = yOverlap(other, loop);
  assert.ok(ov > 1e-6, "Expected right-leg vertical overlap for this regression");

  const xGap =
    (other.circularPathData.rightFullExtent - other.width / 2) -
    (loop.circularPathData.rightFullExtent + loop.width / 2);
  assert.ok(
    xGap >= gap - 1e-5,
    `Expected right-leg clearance >=${gap}px, got ${xGap.toFixed(3)}px`
  );
});

test("desktop: listing ○ self-loop should not overlap listing ○→filter on left leg (same target column cross-node)", () => {
  const chart = makeDesktopChart();
  const gap = 1;
  const slack = 0.25;

  const other = chart.graph.links.find((l) => l.source?.name === "listing ○" && l.target?.name === "filter");
  const loop = chart.graph.links.find((l) => l.source?.name === "listing ○" && l.target?.name === "listing ○");
  assert.ok(other && loop, "Missing expected links");
  assert.ok(other.circular && loop.circular, "Expected both links to be circular");

  function leftLegSeg(link) {
    const c = link.circularPathData;
    assert.ok(c, "Missing circularPathData");
    return [
      Math.min(c.targetY, c.verticalLeftInnerExtent),
      Math.max(c.targetY, c.verticalLeftInnerExtent),
    ];
  }
  function yOverlap(a, b) {
    const [a0, a1] = leftLegSeg(a);
    const [b0, b1] = leftLegSeg(b);
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  const ov = yOverlap(other, loop);
  assert.ok(ov > 1e-6, "Expected left-leg vertical overlap for this regression");

  // Ensure OTHER is to the left of LOOP by >= circularGap.
  const xGap =
    (loop.circularPathData.leftFullExtent - loop.width / 2) -
    (other.circularPathData.leftFullExtent + other.width / 2);
  assert.ok(
    xGap >= gap - 1e-5,
    `Expected left-leg clearance >=${gap}px, got ${xGap.toFixed(3)}px`
  );
  // Regression: we want the gap to be approximately circularGap (not circularGap + stroke widths).
  assert.ok(
    xGap <= gap + slack,
    `Expected left-leg clearance not to over-shoot by much (<=${(gap + slack).toFixed(2)}px), got ${xGap.toFixed(3)}px`
  );
});

test("desktop: same-column cycle filter↔listing ○ should not have excessive top vertical separation", () => {
  const chart = makeDesktopChart();
  const gap = 1;

  const a = chart.graph.links.find((l) => l.source?.name === "filter" && l.target?.name === "listing ○");
  const b = chart.graph.links.find((l) => l.source?.name === "listing ○" && l.target?.name === "filter");
  assert.ok(a && b, "Missing expected cycle links");
  assert.ok(a.circular && b.circular, "Expected both links to be circular");
  assert.equal(a.circularLinkType, "top");
  assert.equal(b.circularLinkType, "top");

  const dy = Math.abs(a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent);
  const minDy = (a.width + b.width) / 2 + gap;
  // Allow some slack for interactions with nearby bundles, but prevent the huge hole regression.
  assert.ok(
    dy <= minDy + 6,
    `Expected filter→listing ○ and listing ○→filter to be reasonably close: dy=${dy.toFixed(
      3
    )}px, minDy=${minDy.toFixed(3)}px`
  );
});


