const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("node:fs");

// UMD bundle expects a global `self` (browser). Provide it for Node.
globalThis.self = globalThis;

const { SankeyChart } = require(path.join("..", "dist", "sankeyPlus.js"));

function parseFixture() {
  const debugHtml = fs.readFileSync(path.join(__dirname, "..", "test-debug.html"), "utf8");
  const nodesMatch = debugHtml.match(/\b(?:let|const)\s+nodes\s*=\s*(\[[\s\S]*?\]);/);
  const linksMatch = debugHtml.match(/\b(?:let|const)\s+links\s*=\s*(\[[\s\S]*?\]);/);
  assert.ok(nodesMatch, "Failed to parse nodes from test-debug.html");
  assert.ok(linksMatch, "Failed to parse links from test-debug.html");
  // eslint-disable-next-line no-new-func
  const nodesRaw = Function(`"use strict"; return (${nodesMatch[1]});`)();
  // eslint-disable-next-line no-new-func
  const linksRaw = Function(`"use strict"; return (${linksMatch[1]});`)();
  return { nodesRaw, linksRaw };
}

function makeChart() {
  const { nodesRaw, linksRaw } = parseFixture();
  const nodesData = nodesRaw.map((n) => ({ ...n }));
  const nodeNames = new Set(nodesData.map((n) => n.name));
  // Keep tests resilient: drop links to nodes outside the fixture subset.
  const linksData = linksRaw
    .filter((l) => nodeNames.has(l.source) && nodeNames.has(l.target))
    .map((l) => ({ ...l }));

  const chart = new SankeyChart({
    align: "left",
    id: (d) => d.name,
    iterations: 10,
    padding: 25,
    width: 1400,
    height: 900,
    nodes: {
      data: nodesData,
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
      data: linksData,
      circularGap: 1,
      costBasedCircularRouting: false,
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
      typeOrder: ["booking", "search_loop", "primary", "secondary", "search_nearby"],
      typeAccessor: (d) => d.type,
      types: {},
    },
    arrows: { enabled: false },
  });

  chart.process();
  return chart;
}

function targetCY(link) {
  const t = link?.target;
  if (!t || typeof t.y0 !== "number" || typeof t.y1 !== "number") return NaN;
  return (t.y0 + t.y1) / 2;
}

test("backlink ordering by target vertical position is consistent for ports and right radii (top + bottom)", () => {
  const chart = makeChart();

  const find = (sourceName, targetName) =>
    chart.graph.links.find((l) => l.source?.name === sourceName && l.target?.name === targetName && l.circular);

  // TOP backlinks: source is right of target column; circularLinkType = top
  // Requirement: for top backlinks, when span ties:
  // - higher target (smaller targetCY) should take a HIGHER port => smaller y0
  // - and be MORE inner on the right side => smaller rightLargeArcRadius
  const topToHalf = find("sosisa ●", "schedule ◐");
  const topToFull = find("sosisa ●", "schedule ●");
  assert.ok(topToHalf && topToFull, "Missing expected top backlinks from sosisa ● to schedule ◐/●");
  assert.equal(topToHalf.circularLinkType, "top");
  assert.equal(topToFull.circularLinkType, "top");

  const cyHalf = targetCY(topToHalf);
  const cyFull = targetCY(topToFull);
  assert.ok(Number.isFinite(cyHalf) && Number.isFinite(cyFull), "Expected finite targetCY for top backlinks");
  // schedule ● is lower than schedule ◐ in the fixture
  assert.ok(cyFull > cyHalf, "Expected schedule ● to be lower than schedule ◐ (targetCY)");

  assert.ok(
    topToHalf.y0 < topToFull.y0,
    `TOP backlink ports: expected schedule ◐ (higher target) port to be higher (smaller y0). got y0(◐)=${topToHalf.y0}, y0(●)=${topToFull.y0}`
  );

  const rlarTopHalf = topToHalf.circularPathData?.rightLargeArcRadius;
  const rlarTopFull = topToFull.circularPathData?.rightLargeArcRadius;
  assert.ok(Number.isFinite(rlarTopHalf) && Number.isFinite(rlarTopFull), "Expected rightLargeArcRadius for top backlinks");
  assert.ok(
    rlarTopHalf < rlarTopFull,
    `TOP backlink radii: expected schedule ◐ (higher target) to be more inner on right leg (smaller rlar). got rlar(◐)=${rlarTopHalf}, rlar(●)=${rlarTopFull}`
  );

  // BOTTOM backlinks: source is right of target column; circularLinkType = bottom
  // Requirement: for bottom backlinks, when span ties:
  // - lower target should take a LOWER port => larger y0
  // - and should NOT be more outer on the right side than its higher-target sibling
  const bottomToHalf = find("sosisa ◐", "schedule ◐");
  const bottomToFull = find("sosisa ◐", "schedule ●");
  assert.ok(bottomToHalf && bottomToFull, "Missing expected bottom backlinks from sosisa ◐ to schedule ◐/●");
  assert.equal(bottomToHalf.circularLinkType, "bottom");
  assert.equal(bottomToFull.circularLinkType, "bottom");

  const cyHalfB = targetCY(bottomToHalf);
  const cyFullB = targetCY(bottomToFull);
  assert.ok(Number.isFinite(cyHalfB) && Number.isFinite(cyFullB), "Expected finite targetCY for bottom backlinks");
  assert.ok(cyFullB > cyHalfB, "Expected schedule ● to be lower than schedule ◐ (targetCY) for bottom pair");

  assert.ok(
    bottomToFull.y0 > bottomToHalf.y0,
    `BOTTOM backlink ports: expected schedule ● port to be lower (larger y0). got y0(full)=${bottomToFull.y0}, y0(half)=${bottomToHalf.y0}`
  );

  const rlarBottomHalf = bottomToHalf.circularPathData?.rightLargeArcRadius;
  const rlarBottomFull = bottomToFull.circularPathData?.rightLargeArcRadius;
  assert.ok(
    Number.isFinite(rlarBottomHalf) && Number.isFinite(rlarBottomFull),
    "Expected rightLargeArcRadius for bottom backlinks"
  );
  assert.ok(
    rlarBottomFull < rlarBottomHalf,
    `BOTTOM backlink radii: expected schedule ● (lower target) NOT to be more outer than schedule ◐. got rlar(●)=${rlarBottomFull}, rlar(◐)=${rlarBottomHalf}`
  );
});

