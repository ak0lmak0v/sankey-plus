const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

globalThis.self = globalThis;
const { SankeyChart } = require(path.join("..", "dist", "sankeyPlus.js"));

function parseArray(source, name) {
  const match = source.match(
    new RegExp(`\\blet\\s+${name}\\s*=\\s*(\\[[\\s\\S]*?\\]);`)
  );
  assert.ok(match, `Failed to parse ${name} from CJM_BAGGAGE.html`);
  return vm.runInNewContext(`(${match[1]})`);
}

function makeChart(forcedRoutes = []) {
  const fixture = fs.readFileSync(
    path.join(__dirname, "..", "CJM_BAGGAGE.html"),
    "utf8"
  );
  const forcedByPair = new Map(
    forcedRoutes.map(([source, target, side]) => [
      `${source}\u0000${target}`,
      side,
    ])
  );
  const links = parseArray(fixture, "links1");
  links.forEach((link) => {
    const side =
      forcedByPair.get(`${link.source}\u0000${link.target}`) ||
      forcedByPair.get(`*\u0000${link.target}`);
    if (side) link._forceCircularLinkType = side;
  });
  const chart = new SankeyChart({
    align: "left",
    id: (node) => node.name,
    iterations: 50,
    padding: 0,
    width: 1200,
    height: 700,
    scale: 0.2,
    nodes: {
      data: parseArray(fixture, "nodes1"),
      width: 15,
      padding: 30,
      minPadding: 30,
      virtualPadding: 7,
      horizontalSort: true,
      verticalSort: true,
      setPositions: false,
    },
    links: {
      data: links,
      circularGap: 0.8,
      costBasedCircularRouting: true,
      circularLinkPortionTopBottom: 0.01,
      circularLinkPortionLeftRight: 0.2,
      useVirtualRoutes: true,
      baseRadius: 7,
      verticalMargin: 70,
      horizontalMargin: 100,
      sortIterations: 120,
      postSortIterations: 10,
      virtualLinkType: "bezier",
      typeOrder: [
        "fare_action",
        "ticket",
        "click",
        "search_loop",
        "primary",
        "booking",
        "secondary",
        "filter",
      ],
      typeAccessor: (link) => link.type,
    },
  });
  chart.process();
  return chart;
}

test("CJM_BAGGAGE: roomy target turn uses concentric left arcs", () => {
  const chart = makeChart([
    ["baggage_filter_on", "filter", "top"],
  ]);
  const link = chart.graph.links.find(
    (candidate) =>
      candidate.source?.name === "baggage_filter_on" &&
      candidate.target?.name === "filter"
  );

  assert.ok(link?.circularPathData, "Missing baggage filter backlink");
  assert.equal(link.circularLinkType, "top");

  const c = link.circularPathData;
  const availableTurn = c.targetY - c.verticalLeftInnerExtent;
  assert.ok(
    availableTurn >= c.leftLargeArcRadius - 1e-6,
    "Fixture no longer has enough room for a concentric target turn"
  );
  assert.ok(
    Math.abs(c.leftSmallArcRadius - c.leftLargeArcRadius) <= 1e-6,
    `Expected round target turn, got radii ${c.leftLargeArcRadius.toFixed(3)} × ${c.leftSmallArcRadius.toFixed(3)}`
  );
});

test("CJM_BAGGAGE: rerouted left legs keep a visible gap", () => {
  const chart = makeChart();
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === target
    );
  const first = findLink("booking", "search_with_baggage_filter");
  const second = findLink("search_with_baggage_filter", "search");

  assert.ok(first?.circularPathData, "Missing booking backlink");
  assert.ok(second?.circularPathData, "Missing search backlink");

  const firstC = first.circularPathData;
  const secondC = second.circularPathData;
  const firstSegment = [
    Math.min(firstC.targetY, firstC.verticalLeftInnerExtent),
    Math.max(firstC.targetY, firstC.verticalLeftInnerExtent),
  ];
  const secondSegment = [
    Math.min(secondC.targetY, secondC.verticalLeftInnerExtent),
    Math.max(secondC.targetY, secondC.verticalLeftInnerExtent),
  ];
  const yOverlap =
    Math.min(firstSegment[1], secondSegment[1]) -
    Math.max(firstSegment[0], secondSegment[0]);
  assert.ok(yOverlap > 0, "Fixture left legs no longer overlap vertically");

  const gap = chart.config.links.circularGap || 0;
  const visibleGap =
    Math.abs(firstC.leftFullExtent - secondC.leftFullExtent) -
    (first.width + second.width) / 2;
  assert.ok(
    visibleGap >= gap - 1e-6,
    `Expected ${gap}px between left legs, got ${visibleGap.toFixed(3)}px`
  );
});

