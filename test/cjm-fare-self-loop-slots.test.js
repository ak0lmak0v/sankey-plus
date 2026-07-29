const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// UMD bundle expects a browser-like global.
globalThis.self = globalThis;
const { SankeyChart } = require(path.join("..", "dist", "sankeyPlus.js"));

function parseCjmFareDesktopFixture(chartIndex = 3) {
  const html = fs.readFileSync(path.join(__dirname, "..", "CJM_fare.html"), "utf8");
  const nodesMatch = html.match(new RegExp(`\\blet\\s+nodes${chartIndex}\\s*=\\s*(\\[[\\s\\S]*?\\]);`));
  const linksMatch = html.match(new RegExp(`\\blet\\s+links${chartIndex}\\s*=\\s*(\\[[\\s\\S]*?\\]);`));
  assert.ok(nodesMatch, `Failed to parse nodes${chartIndex} from CJM_fare.html`);
  assert.ok(linksMatch, `Failed to parse links${chartIndex} from CJM_fare.html`);

  // eslint-disable-next-line no-new-func
  const nodes = Function(`"use strict"; return (${nodesMatch[1]});`)();
  // eslint-disable-next-line no-new-func
  const links = Function(`"use strict"; return (${linksMatch[1]});`)();
  return { nodes, links };
}

function makeChart(chartIndex = 3) {
  const { nodes, links } = parseCjmFareDesktopFixture(chartIndex);
  const chart = new SankeyChart({
    align: "left",
    id: (d) => d.name,
    iterations: 50,
    padding: 0,
    width: 1200,
    height: 700,
    scale: 0.2,
    nodes: {
      data: nodes.map((n) => ({ ...n })),
      width: 15,
      padding: 30,
      minPadding: 30,
      virtualPadding: 7,
      horizontalSort: true,
      verticalSort: true,
      setPositions: false,
      fill: () => "#ccc",
    },
    links: {
      data: links.map((l) => ({ ...l })),
      circularGap: 0.8,
      circularLinkPortionTopBottom: 0.01,
      circularLinkPortionLeftRight: 0.2,
      useVirtualRoutes: true,
      baseRadius: 7,
      verticalMargin: 70,
      horizontalMargin: 100,
      opacity: 0.5,
      virtualLinkType: "bezier",
      color: "lightgrey",
      sortIterations: 120,
      postSortIterations: 10,
      typeOrder: ["fare_action", "ticket", "click", "search_loop", "primary", "booking", "secondary", "filter"],
      typeAccessor: (d) => d.type,
      types: {},
    },
    arrows: { enabled: false },
  });
  chart.process();
  return chart;
}

test("CJM fare: ticket_open_without_baggage bottom self-loop keeps the innermost left-leg slot", () => {
  const chart = makeChart();
  const targetName = "ticket_open_without_baggage";

  const loop = chart.graph.links.find((l) => l.source?.name === targetName && l.target?.name === targetName);
  assert.ok(loop, `Missing ${targetName} self-loop`);
  assert.ok(loop.circular, "Expected self-loop to be circular");
  assert.equal(loop.circularLinkType, "bottom");
  assert.ok(loop.circularPathData, "Missing self-loop circularPathData");

  const incomingBottom = chart.graph.links.filter(
    (l) =>
      l !== loop &&
      l.circular &&
      l.circularLinkType === "bottom" &&
      l.target?.name === targetName &&
      l.circularPathData
  );
  assert.ok(incomingBottom.length > 0, "Expected incoming bottom backlinks to the self-loop target");

  const loopLfe = loop.circularPathData.leftFullExtent;
  const maxIncomingLfe = Math.max(...incomingBottom.map((l) => l.circularPathData.leftFullExtent));

  // Larger leftFullExtent is closer to the target node. The self-loop must remain
  // the innermost left leg; otherwise it gets pulled into the incoming backlink bundle
  // and the loop visually tears near the node.
  assert.ok(
    loopLfe >= maxIncomingLfe - 1e-6,
    `Expected self-loop left leg to stay innermost: loop=${loopLfe.toFixed(3)}, incoming max=${maxIncomingLfe.toFixed(3)}`
  );
});

