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
  return chart;
}

test("right leg min length: autosearch→search ● bottom link must have verticalRightInnerExtent >= sourceY + rightSmallArcRadius", () => {
  const chart = makeChart();

  const l = chart.graph.links.find(
    (x) => x.circular && !x.isVirtual && x.source?.name === "autosearch" && x.target?.name === "search ●"
  );
  assert.ok(l, "Missing link autosearch → search ●");
  assert.equal(l.circularLinkType, "bottom", "Expected autosearch→search ● to be bottom in this fixture");
  const c = l.circularPathData;
  assert.ok(c, "Missing circularPathData");

  assert.ok(typeof c.sourceY === "number", "Missing sourceY");
  assert.ok(typeof c.rightSmallArcRadius === "number", "Missing rightSmallArcRadius");
  assert.ok(typeof c.verticalRightInnerExtent === "number", "Missing verticalRightInnerExtent");

  const minVRI = c.sourceY + c.rightSmallArcRadius;
  assert.ok(
    c.verticalRightInnerExtent >= minVRI - 1e-6,
    `Expected verticalRightInnerExtent>=sourceY+rightSmallArcRadius (${c.verticalRightInnerExtent.toFixed(
      3
    )} >= ${minVRI.toFixed(3)})`
  );
});