test("CJM_BAGGAGE: cross-target bottom left legs keep a visible gap", () => {
  const chart = makeChart();
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === target
    );
  const first = findLink("click", "search_with_baggage_filter");
  const second = findLink("filter", "search");

  assert.ok(first?.circularPathData, "Missing click backlink");
  assert.ok(second?.circularPathData, "Missing filter backlink");
  assert.equal(first.circularLinkType, "bottom");
  assert.equal(second.circularLinkType, "bottom");

  const firstC = first.circularPathData;
  const secondC = second.circularPathData;
  const firstY = [
    Math.min(firstC.targetY, firstC.verticalLeftInnerExtent),
    Math.max(firstC.targetY, firstC.verticalLeftInnerExtent),
  ];
  const secondY = [
    Math.min(secondC.targetY, secondC.verticalLeftInnerExtent),
    Math.max(secondC.targetY, secondC.verticalLeftInnerExtent),
  ];
  assert.ok(
    Math.min(firstY[1], secondY[1]) >
      Math.max(firstY[0], secondY[0]) + 1e-6,
    "Fixture left legs no longer overlap vertically"
  );

  const visibleGap =
    Math.abs(firstC.leftFullExtent - secondC.leftFullExtent) -
    (Math.max(first.width, 1) + Math.max(second.width, 1)) / 2;
  const requiredGap = chart.config.links.circularGap || 0;
  assert.ok(
    visibleGap >= requiredGap - 1e-6,
    `Expected ${requiredGap}px between cross-target left legs, got ${visibleGap.toFixed(3)}px`
  );
});

test("CJM_BAGGAGE: click to salota wraps outside the click self-loop", () => {
  const chart = makeChart();
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === target
    );
  const backlink = findLink("click", "salota_click");
  const reverse = findLink("salota_click", "click");
  const selfLoop = findLink("click", "click");

  assert.ok(backlink?.circularPathData, "Missing click -> salota_click");
  assert.ok(reverse?.circularPathData, "Missing salota_click -> click");
  assert.ok(selfLoop?.circularPathData, "Missing click self-loop");
  assert.equal(backlink.circularLinkType, "bottom");
  assert.equal(selfLoop.circularLinkType, "bottom");

  const backlinkC = backlink.circularPathData;
  const loopC = selfLoop.circularPathData;
  const yOverlap =
    Math.min(
      Math.max(backlinkC.targetY, backlinkC.verticalLeftInnerExtent),
      Math.max(loopC.targetY, loopC.verticalLeftInnerExtent)
    ) -
    Math.max(
      Math.min(backlinkC.targetY, backlinkC.verticalLeftInnerExtent),
      Math.min(loopC.targetY, loopC.verticalLeftInnerExtent)
    );
  assert.ok(yOverlap > 1e-6, "Fixture left legs no longer overlap in Y");

  const visibleGap =
    loopC.leftFullExtent -
    Math.max(selfLoop.width, 1) / 2 -
    (backlinkC.leftFullExtent + Math.max(backlink.width, 1) / 2);
  const requiredGap = chart.config.links.circularGap || 0;
  assert.ok(
    visibleGap >= requiredGap - 1e-6,
    `Expected click -> salota_click outside self-loop by ${requiredGap}px, got ${visibleGap.toFixed(3)}px`
  );

  const backlinkLeft =
    backlinkC.leftFullExtent - Math.max(backlink.width, 1) / 2;
  const backlinkRight =
    backlinkC.leftFullExtent + Math.max(backlink.width, 1) / 2;
  const reverseC = reverse.circularPathData;
  const reverseLeft =
    reverseC.leftFullExtent - Math.max(reverse.width, 1) / 2;
  const reverseRight =
    reverseC.leftFullExtent + Math.max(reverse.width, 1) / 2;
  const pairGap =
    Math.max(backlinkLeft, reverseLeft) -
    Math.min(backlinkRight, reverseRight);
  assert.ok(
    pairGap >= requiredGap - 1e-6,
    `Expected opposite click/salota legs to keep ${requiredGap}px, got ${pairGap.toFixed(3)}px`
  );

  const reverseTargetLegHeight =
    reverseC.verticalLeftInnerExtent -
    (reverseC.targetY + reverseC.leftSmallArcRadius);
  assert.ok(
    reverseTargetLegHeight >= requiredGap - 1e-6,
    `Expected salota_click -> click target leg height of ${requiredGap}px, got ${reverseTargetLegHeight.toFixed(3)}px`
  );
});

