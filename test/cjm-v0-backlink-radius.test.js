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

const blueNodes = new Set([
  "date_click-depart-new",
  "date_click-depart-repeated",
  "calendar--depart_input--clicked",
  "search-ow",
  "calendar_open-search_ow",
  "search-ow-same",
  "search-ow-return",
]);
const purpleNodes = new Set([
  "calendar--return_input--clicked",
  "date_click-return-new",
  "search-rt",
  "calendar_open-search_rt",
  "search-rt-same",
]);
const purpleLinkTargets = new Set([
  "calendar--return_input--clicked",
  "date_click-return-new",
]);
const linkKey = (source, target) => `${source}\u0000${target}`;
const pinkLinks = new Set([
  ["direction--screen--opened", "date_click-depart-new"],
  ["direction--screen--opened", "calendar--screen--closed"],
  ["direction--screen--opened", "calendar_open-search_ow"],
  ["direction--screen--opened", "calendar_open-search_rt"],
  ["direction--screen--opened", "date_click-depart-repeated"],
  ["direction--screen--opened", "search-ow"],
  ["direction--screen--opened", "search-rt"],
  ["direction--screen--opened", "search-ow-same"],
  ["direction--screen--opened", "search-rt-same"],
  ["date_click-depart-new", "search-ow"],
  ["search-ow", "calendar--depart_input--clicked"],
  ["search-ow", "date_click-depart-repeated"],
  ["search-ow", "date_click-return-new"],
  ["search-ow", "calendar--screen--closed"],
  ["search-ow", "date_click-depart-new"],
  ["search-ow", "calendar_open-direction"],
  ["search-ow-same", "date_click-depart-repeated"],
  ["search-ow-same", "date_click-return-new"],
  ["search-ow-same", "date_click-depart-new"],
  ["search-ow-same", "calendar--screen--closed"],
  ["search-ow-return", "date_click-depart-new"],
  ["search-rt", "date_click-depart-new"],
  ["search-rt-same", "date_click-depart-new"],
  ["search-rt-same", "date_click-depart-repeated"],
  ["calendar--select_dates--clicked", "direction--screen--opened"],
  ["calendar--screen--closed", "search-ow"],
  ["calendar--select_dates--clicked", "results-filter"],
  ["calendar--select_dates--clicked", "path_end"],
].map(([source, target]) => linkKey(source, target)));

function linkType(link) {
  const sourceName = typeof link.source === "string" ? link.source : link.source?.name;
  const targetName = typeof link.target === "string" ? link.target : link.target?.name;
  if (pinkLinks.has(linkKey(sourceName, targetName))) return "pink";
  if (purpleLinkTargets.has(targetName)) return "cyan";
  if (blueNodes.has(sourceName)) return "green";
  if (purpleNodes.has(sourceName) || purpleNodes.has(targetName)) return "cyan";
  if (blueNodes.has(targetName)) return "green";
  return link.type;
}

