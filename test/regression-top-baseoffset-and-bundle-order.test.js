const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// UMD bundle expects a global `self` (browser). Provide it for Node.
globalThis.self = globalThis;
const { SankeyChart } = require(path.join("..", "dist", "sankeyPlus.js"));

function makeFullDebugChart() {
  const html = fs.readFileSync(path.join(__dirname, "..", "test-debug.html"), "utf8");
  const nodesMatch = html.match(/\b(?:let|const)\s+nodes\s*=\s*(\[[\s\S]*?\]);/);
  const linksMatch = html.match(/\b(?:let|const)\s+links\s*=\s*(\[[\s\S]*?\]);/);
  assert.ok(nodesMatch, "Failed to parse nodes from test-debug.html");
  assert.ok(linksMatch, "Failed to parse links from test-debug.html");
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
      typeOrder: ["booking", "search_loop", "primary", "secondary", "search_nearby"],
      typeAccessor: (d) => d.type,
      types: {},
    },
    arrows: { enabled: false },
  });

  chart.process();
  return chart;
}

function shelf(link) {
  const c = link.circularPathData;
  assert.ok(c, "Missing circularPathData");
  const x1 = Math.min(c.leftInnerExtent, c.rightInnerExtent);
  const x2 = Math.max(c.leftInnerExtent, c.rightInnerExtent);
  return { vfe: c.verticalFullExtent, x1, x2 };
}

test("regression: TOP baseOffset compensation should not create a large hole (sosisa ●→schedule ● vs sosisa ◐→schedule ○)", () => {
  const chart = makeFullDebugChart();
  const gap = 1;

  const b = chart.graph.links.find((l) => l.source?.name === "sosisa ●" && l.target?.name === "schedule ●");
  const c = chart.graph.links.find((l) => l.source?.name === "sosisa ◐" && l.target?.name === "schedule ○");
  assert.ok(b && c, "Missing expected links sosisa ●→schedule ● and/or sosisa ◐→schedule ○");
  assert.ok(b.circular && c.circular, "Expected both links to be circular");
  assert.equal(b.circularLinkType, "top");
  assert.equal(c.circularLinkType, "top");

  const cb = b.circularPathData;
  const cc = c.circularPathData;
  assert.ok(cb && cc, "Missing circularPathData");

  const totalB = cb.baseOffset + cb.verticalBuffer;
  const totalC = cc.baseOffset + cc.verticalBuffer;
  const totalDiff = totalC - totalB;
  const minNeeded = (b.width || 0) / 2 + (c.width || 0) / 2 + gap;

  // This is intentionally tight: we want this pair to sit at the minimum gap,
  // not create an extra "hole" due to baseOffset differences.
  assert.ok(
    totalDiff <= minNeeded + 1e-3,
    `Expected no extra hole beyond minNeeded: totalDiff=${totalDiff.toFixed(6)} minNeeded=${minNeeded.toFixed(6)}`
  );
});

test("regression: listing ○→search ○ should not sink below sosisa ●→search ◐ when their TOP shelves overlap (full fixture)", () => {
  const chart = makeFullDebugChart();

  const a = chart.graph.links.find((l) => l.source?.name === "listing ○" && l.target?.name === "search ○");
  const b = chart.graph.links.find((l) => l.source?.name === "sosisa ●" && l.target?.name === "search ◐");
  assert.ok(a && b, "Missing expected links listing ○→search ○ and/or sosisa ●→search ◐");
  assert.ok(a.circular && b.circular, "Expected both links to be circular");
  assert.equal(a.circularLinkType, "top");
  assert.equal(b.circularLinkType, "top");

  const sa = shelf(a);
  const sb = shelf(b);
  const xOverlap = Math.max(0, Math.min(sa.x2, sb.x2) - Math.max(sa.x1, sb.x1));
  assert.ok(xOverlap > 1e-6, "Expected TOP shelves to overlap in X for this regression case");

  // For TOP links, smaller verticalFullExtent means the shelf is higher (closer to the top).
  assert.ok(
    sa.vfe <= sb.vfe + 1e-3,
    `Expected listing ○→search ○ (vfe=${sa.vfe.toFixed(6)}) to be no lower than sosisa ●→search ◐ (vfe=${sb.vfe.toFixed(6)})`
  );
});

