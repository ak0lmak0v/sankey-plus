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

test("bottom local nesting: listing ○→search ● should wrap around autosearch→search ● (outer shelf below inner)", () => {
  const { nodesRaw, linksRaw } = parseFixture();
  const chart = new SankeyChart({
    align: "left",
    id: (d) => d.name,
    iterations: 10,
    scale: 0.3,
    padding: 25,
    width: 1200,
    height: 700,
    nodes: {
      data: nodesRaw.map((n) => ({ ...n })),
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
      data: linksRaw.map((l) => ({ ...l })),
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
      typeOrder: ["booking", "search_loop", "primary", "secondary", "search_nearby"],
      typeAccessor: (d) => d.type,
      types: {},
    },
    arrows: { enabled: false },
  });
  chart.process();

  const gap = chart.config.links.circularGap || 0;

  const A = chart.graph.links.find((l) => l.source?.name === "autosearch" && l.target?.name === "search ●");
  const B = chart.graph.links.find((l) => l.source?.name === "listing ○" && l.target?.name === "search ●");
  assert.ok(A && B, "Missing expected links");
  assert.ok(A.circular && B.circular, "Expected both links to be circular");
  assert.equal(A.circularLinkType, "bottom");
  assert.equal(B.circularLinkType, "bottom");

  const cA = A.circularPathData;
  const cB = B.circularPathData;
  assert.ok(cA && cB, "Missing circularPathData");

  // B should be the outer link (larger right radius) and thus should sit BELOW A on the bottom shelf.
  assert.ok(
    cB.rightLargeArcRadius >= cA.rightLargeArcRadius - 1e-6,
    "Expected listing ○→search ● to be at least as outer as autosearch→search ● by rightLargeArcRadius"
  );

  const aBottomEdge = cA.verticalFullExtent + (A.width || 0) / 2;
  const bTopEdge = cB.verticalFullExtent - (B.width || 0) / 2;
  const actualGap = bTopEdge - aBottomEdge;

  assert.ok(
    actualGap >= gap - 1e-6,
    `Expected listing ○→search ● to wrap below autosearch→search ● with gap>=${gap.toFixed(
      3
    )}; got ${actualGap.toFixed(3)}`
  );
});

test("bottom local bundle: listing ○→search ● and autosearch→search ● should sit close above schedule ○→search ● (no extra slack beyond circularGap)", () => {
  const { nodesRaw, linksRaw } = parseFixture();
  const chart = new SankeyChart({
    align: "left",
    id: (d) => d.name,
    iterations: 10,
    scale: 0.3,
    padding: 25,
    width: 1200,
    height: 700,
    nodes: {
      data: nodesRaw.map((n) => ({ ...n })),
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
      data: linksRaw.map((l) => ({ ...l })),
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
      typeOrder: ["booking", "search_loop", "primary", "secondary", "search_nearby"],
      typeAccessor: (d) => d.type,
      types: {},
    },
    arrows: { enabled: false },
  });
  chart.process();

  const gap = chart.config.links.circularGap || 0;

  const schedule = chart.graph.links.find((l) => l.source?.name === "schedule ○" && l.target?.name === "search ●");
  const listing = chart.graph.links.find((l) => l.source?.name === "listing ○" && l.target?.name === "search ●");
  const auto = chart.graph.links.find((l) => l.source?.name === "autosearch" && l.target?.name === "search ●");

  assert.ok(schedule && listing && auto, "Missing expected links (schedule/listing/autosearch → search ●)");
  assert.ok(schedule.circular && listing.circular && auto.circular, "Expected all 3 links to be circular");
  assert.equal(schedule.circularLinkType, "bottom");
  assert.equal(listing.circularLinkType, "bottom");
  assert.equal(auto.circularLinkType, "bottom");

  const cS = schedule.circularPathData;
  const cL = listing.circularPathData;
  const cA = auto.circularPathData;
  assert.ok(cS && cL && cA, "Missing circularPathData");

  // Ensure listing is the outer-most local link in the bottom local bundle.
  assert.ok(
    cL.rightLargeArcRadius >= cA.rightLargeArcRadius - 1e-6,
    "Expected listing ○→search ● to be at least as outer as autosearch→search ● by rightLargeArcRadius"
  );

  // `schedule ○→search ●` is a deeper (span>1) bottom link into the SAME target node.
  // We want the local bottom bundle to sit as close as possible above it:
  //   scheduleTopEdge - listingBottomEdge ≈ circularGap
  const scheduleTopEdge = cS.verticalFullExtent - (schedule.width || 0) / 2;
  const listingBottomEdge = cL.verticalFullExtent + (listing.width || 0) / 2;
  const gapToSchedule = scheduleTopEdge - listingBottomEdge;

  assert.ok(
    gapToSchedule >= gap - 1e-6,
    `Expected listing ○→search ● to stay above schedule ○→search ● with gap>=${gap.toFixed(
      3
    )}; got ${gapToSchedule.toFixed(3)}`
  );
  assert.ok(
    gapToSchedule <= gap + 0.25,
    `Expected listing ○→search ● to sit close above schedule ○→search ● (<=${(gap + 0.25).toFixed(
      3
    )}); got ${gapToSchedule.toFixed(3)}`
  );
});