test("sortSourceLinks: TOP vs BOTTOM backlinks produce inverse port ordering for equal span (y0)", () => {
  const chart = makeChart();

  const isBacklink = (l) => (l?.target?.column ?? 0) < (l?.source?.column ?? 0);
  const span = (l) => Math.abs((l?.target?.column ?? 0) - (l?.source?.column ?? 0));

  // --- TOP: sosisa ● -> schedule ◐ / schedule ● (both are top circular backlinks, span ties)
  const topHalf = chart.graph.links.find(
    (l) =>
      l.circular &&
      l.circularLinkType === "top" &&
      isBacklink(l) &&
      l.source?.name === "sosisa ●" &&
      l.target?.name === "schedule ◐"
  );
  const topFull = chart.graph.links.find(
    (l) =>
      l.circular &&
      l.circularLinkType === "top" &&
      isBacklink(l) &&
      l.source?.name === "sosisa ●" &&
      l.target?.name === "schedule ●"
  );
  assert.ok(topHalf && topFull, "Missing expected TOP backlinks sosisa ●→schedule ◐/●");
  assert.equal(
    span(topHalf),
    span(topFull),
    `Expected TOP pair to have equal span for tie-case: span(◐)=${span(topHalf)} span(●)=${span(topFull)}`
  );

  const cyTopHalf = targetCY(topHalf);
  const cyTopFull = targetCY(topFull);
  assert.ok(Number.isFinite(cyTopHalf) && Number.isFinite(cyTopFull));
  assert.ok(cyTopFull > cyTopHalf, "Expected schedule ● lower than schedule ◐ for TOP test");

  // TOP band assigns y0 from node.y0 upward, so earlier == smaller y0.
  // For TOP backlinks we want: higher target => higher port => smaller y0.
  assert.ok(
    topHalf.y0 < topFull.y0,
    `TOP backlinks ordering failed: expected y0(schedule ◐) < y0(schedule ●). got ${topHalf.y0} vs ${topFull.y0}`
  );

  // --- BOTTOM: sosisa ◐ -> schedule ◐ / schedule ● (both are bottom circular backlinks, span ties)
  const bottomHalf = chart.graph.links.find(
    (l) =>
      l.circular &&
      l.circularLinkType === "bottom" &&
      isBacklink(l) &&
      l.source?.name === "sosisa ◐" &&
      l.target?.name === "schedule ◐"
  );
  const bottomFull = chart.graph.links.find(
    (l) =>
      l.circular &&
      l.circularLinkType === "bottom" &&
      isBacklink(l) &&
      l.source?.name === "sosisa ◐" &&
      l.target?.name === "schedule ●"
  );
  assert.ok(bottomHalf && bottomFull, "Missing expected BOTTOM backlinks sosisa ◐→schedule ◐/●");
  assert.equal(
    span(bottomHalf),
    span(bottomFull),
    `Expected BOTTOM pair to have equal span for tie-case: span(◐)=${span(bottomHalf)} span(●)=${span(bottomFull)}`
  );

  const cyBottomHalf = targetCY(bottomHalf);
  const cyBottomFull = targetCY(bottomFull);
  assert.ok(Number.isFinite(cyBottomHalf) && Number.isFinite(cyBottomFull));
  assert.ok(cyBottomFull > cyBottomHalf, "Expected schedule ● lower than schedule ◐ for BOTTOM test");

  // BOTTOM band assigns y0 from node.y1 downward, so earlier == larger y0.
  // For BOTTOM backlinks we want: lower target => lower port => larger y0.
  assert.ok(
    bottomFull.y0 > bottomHalf.y0,
    `BOTTOM backlinks inverse ordering failed: expected y0(schedule ●) > y0(schedule ◐). got ${bottomFull.y0} vs ${bottomHalf.y0}`
  );
});