function makeChart() {
  const { nodes, links } = parseFixture();
  const chart = new SankeyChart({
    align: "left",
    id: (d) => d.name,
    iterations: 10,
    padding: 25,
    width: 1450,
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
      typeAccessor: linkType,
      types: {
        primary: { name: "primary", color: "#d6cfcb" },
        secondary: { name: "secondary", color: "#C5C7BC" },
        booking: { name: "booking", color: "#148B4B" },
        green: { name: "green", color: "#81b29a" },
        cyan: { name: "cyan", color: "#007ea7" },
        pink: { name: "pink", color: "#f9bec7" },
      },
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

test("cjm-v0: long top backlink clears the search-ow self-loop without crossing the local top link", () => {
  const chart = makeChart();
  const longBacklink = chart.graph.links.find(
    (link) =>
      link.source?.name === "search-ow-same" &&
      link.target?.name === "date_click-depart-repeated"
  );
  const selfLoop = chart.graph.links.find(
    (link) =>
      link.source?.name === "search-ow" &&
      link.target?.name === "search-ow"
  );
  const localBacklink = chart.graph.links.find(
    (link) =>
      link.source?.name === "search-ow" &&
      link.target?.name === "calendar--screen--closed"
  );

  assert.ok(longBacklink?.circularPathData, "Missing long backlink geometry");
  assert.ok(selfLoop?.circularPathData, "Missing search-ow self-loop geometry");
  assert.ok(localBacklink?.circularPathData, "Missing local backlink geometry");
  assert.equal(longBacklink.circularLinkType, "top");
  assert.equal(selfLoop.circularLinkType, "top");
  assert.equal(localBacklink.circularLinkType, "top");

  const gap = chart.config.links.circularGap || 0;
  const longC = longBacklink.circularPathData;
  const loopC = selfLoop.circularPathData;
  const localC = localBacklink.circularPathData;
  const longBottomEdge = longC.verticalFullExtent + longBacklink.width / 2;
  const loopTopEdge = loopC.verticalFullExtent - selfLoop.width / 2;
  const localTopEdge = localC.verticalFullExtent - localBacklink.width / 2;

  assert.ok(
    loopTopEdge - longBottomEdge >= gap - 1e-6,
    `Expected long backlink to clear search-ow self-loop: gap=${(loopTopEdge - longBottomEdge).toFixed(3)}, need ${gap}`
  );
  assert.ok(
    localTopEdge - longBottomEdge >= gap - 1e-6,
    `Expected long backlink above the local top link: gap=${(localTopEdge - longBottomEdge).toFixed(3)}, need ${gap}`
  );
});

test("cjm-v0: self-loop clearance preserves the date_click-depart-repeated target bundle", () => {
  const chart = makeChart();
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) => link.source?.name === source && link.target?.name === target
    );
  const first = findLink("search-ow-same", "date_click-depart-repeated");
  const second = findLink("search-rt-same", "date_click-depart-repeated");
  const intruder = findLink("results-filter", "date_click-depart-new");

  assert.ok(first?.circularPathData, "Missing search-ow-same backlink geometry");
  assert.ok(second?.circularPathData, "Missing search-rt-same backlink geometry");
  assert.ok(intruder?.circularPathData, "Missing results-filter backlink geometry");

  const firstVfe = first.circularPathData.verticalFullExtent;
  const secondVfe = second.circularPathData.verticalFullExtent;
  const intruderVfe = intruder.circularPathData.verticalFullExtent;
  const bundleMin = Math.min(firstVfe, secondVfe);
  const bundleMax = Math.max(firstVfe, secondVfe);

  assert.ok(
    intruderVfe <= bundleMin + 1e-6 || intruderVfe >= bundleMax - 1e-6,
    `Expected the target bundle to stay contiguous, but intruder VFE ${intruderVfe.toFixed(3)} lies between ${bundleMin.toFixed(3)} and ${bundleMax.toFixed(3)}`
  );
});

test("cjm-v0: same-target top backlinks follow their source-side nesting order", () => {
  const chart = makeChart();
  const findLink = (source) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === "date_click-depart-repeated"
    );
  const owSame = findLink("search-ow-same");
  const rtSame = findLink("search-rt-same");

  assert.ok(owSame?.circularPathData, "Missing search-ow-same backlink geometry");
  assert.ok(rtSame?.circularPathData, "Missing search-rt-same backlink geometry");
  assert.equal(owSame.circularLinkType, "top");
  assert.equal(rtSame.circularLinkType, "top");

  const owC = owSame.circularPathData;
  const rtC = rtSame.circularPathData;
  assert.ok(
    rtC.rightFullExtent > owC.rightFullExtent,
    "Expected search-rt-same to use the outer source-side slot"
  );

  const gap = chart.config.links.circularGap || 0;
  const rtBottom = rtC.verticalFullExtent + rtSame.width / 2;
  const owTop = owC.verticalFullExtent - owSame.width / 2;
  assert.ok(
    owTop - rtBottom >= gap - 1e-6,
    `Expected search-rt-same above search-ow-same without crossing: gap=${(owTop - rtBottom).toFixed(3)}, need ${gap}; rtVfe=${rtC.verticalFullExtent.toFixed(3)}, owVfe=${owC.verticalFullExtent.toFixed(3)}`
  );
});