test("CJM_BAGGAGE: outer ticket-to-filter shelf wraps its right leg", () => {
  const chart = makeChart();
  const findLink = (source) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === "filter"
    );
  const withoutBaggage = findLink("ticket_open_without_baggage");
  const withBaggage = findLink("ticket_open_with_baggage");

  assert.ok(withoutBaggage?.circularPathData);
  assert.ok(withBaggage?.circularPathData);
  assert.equal(withoutBaggage.circularLinkType, "bottom");
  assert.equal(withBaggage.circularLinkType, "bottom");

  const inner = withoutBaggage.circularPathData;
  const outer = withBaggage.circularPathData;
  assert.ok(
    outer.verticalFullExtent > inner.verticalFullExtent,
    "Fixture no longer has ticket_open_with_baggage on the outer shelf"
  );

  const visibleGap =
    outer.rightFullExtent -
    Math.max(withBaggage.width, 1) / 2 -
    (inner.rightFullExtent + Math.max(withoutBaggage.width, 1) / 2);
  const requiredGap = chart.config.links.circularGap || 0;
  assert.ok(
    visibleGap >= requiredGap - 1e-6,
    `Expected outer ticket right leg to wrap by ${requiredGap}px, got ${visibleGap.toFixed(3)}px`
  );
});

test("CJM_BAGGAGE: filter TOP legs clear each other", () => {
  const chart = makeChart([
    ["filter", "search_with_baggage_filter", "top"],
    ["filter", "search", "top"],
  ]);
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === target
    );
  const long = findLink("filter", "search_with_baggage_filter");
  const local = findLink("filter", "search");
  const selfLoop = findLink("search", "search");

  assert.ok(long?.circularPathData, "Missing long filter backlink");
  assert.ok(local?.circularPathData, "Missing local filter backlink");
  assert.ok(selfLoop?.circularPathData, "Missing search self-loop");

  const gap = chart.config.links.circularGap || 0;
  const visibleGap = (first, second) =>
    Math.abs(
      first.circularPathData.leftFullExtent -
        second.circularPathData.leftFullExtent
    ) -
    (first.width + second.width) / 2;

  assert.ok(
    visibleGap(long, local) >= gap - 1e-6,
    "Expected filter backlink left legs to stay separate"
  );
  assert.ok(selfLoop?.circularPathData, "Missing search self-loop");
});

test("CJM_BAGGAGE: same-target bottom shelves keep matching left-leg order", () => {
  const chart = makeChart([
    ["service_baggage", "search", "bottom"],
    ["baggage_toggle_off", "search", "bottom"],
  ]);
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === target
    );
  const outerShelf = findLink("service_baggage", "search");
  const innerShelf = findLink("baggage_toggle_off", "search");

  assert.ok(outerShelf?.circularPathData, "Missing service_baggage backlink");
  assert.ok(innerShelf?.circularPathData, "Missing baggage_toggle_off backlink");
  const visibleGap =
    Math.abs(
      outerShelf.circularPathData.leftFullExtent -
      innerShelf.circularPathData.leftFullExtent
    ) -
    (outerShelf.width + innerShelf.width) / 2;
  assert.ok(
    visibleGap >= chart.config.links.circularGap - 1e-6,
    `Expected bottom target legs to clear, got ${visibleGap.toFixed(3)}px`
  );
});