test("sortSourceLinks: for TOP backlinks to same target column, higher target gets higher port (saved_filters_search ● vs search ●)", () => {
  const chart = makeChart();
  const isBacklink = (l) => (l?.target?.column ?? 0) < (l?.source?.column ?? 0);
  const span = (l) => Math.abs((l?.target?.column ?? 0) - (l?.source?.column ?? 0));

  const toSaved = chart.graph.links.find(
    (l) =>
      l.circular &&
      l.circularLinkType === "top" &&
      isBacklink(l) &&
      l.source?.name === "sosisa ●" &&
      l.target?.name === "saved_filters_search ●"
  );
  const toSearch = chart.graph.links.find(
    (l) =>
      l.circular &&
      l.circularLinkType === "top" &&
      isBacklink(l) &&
      l.source?.name === "sosisa ●" &&
      l.target?.name === "search ●"
  );
  assert.ok(toSaved && toSearch, "Missing expected top backlinks sosisa ●→saved_filters_search ● / search ●");
  assert.equal(span(toSaved), span(toSearch), "Expected equal span tie-case for saved vs search");

  const cySaved = targetCY(toSaved);
  const cySearch = targetCY(toSearch);
  assert.ok(Number.isFinite(cySaved) && Number.isFinite(cySearch));

  // saved_filters_search ● is higher than search ● in the fixture
  assert.ok(cySaved < cySearch, "Expected saved_filters_search ● higher than search ● (targetCY)");
  assert.ok(
    toSaved.y0 < toSearch.y0,
    `Expected TOP port to saved_filters_search ● to be higher (smaller y0) than port to search ●: y0(saved)=${toSaved.y0}, y0(search)=${toSearch.y0}`
  );
});

test("bottom backlinks depth: for sosisa ◐ to schedule ◐/● (same span), schedule ● should be LESS deep (smaller verticalFullExtent)", () => {
  const chart = makeChart();

  const half = chart.graph.links.find(
    (l) =>
      l.circular &&
      l.circularLinkType === "bottom" &&
      l.source?.name === "sosisa ◐" &&
      l.target?.name === "schedule ◐"
  );
  const full = chart.graph.links.find(
    (l) =>
      l.circular &&
      l.circularLinkType === "bottom" &&
      l.source?.name === "sosisa ◐" &&
      l.target?.name === "schedule ●"
  );
  assert.ok(half && full, "Missing bottom backlinks sosisa ◐→schedule ◐/●");

  const vfeHalf = half.circularPathData?.verticalFullExtent;
  const vfeFull = full.circularPathData?.verticalFullExtent;
  assert.ok(Number.isFinite(vfeHalf) && Number.isFinite(vfeFull), "Expected verticalFullExtent for both links");

  // Bottom links: larger verticalFullExtent => deeper.
  // Requirement: reverse depth (schedule ● less deep than schedule ◐).
  assert.ok(
    vfeFull < vfeHalf,
    `Expected schedule ● to be less deep than schedule ◐: vfe(●)=${vfeFull}, vfe(◐)=${vfeHalf}`
  );
});