test("cjm-v0: packed date_click-depart-repeated bundle stays separate from unrelated top shelves", () => {
  const chart = makeChart();
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) => link.source?.name === source && link.target?.name === target
    );
  const bundleLink = findLink(
    "search-ow-same",
    "date_click-depart-repeated"
  );
  const unrelated = findLink(
    "results-filter",
    "direction--screen--opened"
  );

  assert.ok(bundleLink?.circularPathData, "Missing packed bundle geometry");
  assert.ok(unrelated?.circularPathData, "Missing unrelated top shelf geometry");
  assert.equal(bundleLink.circularLinkType, "top");
  assert.equal(unrelated.circularLinkType, "top");

  const bundleC = bundleLink.circularPathData;
  const unrelatedC = unrelated.circularPathData;
  const overlapX =
    Math.min(bundleC.rightInnerExtent, unrelatedC.rightInnerExtent) -
    Math.max(bundleC.leftInnerExtent, unrelatedC.leftInnerExtent);
  assert.ok(overlapX > 0, "Expected the two horizontal shelves to overlap in X");

  const gap = chart.config.links.circularGap || 0;
  const bundleTop =
    bundleC.verticalFullExtent - bundleLink.width / 2;
  const unrelatedBottom =
    unrelatedC.verticalFullExtent + unrelated.width / 2;
  assert.ok(
    bundleTop - unrelatedBottom >= gap - 1e-6,
    `Expected unrelated shelf above packed bundle: gap=${(bundleTop - unrelatedBottom).toFixed(3)}, need ${gap}`
  );
});

test("cjm-v0: top backlinks above search-ow follow target-column group order", () => {
  const chart = makeChart();
  const orderedEdges = [
    ["search-ow", "search-ow"],
    ["results-filter", "search-ow"],
    ["search-ow", "calendar--screen--closed"],
    ["search-ow-same", "date_click-depart-repeated"],
    ["search-rt-same", "date_click-depart-repeated"],
    ["results-filter", "date_click-depart-new"],
    ["results-filter", "direction--screen--opened"],
  ];
  const orderedLinks = orderedEdges.map(([source, target]) => {
    const link = chart.graph.links.find(
      (candidate) =>
        candidate.source?.name === source &&
        candidate.target?.name === target
    );
    assert.ok(link?.circularPathData, `Missing ${source} -> ${target}`);
    assert.equal(link.circularLinkType, "top");
    return link;
  });

  const gap = chart.config.links.circularGap || 0;
  for (let index = 1; index < orderedLinks.length; index += 1) {
    const inner = orderedLinks[index - 1];
    const outer = orderedLinks[index];
    const innerTop =
      inner.circularPathData.verticalFullExtent - inner.width / 2;
    const outerBottom =
      outer.circularPathData.verticalFullExtent + outer.width / 2;
    assert.ok(
      innerTop - outerBottom >= gap - 1e-6,
      `Expected ${orderedEdges[index].join(" -> ")} above ${orderedEdges[index - 1].join(" -> ")}: gap=${(innerTop - outerBottom).toFixed(3)}, need ${gap}`
    );
  }
});

test("cjm-v0: local top backlink stays concentric around its source self-loop", () => {
  const chart = makeChart();
  const backlink = chart.graph.links.find(
    (link) =>
      link.source?.name === "search-ow" &&
      link.target?.name === "calendar--screen--closed"
  );
  const selfLoop = chart.graph.links.find(
    (link) =>
      link.source?.name === "search-ow" &&
      link.target?.name === "search-ow"
  );

  assert.ok(backlink?.circularPathData, "Missing local backlink geometry");
  assert.ok(selfLoop?.circularPathData, "Missing source self-loop geometry");
  assert.equal(backlink.circularLinkType, "top");

  const c = backlink.circularPathData;
  assert.ok(
    Math.abs(c.rightLargeArcRadius - c.rightSmallArcRadius) <= 1e-6,
    `Expected a round source corner, got radii ${c.rightLargeArcRadius.toFixed(3)} and ${c.rightSmallArcRadius.toFixed(3)}`
  );
  assert.ok(
    c.sourceY - c.rightSmallArcRadius >=
      c.verticalRightInnerExtent - 1e-6,
    "Expected the source-side vertical segment not to reverse"
  );
});