test("CJM_BAGGAGE: reordered search bundle clears crossing TOP left legs", () => {
  const chart = makeChart();
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === target
    );
  const top = findLink("filter", "search_with_baggage_filter");
  const bottom = findLink("ticket_open_without_baggage", "search");

  assert.ok(top?.circularPathData, "Missing filter TOP backlink");
  assert.ok(bottom?.circularPathData, "Missing ticket bottom backlink");

  const gap = chart.config.links.circularGap || 0;
  const visibleGap =
    Math.abs(
      top.circularPathData.leftFullExtent -
        bottom.circularPathData.leftFullExtent
    ) -
    (top.width + bottom.width) / 2;
  assert.ok(
    visibleGap >= gap - 1e-6,
    `Expected cross-band left legs to clear by ${gap}px, got ${visibleGap.toFixed(3)}px`
  );
});

test("CJM_BAGGAGE: same-target top shelves keep matching left-leg order", () => {
  const chart = makeChart([
    ["fare_screen_opened", "search_with_baggage_filter", "top"],
    ["baggage_toggle_on", "search_with_baggage_filter", "top"],
  ]);
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === target
    );
  const outerShelf = findLink(
    "fare_screen_opened",
    "search_with_baggage_filter"
  );
  const innerShelf = findLink(
    "baggage_toggle_on",
    "search_with_baggage_filter"
  );

  assert.ok(outerShelf?.circularPathData, "Missing fare_screen_opened backlink");
  assert.ok(innerShelf?.circularPathData, "Missing baggage_toggle_on backlink");
  assert.ok(
    outerShelf.circularPathData.verticalFullExtent <
      innerShelf.circularPathData.verticalFullExtent,
    "Expected fare_screen_opened to use the outer top shelf"
  );
  assert.ok(
    outerShelf.circularPathData.leftFullExtent <
      innerShelf.circularPathData.leftFullExtent,
    "Expected the outer top shelf to use the outer left leg"
  );
});

test("CJM_BAGGAGE: TOP shelves enter filter in shelf order", () => {
  const chart = makeChart();
  const links = chart.graph.links
    .filter(
      (link) =>
        link.circular &&
        link.circularLinkType === "top" &&
        link.target?.name === "filter"
    )
    .sort(
      (a, b) =>
        b.circularPathData.verticalFullExtent -
        a.circularPathData.verticalFullExtent
    );

  assert.ok(links.length >= 2, "Missing TOP backlinks to filter");
  for (let index = 1; index < links.length; index++) {
    const outer = links[index - 1];
    const inner = links[index];
    assert.ok(
      outer.circularPathData.targetY <
        inner.circularPathData.targetY - 1e-6,
      `${outer.source.name} -> filter should enter above ${inner.source.name} -> filter`
    );
  }

  const baggageFilterOn = links.find(
    (link) => link.source?.name === "baggage_filter_on"
  );
  const baggageFilterOff = links.find(
    (link) => link.source?.name === "baggage_filter_off"
  );
  assert.ok(baggageFilterOn && baggageFilterOff);
  assert.ok(
    baggageFilterOn.circularPathData.targetY <
      baggageFilterOff.circularPathData.targetY
  );
});

test("CJM_BAGGAGE: bottom self-loops preserve straight sections between arcs", () => {
  const chart = makeChart();
  const nodeNames = new Set([
    "ticket_open_without_baggage",
    "click",
    "fare_screen_opened",
  ]);
  const loops = chart.graph.links.filter(
    (link) =>
      link.circular &&
      link.circularLinkType === "bottom" &&
      link.source === link.target &&
      nodeNames.has(link.source?.name)
  );

  assert.equal(loops.length, nodeNames.size);
  const gap = chart.config.links.circularGap || 0;
  loops.forEach((link) => {
    const c = link.circularPathData;
    const rightStraight =
      c.verticalFullExtent -
      c.rightLargeArcRadius -
      c.sourceY -
      c.rightSmallArcRadius;
    const leftStraight =
      c.verticalFullExtent -
      c.leftLargeArcRadius -
      c.targetY -
      c.leftSmallArcRadius;
    assert.ok(
      rightStraight >= gap - 1e-6,
      `${link.source.name} right arcs overlap by ${(gap - rightStraight).toFixed(3)}px`
    );
    assert.ok(
      leftStraight >= gap - 1e-6,
      `${link.source.name} left arcs overlap by ${(gap - leftStraight).toFixed(3)}px`
    );
  });
});

