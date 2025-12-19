const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("node:fs");

// UMD bundle expects a global `self` (browser). Provide it for Node.
globalThis.self = globalThis;
const { SankeyChart } = require(path.join("..", "dist", "sankeyPlus.js"));

function parseFixture() {
  const html = fs.readFileSync(path.join(__dirname, "..", "test-debug.html"), "utf8");
  const nodesMatch = html.match(/\b(?:let|const)\s+nodes\s*=\s*(\[[\s\S]*?\]);/);
  const linksMatch = html.match(/\b(?:let|const)\s+links\s*=\s*(\[[\s\S]*?\]);/);
  assert.ok(nodesMatch, "Failed to parse nodes from test-debug.html");
  assert.ok(linksMatch, "Failed to parse links from test-debug.html");
  // eslint-disable-next-line no-new-func
  const nodes = Function(`"use strict"; return (${nodesMatch[1]});`)();
  // eslint-disable-next-line no-new-func
  const links = Function(`"use strict"; return (${linksMatch[1]});`)();
  return { nodes, links };
}

test("regression (bottom/search): schedule ○→search ● must not overlap schedule ●→search ● on the bottom shelf", () => {
  const { nodes, links } = parseFixture();
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

  const gap = chart.config.links.circularGap || 0;
  const a = chart.graph.links.find((l) => l.source?.name === "schedule ○" && l.target?.name === "search ●");
  const b = chart.graph.links.find((l) => l.source?.name === "schedule ●" && l.target?.name === "search ●");
  assert.ok(a && b, "Missing expected links (schedule ○/● → search ●)");
  assert.ok(a.circular && b.circular, "Expected both links to be circular");
  assert.equal(a.circularLinkType, "bottom");
  assert.equal(b.circularLinkType, "bottom");
  assert.ok(a.circularPathData && b.circularPathData, "Missing circularPathData");

  // Only enforce separation when their bottom shelves overlap in X (inner extents).
  function shelfX(link) {
    const c = link.circularPathData;
    const x1 = Math.min(c.leftInnerExtent, c.rightInnerExtent);
    const x2 = Math.max(c.leftInnerExtent, c.rightInnerExtent);
    return { x1, x2 };
  }
  const sa = shelfX(a);
  const sb = shelfX(b);
  const xOverlap = Math.max(0, Math.min(sa.x2, sb.x2) - Math.max(sa.x1, sb.x1));
  assert.ok(xOverlap > 1e-6, "Expected schedule ○→search ● and schedule ●→search ● to overlap in X on the shelf");

  // Enforce edge-to-edge vertical gap between the shallower (smaller VFE) and deeper (larger VFE).
  const inner = a.circularPathData.verticalFullExtent < b.circularPathData.verticalFullExtent ? a : b;
  const outer = inner === a ? b : a;
  const innerBottom = inner.circularPathData.verticalFullExtent + (inner.width || 0) / 2;
  const outerTop = outer.circularPathData.verticalFullExtent - (outer.width || 0) / 2;
  const edgeGap = outerTop - innerBottom;

  assert.ok(
    edgeGap >= gap - 1e-6,
    `Expected bottom shelf gap>=${gap.toFixed(3)}; got ${edgeGap.toFixed(3)} (xOverlap=${xOverlap.toFixed(2)})`
  );
});

function assertBottomShelfNoOverlap(chart, aSrc, aTgt, bSrc, bTgt) {
  const gap = chart.config.links.circularGap || 0;
  const a = chart.graph.links.find((l) => l.source?.name === aSrc && l.target?.name === aTgt);
  const b = chart.graph.links.find((l) => l.source?.name === bSrc && l.target?.name === bTgt);
  assert.ok(a && b, `Missing expected links (${aSrc}→${aTgt} / ${bSrc}→${bTgt})`);
  assert.ok(a.circular && b.circular, `Expected both links to be circular (${aSrc}→${aTgt} / ${bSrc}→${bTgt})`);
  assert.equal(a.circularLinkType, "bottom");
  assert.equal(b.circularLinkType, "bottom");
  assert.ok(a.circularPathData && b.circularPathData, "Missing circularPathData");

  function shelfX(link) {
    const c = link.circularPathData;
    const x1 = Math.min(c.leftInnerExtent, c.rightInnerExtent);
    const x2 = Math.max(c.leftInnerExtent, c.rightInnerExtent);
    return { x1, x2 };
  }
  const sa = shelfX(a);
  const sb = shelfX(b);
  const xOverlap = Math.max(0, Math.min(sa.x2, sb.x2) - Math.max(sa.x1, sb.x1));
  assert.ok(xOverlap > 1e-6, `Expected shelf X-overlap for ${aSrc}→${aTgt} vs ${bSrc}→${bTgt}`);

  const inner = a.circularPathData.verticalFullExtent < b.circularPathData.verticalFullExtent ? a : b;
  const outer = inner === a ? b : a;
  const innerBottom = inner.circularPathData.verticalFullExtent + (inner.width || 0) / 2;
  const outerTop = outer.circularPathData.verticalFullExtent - (outer.width || 0) / 2;
  const edgeGap = outerTop - innerBottom;
  assert.ok(
    edgeGap >= gap - 1e-6,
    `Expected bottom shelf gap>=${gap.toFixed(3)}; got ${edgeGap.toFixed(3)} (${aSrc}→${aTgt} vs ${bSrc}→${bTgt}, xOverlap=${xOverlap.toFixed(
      2
    )})`
  );
}

test("regression (bottom): schedule ○→search ◐ must not overlap schedule ◐→search ● on the bottom shelf", () => {
  const { nodes, links } = parseFixture();
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

  assertBottomShelfNoOverlap(chart, "schedule ○", "search ◐", "schedule ◐", "search ●");
});

test("regression (bottom): schedule ○→listing ○ must not overlap schedule ○→filter on the bottom shelf", () => {
  const { nodes, links } = parseFixture();
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

  assertBottomShelfNoOverlap(chart, "schedule ○", "listing ○", "schedule ○", "filter");
});