test("cjm-v0: same-source bottom backlinks follow span nesting order", () => {
  const chart = makeChart();
  const findLink = (target) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === "date_click-depart-repeated" &&
        link.target?.name === target
    );
  const inner = findLink("calendar--depart_input--clicked");
  const outer = findLink("date_click-depart-new");

  assert.ok(inner?.circularPathData, "Missing local bottom backlink");
  assert.ok(outer?.circularPathData, "Missing longer bottom backlink");
  assert.equal(inner.circularLinkType, "bottom");
  assert.equal(outer.circularLinkType, "bottom");
  assert.ok(
    outer.circularPathData.rightFullExtent >
      inner.circularPathData.rightFullExtent,
    "Expected the longer backlink to use the outer source-side slot"
  );

  const gap = chart.config.links.circularGap || 0;
  const innerBottom =
    inner.circularPathData.verticalFullExtent + inner.width / 2;
  const outerTop =
    outer.circularPathData.verticalFullExtent - outer.width / 2;
  assert.ok(
    outerTop - innerBottom >= gap - 1e-6,
    `Expected longer bottom backlink outside local backlink: gap=${(outerTop - innerBottom).toFixed(3)}, need ${gap}`
  );
});

test("cjm-v0: bottom target packing does not add a second gap beyond a top self-loop", () => {
  const chart = makeChart();
  const backlink = chart.graph.links.find(
    (link) =>
      link.source?.name === "search-ow-same" &&
      link.target?.name === "search-ow"
  );
  const selfLoop = chart.graph.links.find(
    (link) =>
      link.source?.name === "search-rt" &&
      link.target?.name === "search-rt"
  );

  assert.ok(backlink?.circularPathData, "Missing search-ow backlink geometry");
  assert.ok(selfLoop?.circularPathData, "Missing search-rt self-loop geometry");

  const gap = chart.config.links.circularGap || 0;
  const backlinkRightEdge =
    backlink.circularPathData.leftFullExtent +
    Math.max(backlink.width || 0, 1) / 2;
  const loopLeftEdge =
    selfLoop.circularPathData.leftFullExtent -
    Math.max(selfLoop.width || 0, 1) / 2;
  const actualGap = loopLeftEdge - backlinkRightEdge;
  assert.ok(
    Math.abs(actualGap - gap) <= 1e-6,
    `Expected one left-leg gap, got ${actualGap.toFixed(3)}, need ${gap}`
  );
});

test("cjm-v0: top self-loop packing preserves the target-side arc ceiling", () => {
  const chart = makeChart();
  const link = chart.graph.links.find(
    (candidate) =>
      candidate.source?.name === "search-ow-same" &&
      candidate.target?.name === "calendar_open-search_ow"
  );

  assert.ok(link?.circularPathData, "Missing search-ow-same backlink geometry");
  assert.equal(link.circularLinkType, "top");

  const c = link.circularPathData;
  const targetArcClearance =
    c.targetY -
    c.verticalFullExtent -
    c.leftLargeArcRadius -
    c.leftSmallArcRadius;
  assert.ok(
    targetArcClearance >= -1e-6,
    `Expected non-inverted target arcs, got ${targetArcClearance.toFixed(3)}px clearance`
  );
});