test("CJM_BAGGAGE: outer bottom shelves enter their target above inner shelves", () => {
  const chart = makeChart([
    ["click", "ticket_open_without_baggage", "bottom"],
    ["salota_click", "ticket_open_without_baggage", "bottom"],
    ["booking", "ticket_open_without_baggage", "bottom"],
  ]);
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === target
    );
  const click = findLink("click", "ticket_open_without_baggage");
  const salota = findLink("salota_click", "ticket_open_without_baggage");
  const booking = findLink("booking", "ticket_open_without_baggage");

  assert.ok(click?.circularPathData, "Missing click backlink");
  assert.ok(salota?.circularPathData, "Missing salota_click backlink");
  assert.ok(booking?.circularPathData, "Missing booking backlink");
  assert.ok(
    click.circularPathData.verticalFullExtent >
      salota.circularPathData.verticalFullExtent &&
      click.circularPathData.verticalFullExtent >
        booking.circularPathData.verticalFullExtent,
    "Expected click to use the outermost bottom shelf"
  );
  assert.ok(
    click.circularPathData.targetY <
      salota.circularPathData.targetY &&
      click.circularPathData.targetY <
        booking.circularPathData.targetY,
    "Expected click to enter the target above both inner backlinks"
  );
});

test("CJM_BAGGAGE: top left-leg target bundles stay contiguous", () => {
  const chart = makeChart([
    ["*", "ticket_open_without_baggage", "top"],
    ["*", "ticket_open_with_baggage", "top"],
  ]);
  const links = chart.graph.links
    .filter(
      (link) =>
        link.circular &&
        link.circularLinkType === "top" &&
        link.source !== link.target &&
        link.target?.column === 5 &&
        ["ticket_open_with_baggage", "ticket_open_without_baggage"].includes(
          link.target.name
        )
    )
    .sort(
      (a, b) =>
        b.circularPathData.leftFullExtent -
        a.circularPathData.leftFullExtent
    );

  const closedTargets = new Set();
  let currentTarget = null;
  links.forEach((link) => {
    const target = link.target.name;
    if (target !== currentTarget) {
      if (currentTarget !== null) closedTargets.add(currentTarget);
      assert.ok(
        !closedTargets.has(target),
        `Target bundle ${target} is split across top left-leg slots`
      );
      currentTarget = target;
    }
  });

  assert.deepEqual(
    [...new Set(links.map((link) => link.target.name))],
    ["ticket_open_without_baggage", "ticket_open_with_baggage"]
  );

  const gap = chart.config.links.circularGap || 0;
  for (let index = 1; index < links.length; index++) {
    const inner = links[index - 1];
    const outer = links[index];
    const visibleGap =
      inner.circularPathData.leftFullExtent -
      Math.max(inner.width, 1) / 2 -
      (outer.circularPathData.leftFullExtent +
        Math.max(outer.width, 1) / 2);
    assert.ok(
      visibleGap >= gap - 1e-6,
      `Expected adjacent top target bundles to clear by ${gap}px, got ${visibleGap.toFixed(3)}px`
    );
  }
});

test("CJM_BAGGAGE: equal-size top shelf target bundles stay contiguous", () => {
  const chart = makeChart();
  const links = chart.graph.links
    .filter(
      (link) =>
        link.circular &&
        link.circularLinkType === "top" &&
        link.source !== link.target &&
        ["baggage_filter_on", "search_with_baggage_filter"].includes(
          link.target?.name
        )
    )
    .sort(
      (a, b) =>
        b.circularPathData.verticalFullExtent -
        a.circularPathData.verticalFullExtent
    );

  const targetOrder = links.map((link) => link.target.name);
  const closedTargets = new Set();
  let currentTarget = null;
  targetOrder.forEach((target) => {
    if (target !== currentTarget) {
      if (currentTarget !== null) closedTargets.add(currentTarget);
      assert.ok(
        !closedTargets.has(target),
        `Target shelf bundle ${target} is split: ${links
          .map(
            (link) =>
              `${link.target.name}@${link.circularPathData.verticalFullExtent.toFixed(3)}`
          )
          .join(", ")}`
      );
      currentTarget = target;
    }
  });

  assert.deepEqual(
    [...new Set(targetOrder)],
    ["baggage_filter_on", "search_with_baggage_filter"]
  );
});

