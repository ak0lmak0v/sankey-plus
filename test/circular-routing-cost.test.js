const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

globalThis.self = globalThis;
const {
  SankeyChart,
  scoreCircularRouteCost,
  circularRouteDistanceWeight,
} = require(path.join("..", "dist", "sankeyPlus.js"));

function cost(overrides = {}) {
  return scoreCircularRouteCost({
    distance: 0,
    columnLoad: 0,
    totalLoad: 0,
    direction: 0,
    nodeHint: 0,
    crossings: 0,
    ...overrides,
  });
}

test("cost-based circular routing is enabled by default", () => {
  const chart = new SankeyChart({
    nodes: { data: [] },
    links: { data: [] },
  });
  assert.equal(chart.config.links.costBasedCircularRouting, true);
});

test("circular routing cost chooses the shorter unloaded side", () => {
  assert.ok(cost({ distance: 0.3 }) < cost({ distance: 0.8 }));
});

test("visible thickness can outweigh a shorter detour", () => {
  const shortButBusy = cost({
    distance: 0.3,
    columnLoad: 0.08,
    totalLoad: 0.05,
  });
  const longerButEmpty = cost({ distance: 0.8 });
  assert.ok(longerButEmpty < shortButBusy);
});

test("span=1 detours are penalized strongly but remain soft", () => {
  const localWeight = circularRouteDistanceWeight(1);
  const longWeight = circularRouteDistanceWeight(2);
  assert.ok(localWeight > longWeight);

  const localShortSide = cost({ distance: 0.3 * localWeight });
  const localLongSide = cost({ distance: 0.5 * localWeight });
  assert.ok(localShortSide < localLongSide);

  const localShortButLoaded = cost({
    distance: 0.3 * localWeight,
    columnLoad: 0.1,
  });
  assert.ok(localLongSide < localShortButLoaded);
});

test("crossing risk is deterministic and additive", () => {
  const noCrossing = cost({ distance: 0.6 });
  const oneCrossing = cost({ distance: 0.6, crossings: 1 });
  const twoCrossings = cost({ distance: 0.6, crossings: 2 });
  assert.ok(noCrossing < oneCrossing);
  assert.ok(
    Math.abs(
      (twoCrossings - oneCrossing) -
      (oneCrossing - noCrossing)
    ) < 1e-12
  );
});