test("regression: top backlinks into search ○ and search ◐ should not interleave in VFE order (full fixture)", () => {
  const chart = makeFullDebugChart();

  const topCircular = chart.graph.links
    .filter((l) => l.circular && !l.isVirtual && l.circularLinkType === "top")
    // inner (closer to nodes) first
    .sort((a, b) => b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent);

  function block(targetName) {
    const idxs = [];
    topCircular.forEach((l, i) => {
      if (l.target?.name === targetName) idxs.push(i);
    });
    assert.ok(idxs.length > 1, `Need at least 2 top circular links into ${targetName} for this invariant`);
    return { min: Math.min(...idxs), max: Math.max(...idxs), count: idxs.length };
  }

  const a = block("search ○");
  const b = block("search ◐");

  const overlap = !(a.max < b.min || b.max < a.min);
  assert.ok(
    !overlap,
    `Expected no interleaving between search ○ and search ◐ blocks in VFE order; got search○=[${a.min},${a.max}] search◐=[${b.min},${b.max}]`
  );
});

test("regression: no huge hole between schedule ●→filter and filter→saved_filters_search ● when their TOP shelves overlap (full fixture)", () => {
  const chart = makeFullDebugChart();
  const gap = 1;

  const a = chart.graph.links.find((l) => l.source?.name === "schedule ●" && l.target?.name === "filter");
  const b = chart.graph.links.find(
    (l) => l.source?.name === "filter" && l.target?.name === "saved_filters_search ●"
  );
  assert.ok(a && b, "Missing expected links schedule ●→filter and/or filter→saved_filters_search ●");
  assert.ok(a.circular && b.circular, "Expected both links to be circular");
  assert.equal(a.circularLinkType, "top");
  assert.equal(b.circularLinkType, "top");

  const sa = shelf(a);
  const sb = shelf(b);
  const xOverlap = Math.max(0, Math.min(sa.x2, sb.x2) - Math.max(sa.x1, sb.x1));
  assert.ok(xOverlap > 1e-6, "Expected TOP shelves to overlap in X for this regression case");

  const minNeeded = (a.width || 0) / 2 + (b.width || 0) / 2 + gap;
  const actual = Math.abs(sa.vfe - sb.vfe);

  // The overlap is tiny (edge-to-edge touch), so we only assert the gap is not absurdly larger than needed.
  // This specifically guards against accidental large positive baseY corrections pushing bundles apart.
  assert.ok(
    actual <= minNeeded + 5,
    `Expected no huge hole: actual=${actual.toFixed(6)} minNeeded=${minNeeded.toFixed(6)}`
  );
});

test("tighten local top: sosisa ○→schedule ○ should sit close to sosisa ◐→schedule ○ (no extra slack beyond circularGap)", () => {
  const chart = makeFullDebugChart();
  const gap = 1;

  const a = chart.graph.links.find((l) => l.source?.name === "sosisa ○" && l.target?.name === "schedule ○");
  const b = chart.graph.links.find((l) => l.source?.name === "sosisa ◐" && l.target?.name === "schedule ○");
  assert.ok(a && b, "Missing expected links sosisa ○→schedule ○ and/or sosisa ◐→schedule ○");
  assert.ok(a.circular && b.circular, "Expected both links to be circular");
  assert.equal(a.circularLinkType, "top");
  assert.equal(b.circularLinkType, "top");

  const sa = shelf(a);
  const sb = shelf(b);
  const xOverlap = Math.max(0, Math.min(sa.x2, sb.x2) - Math.max(sa.x1, sb.x1));
  assert.ok(xOverlap > 1e-6, "Expected TOP shelves to overlap in X for this tightening case");

  // For TOP links, outer is smaller VFE.
  const outer = sa.vfe <= sb.vfe ? a : b;
  const inner = outer === a ? b : a;
  const so = shelf(outer);
  const si = shelf(inner);

  const outerW = outer.width || 0;
  const innerW = inner.width || 0;
  const outerBottom = so.vfe + outerW / 2;
  const innerTop = si.vfe - innerW / 2;
  const edgeGap = innerTop - outerBottom;

  // We only require that the gap is close to the minimum. Allow a small epsilon for float noise.
  // This guards against the common regression where the local (span=1) link sits ~1px deeper than needed.
  assert.ok(
    edgeGap <= gap + 0.2,
    `Expected edge gap close to circularGap: edgeGap=${edgeGap.toFixed(6)} gap=${gap}`
  );
});