test("CJM_BAGGAGE: final top shelves keep a visible gap", () => {
  const chart = makeChart();
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === target
    );
  const inner = findLink("fare_change", "search");
  const outer = findLink("baggage_toggle_off", "baggage_toggle_on");

  assert.ok(inner?.circularPathData, "Missing fare_change backlink");
  assert.ok(outer?.circularPathData, "Missing baggage_toggle_off backlink");

  const gap = chart.config.links.circularGap || 0;
  const visibleGap =
    Math.abs(
      inner.circularPathData.verticalFullExtent -
        outer.circularPathData.verticalFullExtent
    ) -
    Math.max(inner.width, 1) / 2 -
    Math.max(outer.width, 1) / 2;
  assert.ok(
    visibleGap >= gap - 1e-6,
    `Expected final top shelves to clear by ${gap}px, got ${visibleGap.toFixed(3)}px`
  );
});

test("CJM_BAGGAGE: final TOP left-leg bundles clear BOTTOM blockers", () => {
  const chart = makeChart();
  const findLink = (source, target) =>
    chart.graph.links.find(
      (link) =>
        link.source?.name === source &&
        link.target?.name === target
    );
  const top = findLink(
    "fare_screen_opened",
    "search_with_baggage_filter"
  );
  const bottom = findLink("ticket_open_with_baggage", "search");

  assert.ok(top?.circularPathData, "Missing fare_screen_opened backlink");
  assert.ok(bottom?.circularPathData, "Missing ticket_open_with_baggage backlink");

  const gap = chart.config.links.circularGap || 0;
  const visibleGap =
    Math.abs(
      top.circularPathData.leftFullExtent -
        bottom.circularPathData.leftFullExtent
    ) -
    Math.max(top.width, 1) / 2 -
    Math.max(bottom.width, 1) / 2;
  assert.ok(
    visibleGap >= gap - 1e-6,
    `Expected cross-band left legs to clear by ${gap}px, got ${visibleGap.toFixed(3)}px`
  );
});

test("CJM_BAGGAGE: interleaved top shelf groups follow target-column order", () => {
  const chart = makeChart();
  const targetNames = [
    "baggage_toggle_on",
    "ticket_open_without_baggage",
    "search",
    "search_with_baggage_filter",
  ];
  const links = chart.graph.links
    .filter(
      (link) =>
        link.circular &&
        link.circularLinkType === "top" &&
        link.source !== link.target &&
        targetNames.includes(link.target?.name)
    )
    .sort(
      (a, b) =>
        b.circularPathData.verticalFullExtent -
        a.circularPathData.verticalFullExtent
    );

  const sequence = links.map((link) => link.target.name);
  const compactOrder = sequence.filter(
    (target, index) => index === 0 || target !== sequence[index - 1]
  );
  assert.equal(compactOrder.join("|"), targetNames.join("|"));
});