test("CJM fare: non-self bottom backlinks to ticket targets keep separate left-leg bundles", () => {
  const chart = makeChart();
  const gap = chart.config.links.circularGap || 0;

  function nonSelfBottomTo(targetName) {
    return chart.graph.links.filter(
      (l) =>
        l.circular &&
        l.circularLinkType === "bottom" &&
        l.target?.name === targetName &&
        l.source?.name !== targetName &&
        l.circularPathData
    );
  }

  const without = nonSelfBottomTo("ticket_open_without_baggage");
  const withBag = nonSelfBottomTo("ticket_open_with_baggage");
  assert.ok(without.length > 0, "Expected non-self bottom backlinks to ticket_open_without_baggage");
  assert.ok(withBag.length > 0, "Expected non-self bottom backlinks to ticket_open_with_baggage");

  function rightEdge(link) {
    return link.circularPathData.leftFullExtent + Math.max(link.width || 0, 1) / 2;
  }
  function leftEdge(link) {
    return link.circularPathData.leftFullExtent - Math.max(link.width || 0, 1) / 2;
  }

  const withoutRight = Math.max(...without.map(rightEdge));
  const withLeft = Math.min(...withBag.map(leftEdge));

  assert.ok(
    withLeft - withoutRight >= gap - 1e-6,
    `Expected ticket target bundles to stay separate: gap=${(withLeft - withoutRight).toFixed(3)}, need ${gap}`
  );

  const fareScreen = withBag.find((l) => l.source?.name === "fare_screen_opened");
  const fareChange = withBag.find((l) => l.source?.name === "fare_change");
  const baggageToggle = withBag.find((l) => l.source?.name === "baggage_toggle_on");
  assert.ok(
    fareScreen && fareChange && baggageToggle,
    "Missing baggage_toggle_on/fare_screen_opened/fare_change backlinks to ticket_open_with_baggage"
  );
  assert.ok(
    baggageToggle.circularPathData.leftFullExtent > fareScreen.circularPathData.leftFullExtent,
    `Expected baggage_toggle_on left leg to be closer to node than fare_screen_opened: baggageToggle=${baggageToggle.circularPathData.leftFullExtent.toFixed(
      3
    )}, fareScreen=${fareScreen.circularPathData.leftFullExtent.toFixed(3)}`
  );
  assert.ok(
    fareScreen.circularPathData.leftFullExtent > fareChange.circularPathData.leftFullExtent,
    `Expected fare_screen_opened left leg to be closer to node than fare_change: fareScreen=${fareScreen.circularPathData.leftFullExtent.toFixed(
      3
    )}, fareChange=${fareChange.circularPathData.leftFullExtent.toFixed(3)}`
  );
});

test("CJM fare chart1: search self-loop keeps left-leg clearance from filter->search when segments overlap", () => {
  const chart = makeChart(1);
  const gap = chart.config.links.circularGap || 0;

  const loop = chart.graph.links.find((l) => l.source?.name === "search" && l.target?.name === "search");
  const other = chart.graph.links.find((l) => l.source?.name === "filter" && l.target?.name === "search");
  assert.ok(loop && other, "Missing expected links search->search and/or filter->search");
  assert.ok(loop.circular && other.circular, "Expected both links to be circular");
  assert.ok(loop.circularPathData && other.circularPathData, "Missing circularPathData");

  const loopYMin = Math.min(loop.circularPathData.targetY, loop.circularPathData.verticalLeftInnerExtent);
  const loopYMax = Math.max(loop.circularPathData.targetY, loop.circularPathData.verticalLeftInnerExtent);
  const otherYMin = Math.min(other.circularPathData.targetY, other.circularPathData.verticalLeftInnerExtent);
  const otherYMax = Math.max(other.circularPathData.targetY, other.circularPathData.verticalLeftInnerExtent);
  const yOverlap = Math.max(0, Math.min(loopYMax, otherYMax) - Math.max(loopYMin, otherYMin));
  assert.ok(yOverlap > 1e-6, "Expected left-leg Y overlap for this regression");

  const loopHW = Math.max(loop.width || 0, 1) / 2;
  const otherHW = Math.max(other.width || 0, 1) / 2;
  const xGap = (loop.circularPathData.leftFullExtent - loopHW) - (other.circularPathData.leftFullExtent + otherHW);
  assert.ok(
    xGap >= gap - 1e-6,
    `Expected search self-loop to clear filter->search by >=${gap}px, got ${xGap.toFixed(3)}`
  );
});

test("CJM fare chart1: top backlinks to search keep left-leg clearance between each other", () => {
  const chart = makeChart(1);
  const gap = chart.config.links.circularGap || 0;

  const topToSearch = chart.graph.links.filter(
    (l) =>
      l.circular &&
      l.circularLinkType === "top" &&
      l.target?.name === "search" &&
      l.source?.name !== "search" &&
      l.circularPathData
  );
  assert.ok(topToSearch.length >= 2, "Expected multiple top backlinks to search");

  const rows = topToSearch
    .map((l) => {
      const c = l.circularPathData;
      const hw = Math.max(l.width || 0, 1) / 2;
      return {
        name: `${l.source.name}->${l.target.name}`,
        leftEdge: c.leftFullExtent - hw,
        rightEdge: c.leftFullExtent + hw,
        yMin: Math.min(c.targetY, c.verticalLeftInnerExtent),
        yMax: Math.max(c.targetY, c.verticalLeftInnerExtent),
      };
    })
    .sort((a, b) => a.leftEdge - b.leftEdge);

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      const yOverlap = Math.max(0, Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin));
      if (yOverlap <= 1e-6) continue;
      const xGap = b.leftEdge - a.rightEdge;
      assert.ok(
        xGap >= gap - 1e-6,
        `Expected top backlinks left-leg clearance >=${gap}px for ${a.name} vs ${b.name}; got ${xGap.toFixed(3)}`
      );
    }
  }
});
