const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

globalThis.self = globalThis;
const { SankeyChart } = require(path.join("..", "dist", "sankeyPlus.js"));

function parseFixture() {
  const html = fs.readFileSync(path.join(__dirname, "..", "cjm-v0.html"), "utf8");
  const nodesMatch = html.match(/\blet\s+nodes\s*=\s*(\[[\s\S]*?\]);/);
  const linksMatch = html.match(/\blet\s+links\s*=\s*(\[[\s\S]*?\]);/);
  assert.ok(nodesMatch, "Failed to parse nodes from cjm-v0.html");
  assert.ok(linksMatch, "Failed to parse links from cjm-v0.html");

  return {
    nodes: Function(`"use strict"; return (${nodesMatch[1]});`)(),
    links: Function(`"use strict"; return (${linksMatch[1]});`)(),
  };
}

function makeChart() {
  const { nodes, links } = parseFixture();
  const chart = new SankeyChart({
    align: "left",
    id: (d) => d.name,
    iterations: 10,
    padding: 25,
    width: 1200,
    height: 700,
    scale: 0.3,
    nodes: {
      data: nodes.map((node) => ({ ...node })),
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
      data: links.map((link) => ({ ...link })),
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
      typeOrder: ["booking", "primary", "secondary"],
      typeAccessor: (d) => d.type,
      types: {},
    },
    arrows: { enabled: false },
  });
  chart.process();
  return chart;
}

test("cjm-v0: local top backlink stays concentric around its target self-loop", () => {
  const chart = makeChart();
  const backlink = chart.graph.links.find(
    (link) =>
      link.source?.name === "calendar_open-direction" &&
      link.target?.name === "direction--screen--opened"
  );
  const selfLoop = chart.graph.links.find(
    (link) =>
      link.source?.name === "direction--screen--opened" &&
      link.target?.name === "direction--screen--opened"
  );

  assert.ok(backlink?.circularPathData, "Missing local backlink geometry");
  assert.ok(selfLoop?.circularPathData, "Missing target self-loop geometry");
  assert.equal(backlink.circularLinkType, "top");

  const c = backlink.circularPathData;
  assert.ok(
    Math.abs(c.leftLargeArcRadius - c.leftSmallArcRadius) <= 1e-6,
    `Expected a round target corner, got radii ${c.leftLargeArcRadius.toFixed(3)} and ${c.leftSmallArcRadius.toFixed(3)}`
  );
  assert.ok(
    c.targetY - c.leftSmallArcRadius >= c.verticalLeftInnerExtent - 1e-6,
    "Expected the target-side vertical segment not to reverse"
  );
});