test("CJM_BAGGAGE: cost routing balances discussed long backlink bundles", () => {
  const chart = makeChart();
  const links = chart.graph.links;
  const discussedTargets = new Set([
    "baggage_toggle_on",
    "fare_screen_opened",
  ]);
  const discussedSources = new Set(["click", "salota_click"]);
  const discussed = links.filter(
    (link) =>
      discussedSources.has(link.source?.name) &&
      discussedTargets.has(link.target?.name)
  );

  assert.equal(discussed.length, 4);
  discussed.forEach((link) => {
    assert.equal(link.circularLinkType, "top");
    assert.equal(link._circularRoutingCost?.chosen, "top");
    assert.ok(
      link._circularRoutingCost.top < link._circularRoutingCost.bottom
    );
  });

  for (const target of discussedTargets) {
    const pair = discussed
      .filter((link) => link.target.name === target)
      .sort(
        (a, b) =>
          a.circularPathData.verticalFullExtent -
          b.circularPathData.verticalFullExtent
      );
    const requiredGap =
      pair[0].width / 2 +
      pair[1].width / 2 +
      chart.config.links.circularGap;
    const actualGap =
      pair[1].circularPathData.verticalFullExtent -
      pair[0].circularPathData.verticalFullExtent;
    assert.ok(
      actualGap >= requiredGap - 1e-6,
      `${target} TOP shelves overlap by ${(requiredGap - actualGap).toFixed(3)}px`
    );
  }
});

test("CJM_BAGGAGE: same-half backlink takes the direct TOP corridor", () => {
  const chart = makeChart();
  const link = chart.graph.links.find(
    (candidate) =>
      candidate.source?.name === "baggage_toggle_on" &&
      candidate.target?.name === "baggage_filter_on"
  );

  assert.ok(link?.circular);
  assert.equal(link.circularLinkType, "top");
  assert.equal(link._circularRoutingCost?.chosen, "top");
  assert.ok(link._circularRoutingCost.top < link._circularRoutingCost.bottom);
  assert.equal(
    link._circularRoutingCost.components.top.crossings,
    0
  );
});

test("CJM_BAGGAGE: near-middle backlinks use the freer TOP corridor", () => {
  const chart = makeChart();
  const pairs = [
    ["fare_screen_opened", "baggage_filter_on"],
    ["fare_change", "fare_screen_opened"],
  ];

  pairs.forEach(([source, target]) => {
    const link = chart.graph.links.find(
      (candidate) =>
        candidate.source?.name === source &&
        candidate.target?.name === target
    );
    assert.ok(link?.circular, `Missing ${source} -> ${target}`);
    assert.equal(link.circularLinkType, "top");
    assert.equal(link._circularRoutingCost?.chosen, "top");
    assert.ok(link._circularRoutingCost.top < link._circularRoutingCost.bottom);
  });
});

test("CJM_BAGGAGE: span=1 backlink participates in cost routing", () => {
  const chart = makeChart();
  const link = chart.graph.links.find(
    (candidate) =>
      candidate.source?.name === "baggage_toggle_on" &&
      candidate.target?.name === "ticket_open_without_baggage"
  );

  assert.ok(link?.circular);
  assert.equal(
    Math.abs(link.source.column - link.target.column),
    1
  );
  assert.equal(link.circularLinkType, "top");
  assert.equal(link._circularRoutingCost?.chosen, "top");
  assert.ok(
    link._circularRoutingCost.top < link._circularRoutingCost.bottom
  );
});

test("CJM_BAGGAGE: source-column target bundles receive one atomic side", () => {
  const chart = makeChart();
  const bundles = new Map();
  chart.graph.links
    .filter(
      (link) =>
        link.circular &&
        link.source !== link.target &&
        link.target.column < link.source.column
    )
    .forEach((link) => {
      const key = `${link.source.column}|${link.target.name}`;
      if (!bundles.has(key)) bundles.set(key, []);
      bundles.get(key).push(link);
    });

  bundles.forEach((bundle, key) => {
    assert.equal(
      new Set(bundle.map((link) => link.circularLinkType)).size,
      1,
      `Cost routing split bundle ${key}`
    );
  });
});

test("CJM_BAGGAGE: cost routing balances total visible backlink thickness", () => {
  const chart = makeChart();
  const loads = { top: 0, bottom: 0 };
  chart.graph.links
    .filter(
      (link) =>
        link.circular &&
        link.source !== link.target &&
        link.target.column < link.source.column
    )
    .forEach((link) => {
      loads[link.circularLinkType] += Math.max(link.width || 0, 1);
    });

  const ratio =
    Math.max(loads.top, loads.bottom) /
    Math.max(1, Math.min(loads.top, loads.bottom));
  assert.ok(ratio < 2, `TOP/BOTTOM thickness ratio is ${ratio.toFixed(3)}`);
});
