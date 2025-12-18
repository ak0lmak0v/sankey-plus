const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// UMD bundle expects a global `self` (browser). Provide it for Node.
globalThis.self = globalThis;
const { SankeyChart } = require(path.join("..", "dist", "sankeyPlus.js"));

// Parse the SAME fixture + config source as the debug page uses.
const debugHtml = fs.readFileSync(path.join(__dirname, "..", "test-debug.html"), "utf8");
const nodesMatch = debugHtml.match(/\b(?:let|const)\s+nodes\s*=\s*(\[[\s\S]*?\]);/);
const linksMatch = debugHtml.match(/\b(?:let|const)\s+links\s*=\s*(\[[\s\S]*?\]);/);
assert.ok(nodesMatch, "Failed to parse nodes from test-debug.html");
assert.ok(linksMatch, "Failed to parse links from test-debug.html");
// eslint-disable-next-line no-new-func
const nodesRaw = Function(`"use strict"; return (${nodesMatch[1]});`)();
// eslint-disable-next-line no-new-func
const linksRaw = Function(`"use strict"; return (${linksMatch[1]});`)();

function makeChart() {
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
      typeOrder: ["booking", "search_loop", "primary", "secondary"],
      typeAccessor: (d) => d.type,
      types: {},
    },
    arrows: { enabled: false },
  });

  chart.process();
  return chart;
}

test("cross-band: schedule ○→filter and filter→autosearch must not share the same left-leg X when their left-leg Y ranges overlap", () => {
  const chart = makeChart();
  const gap = 1;

  const a = chart.graph.links.find((l) => l.source?.name === "schedule ○" && l.target?.name === "filter");
  const b = chart.graph.links.find((l) => l.source?.name === "filter" && l.target?.name === "autosearch");
  assert.ok(a && b, "Missing expected links schedule ○→filter and/or filter→autosearch");
  assert.ok(a.circular && b.circular, "Expected both links to be circular");
  assert.equal(a.circularLinkType, "bottom");
  assert.equal(b.circularLinkType, "top");

  const ca = a.circularPathData;
  const cb = b.circularPathData;
  assert.ok(ca && cb, "Missing circularPathData");
  assert.ok(Number.isFinite(ca.leftFullExtent) && Number.isFinite(cb.leftFullExtent), "Missing leftFullExtent");

  // Ensure the test case is actually overlapping on the left leg in Y.
  function leftLegSeg(link) {
    const c = link.circularPathData;
    const ty = typeof link.y1 === "number" ? link.y1 : c.targetY;
    const vy = c.verticalLeftInnerExtent;
    return [Math.min(ty, vy), Math.max(ty, vy)];
  }
  const sa = leftLegSeg(a);
  const sb = leftLegSeg(b);
  const vOv = Math.max(0, Math.min(sa[1], sb[1]) - Math.max(sa[0], sb[0]));
  assert.ok(vOv > 1e-6, "Expected left-leg Y ranges to overlap for this regression case");

  // If their left legs overlap in Y, their left-leg vertical strokes must not merge.
  // Use edge-to-edge clearance on the stroke boundaries. (Widths are already accounted for
  // by using +/- w/2 edges; do NOT add widths again to the required gap.)

  const outer = ca.leftFullExtent <= cb.leftFullExtent ? a : b;
  const inner = outer === a ? b : a;
  const co = outer.circularPathData;
  const ci = inner.circularPathData;
  const wo = outer.width || 0;
  const wi = inner.width || 0;

  const outerRight = co.leftFullExtent + wo / 2;
  const innerLeft = ci.leftFullExtent - wi / 2;
  const actual = innerLeft - outerRight;

  assert.ok(
    actual >= gap - 1e-3,
    `Expected cross-band left-leg clearance >= circularGap: got ${actual.toFixed(6)} < ${gap}`
  );
});