test("cjm-v0: node height includes gaps between bottom circular ports", () => {
  const chart = makeChart();
  const node = chart.graph.nodes.find(
    (candidate) => candidate.name === "calendar_open-search_ow"
  );

  assert.ok(node, "Missing calendar_open-search_ow node");

  const gap = Math.max(
    0,
    Math.min(2, Number(chart.config.links.circularGap) || 0)
  );
  const bottomSourceLinks = node.sourceLinks.filter(
    (link) => link.circular && link.circularLinkType === "bottom"
  );
  const requiredSourceHeight =
    node.sourceLinks.reduce((total, link) => total + link.width, 0) +
    Math.max(0, bottomSourceLinks.length - 1) * gap;
  const nodeHeight = node.y1 - node.y0;

  assert.ok(
    nodeHeight >= requiredSourceHeight - 1e-6,
    `Expected node height ${nodeHeight.toFixed(3)} to contain ${requiredSourceHeight.toFixed(3)}px port stack`
  );
});

test("cjm-v0: bottom source turn keeps space between its two arcs", () => {
  const chart = makeChart();
  const link = chart.graph.links.find(
    (candidate) =>
      candidate.source?.name === "search-rt-same" &&
      candidate.target?.name === "search-rt"
  );

  assert.ok(link?.circularPathData, "Missing search-rt backlink geometry");
  assert.equal(link.circularLinkType, "bottom");

  const c = link.circularPathData;
  const gap = chart.config.links.circularGap || 0;
  const straightSection =
    c.verticalRightInnerExtent - c.sourceY - c.rightSmallArcRadius;
  assert.ok(
    straightSection >= gap - 1e-6,
    `Expected ${gap}px between source arcs, got ${straightSection.toFixed(3)}px`
  );
});

test("cjm-v0: cross-band right legs in one source column stay separated", () => {
  const chart = makeChart();
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === target
    );
  const outer = findLink(
    "search-rt-same",
    "calendar_open-search_rt"
  );
  const inner = findLink("search-ow-same", "search-ow");

  assert.ok(outer?.circularPathData, "Missing outer TOP backlink");
  assert.ok(inner?.circularPathData, "Missing inner BOTTOM backlink");
  assert.equal(outer.circularLinkType, "top");
  assert.equal(inner.circularLinkType, "bottom");

  const gap = chart.config.links.circularGap || 0;
  const outerAfterInner =
    outer.circularPathData.rightFullExtent -
    outer.width / 2 -
    (inner.circularPathData.rightFullExtent + inner.width / 2);
  const innerAfterOuter =
    inner.circularPathData.rightFullExtent -
    inner.width / 2 -
    (outer.circularPathData.rightFullExtent + outer.width / 2);
  const visibleGap = Math.max(outerAfterInner, innerAfterOuter);
  assert.ok(
    visibleGap >= gap - 1e-6,
    `Expected ${gap}px between right legs, got ${visibleGap.toFixed(3)}px`
  );
});

test("cjm-v0: same-source TOP right legs stay nested near the node", () => {
  const chart = makeChart();
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === target
    );
  const inner = findLink(
    "search-rt-same",
    "calendar_open-search_rt"
  );
  const outer = findLink(
    "search-rt-same",
    "date_click-depart-repeated"
  );
  const nearby = findLink(
    "search-ow-same",
    "date_click-depart-repeated"
  );

  assert.ok(inner?.circularPathData, "Missing local RT TOP backlink");
  assert.ok(outer?.circularPathData, "Missing long RT TOP backlink");
  assert.ok(nearby?.circularPathData, "Missing comparable OW TOP backlink");

  const gap = chart.config.links.circularGap || 0;
  const visibleGap =
    outer.circularPathData.rightFullExtent -
    outer.width / 2 -
    (inner.circularPathData.rightFullExtent + inner.width / 2);
  assert.ok(
    visibleGap >= gap - 1e-6,
    `Expected nested RT legs to clear by ${gap}px, got ${visibleGap.toFixed(3)}px`
  );
  assert.ok(
    Math.abs(inner.circularPathData.rightFullExtent -
      nearby.circularPathData.rightFullExtent) < 10 &&
      Math.abs(outer.circularPathData.rightFullExtent -
        nearby.circularPathData.rightFullExtent) < 10,
    "Expected both RT TOP legs to stay near the comparable OW TOP lane"
  );
});
