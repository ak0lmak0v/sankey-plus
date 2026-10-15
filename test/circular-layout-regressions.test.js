const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

globalThis.self = globalThis;
const {SankeyChart} = require('../dist/sankeyPlus.js');
let positionColumns;
test.before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/columnSpacing.js'), 'utf8');
  ({positionColumns} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')));
});

// Hand-written graphs with arbitrary integer weights. No production events,
// session totals, observed transition frequencies, or customer datasets.
function graph(kind = 'shared-target') {
  const nodes = [
    ['origin', 0, 0], ['target', 1, 0], ['step', 2, 0],
    ['upper', 3, -1], ['lower', 3, -2], ['sink', 4, 0]
  ].map(([name, horizontalSort, verticalSort]) => ({name, horizontalSort, verticalSort}));
  const links = [
    ['origin', 'target', 80], ['target', 'step', 60],
    ['step', 'upper', 40], ['step', 'lower', 20],
    ['upper', 'sink', 30], ['lower', 'sink', 10]
  ];
  if (kind === 'shared-target') {
    nodes.find(n => n.name === 'target').circularLinkType = 'top';
    links.push(['upper', 'target', 10], ['lower', 'target', 8]);
  } else if (kind === 'local-loops') {
    links.push(['upper', 'upper', 6], ['lower', 'upper', 4], ['upper', 'target', 10]);
  } else if (kind === 'interleaved') {
    links.push(['upper', 'origin', 12], ['sink', 'step', 8]);
  } else if (kind === 'mixed-sources') {
    nodes.find(n => n.name === 'target').circularLinkType = 'top';
    nodes.find(n => n.name === 'step').circularLinkType = 'bottom';
    links.push(['upper', 'target', 12], ['lower', 'step', 8]);
  } else if (kind === 'virtual-routes') {
    links.push(['origin', 'sink', 10], ['upper', 'target', 6]);
  }
  return {nodes, links: links.map(([source, target, value]) => ({source, target, value}))};
}
function make(data, options = {}) {
  const chart = new SankeyChart({
    id: n => n.name, align: 'left', width: options.width ?? 1600, height: options.height ?? 800,
    padding: 40, scale: options.scale ?? 0.4, iterations: 10,
    nodes: {
      data: structuredClone(data.nodes), width: 15, padding: 25, minPadding: 30,
      virtualPadding: 7, horizontalSort: true, verticalSort: true,
      circularSourceOrdering: options.repair ?? true,
      adaptiveColumnSpacing: options.adaptive ?? true,
      adaptiveColumnSpacingStrength: 0.25
    },
    links: {
      data: structuredClone(data.links), circularGap: 1, baseRadius: 5,
      useVirtualRoutes: true, virtualLinkType: 'bezier',
      sortIterations: 12, postSortIterations: 4
    },
    arrows: {enabled: false}
  });
  chart.process();
  return chart;
}
function columns() {
  const nodes = Array.from({length: 5}, (_, column) => ({column}));
  return {x0: 40, x1: 1240, nodes, links: []};
}
function steps(g) { return g.nodes.slice(1).map((n, i) => n.x0 - g.nodes[i].x0); }
function close(a, b, message) { assert.ok(Math.abs(a - b) < 1e-6, message); }

test('adaptive spacing gives busy turn gaps room without changing the extent', () => {
  const g = columns();
  g.links.push({source: g.nodes[3], target: g.nodes[1], width: 40, circular: true});
  positionColumns(g, 15, {adaptive: true, gap: 1, radius: 5});
  const gaps = steps(g);
  assert.ok(gaps[0] > gaps[1] && gaps[3] > gaps[2]);
  close(gaps[1], gaps[2], 'Straight shelves must not load intermediate gaps');
  close(g.nodes[0].x0, g.x0); close(g.nodes.at(-1).x1, g.x1);
});
test('zero strength and forward-only graphs retain uniform column spacing', () => {
  for (const options of [{adaptive: false}, {adaptive: true, strength: 0}, {adaptive: true}]) {
    const g = columns();
    if ('strength' in options) g.links.push({source: g.nodes[3], target: g.nodes[1], width: 40, circular: true});
    else g.links.push({source: g.nodes[1], target: g.nodes[3], width: 40, circular: false});
    positionColumns(g, 15, options);
    steps(g).forEach(step => close(step, (g.x1 - g.x0 - 15) / 4));
  }
});
test('wide and multiple return turns add more gap demand', () => {
  const gapFor = widths => {
    const g = columns();
    g.links = widths.map(width => ({source: g.nodes[3], target: g.nodes[1], width, circular: true}));
    positionColumns(g, 15, {adaptive: true, gap: 1, radius: 5});
    return steps(g)[0];
  };
  assert.ok(gapFor([40]) > gapFor([5]));
  assert.ok(gapFor([5, 5]) > gapFor([5]));
});
test('single-column and narrow graphs keep finite node extents', () => {
  for (const g of [{x0: 40, x1: 200, nodes: [{column: 0}], links: []}, {...columns(), x1: 90}]) {
    positionColumns(g, 15, {adaptive: true});
    g.nodes.forEach(n => { assert.ok(Number.isFinite(n.x0)); close(n.x1 - n.x0, 15); });
  }
});
test('source repair and adaptive spacing remain opt-in', () => {
  const chart = new SankeyChart({nodes: {data: []}, links: {data: []}});
  assert.equal(chart.config.nodes.circularSourceOrdering, false);
  assert.equal(chart.config.nodes.adaptiveColumnSpacing, false);
  const plain = make(graph('mixed-sources'), {repair: false});
  const upper = plain.graph.nodes.find(n => n.name === 'upper');
  const lower = plain.graph.nodes.find(n => n.name === 'lower');
  close(upper.x0, lower.x0, 'Default source columns must stay aligned');
  assert.equal(lower._insetTopSource, undefined);
});

for (const kind of ['shared-target', 'local-loops', 'interleaved', 'mixed-sources', 'virtual-routes']) {
  for (const width of [1200, 1800, 2800]) {
    test(`synthetic ${kind}: stable ports and finite paths at width ${width}`, () => {
      const data = graph(kind), untouched = structuredClone(data);
      const chart = make(data, {width});
      assert.deepEqual(data, untouched, 'Processing must not mutate caller data');
      for (const node of chart.graph.nodes) {
        assert.ok([node.x0, node.x1, node.y0, node.y1].every(Number.isFinite));
        assert.ok(node.y1 >= node.y0); close(node.x1 - node.x0, 15);
      }
      for (const link of chart.graph.links) {
        assert.ok(Number.isFinite(link.width) && link.width > 0);
        assert.ok(link.path && !/NaN|Infinity/.test(link.path));
        if (!link.circular || link.source.column <= link.target.column) continue;
        const c = link.circularPathData;
        const start = link.path.match(/^M([-+\d.e]+)[ ,]([-+\d.e]+)/i);
        close(Number(start[1]), link.source.x1);
        close(Number(start[2]), c.sourceY);
        const sign = link.circularLinkType === 'top' ? 1 : -1;
        assert.ok(sign * (c.targetY - c.leftSmallArcRadius * sign - c.verticalLeftInnerExtent) >= -1e-5,
          'Target-side straight segments must not reverse');
        if (!c.mirroredSourceRadius) {
          assert.ok(c.rightFullExtent >= link.source.x1);
          assert.ok(c.rightSmallArcRadius >= link.width / 2 + 5 - 1e-5,
            'The source bend must leave room for the inner stroke edge');
        }
      }
      const again = make(data, {width});
      assert.deepEqual(again.graph.links.map(l => l.path), chart.graph.links.map(l => l.path), 'Routing must be deterministic');
    });
  }
}
for (const width of [1200, 1800, 2800]) test(`shared synthetic target turns preserve shelf and lane order: ${width}`, () => {
  const chart = make(graph(), {width});
  const bundle = chart.graph.links.filter(l => l.circular && l.target.name === 'target')
    .sort((a, b) => a.circularPathData.targetY - b.circularPathData.targetY);
  assert.equal(bundle.length, 2);
  assert.ok(bundle.every(l => l.circularLinkType === 'top'));
  const [a, b] = bundle, ac = a.circularPathData, bc = b.circularPathData;
  const margin = (a.width + b.width) / 2 + 1;
  assert.ok(ac.leftFullExtent - bc.leftFullExtent >= margin - 1e-5);
  assert.ok(ac.verticalFullExtent - bc.verticalFullExtent >= margin - 1e-5);
  close(ac.verticalLeftInnerExtent, bc.verticalLeftInnerExtent, 'Nested shelf bends must keep a common center');
});

function portBridgeGraph() {
  const nodes = [
    ['origin', 0, 0], ['target-top', 1, 0, 'top'], ['target-bottom', 2, 0, 'bottom'],
    ['upper', 3, -1], ['lower', 3, -2], ['sink', 4, 0]
  ].map(([name, horizontalSort, verticalSort, circularLinkType]) =>
    ({name, horizontalSort, verticalSort, circularLinkType}));
  const links = [
    ['origin', 'target-top', 80], ['target-top', 'target-bottom', 60],
    ['target-bottom', 'upper', 40], ['upper', 'lower', 30],
    ['upper', 'sink', 20], ['lower', 'sink', 20],
    ['upper', 'target-top', 12], ['lower', 'target-top', 8],
    ['upper', 'target-bottom', 5], ['lower', 'target-bottom', 6],
    ['upper', 'upper', 9], ['lower', 'lower', 7]
  ].map(([source, target, value]) => ({source, target, value}));
  return {nodes, links};
}
for (const width of [1200, 1800, 2800]) test(`same-column link beside upward returns preserves endpoint sides: ${width}`, () => {
  const chart = make(portBridgeGraph(), {width, height: 1000, scale: 0.45});
  const link = chart.graph.links.find(l => l.source.name === 'upper' && l.target.name === 'lower');
  assert.ok(link.circular, 'Exercise the same-column return corridor');
  const points = [...link.path.matchAll(/([MLA])([^MLA]*)/g)]
    .map(p => ({command:p[1],values:p[2].trim().split(/[ ,]+/).map(Number)}));
  close(points[0].values[0], link.source.x1, 'A separate-node connection must depart from the source right edge');
  close(points.at(-1).values[0], link.target.x0, 'The connection must enter the target left edge');
  for(const arc of points.filter(p => p.command === 'A')) {
    assert.ok(arc.values[0] >= link.width/2+5-1e-5, 'Rounded turns must preserve their inner stroke edge');
    close(arc.values[0],arc.values[1],'Local turns must remain circular');
  }
});

for (const width of [1200,1800,2800]) test(`shared bottom targets never reverse an upward source port: ${width}`, () => {
  const chart=make(portBridgeGraph(), {width,height:1000,scale:0.45});
  const topReturns=chart.graph.links.filter(l=>l.circular&&l.source.column>l.target.column&&l.circularLinkType==='top');
  assert.ok(topReturns.length>=2);
  for(const link of topReturns) {
    const x=Number(link.path.match(/^M([-+\d.e]+)/i)[1]);
    close(x,link.source.x1,'Top returns must leave the right source edge even with shared bottom targets');
    assert.equal(link.circularPathData.mirroredSourceRadius,undefined);
  }
});

const {parsePath,samplePath,minDistance}=require('./helpers/circular-path-geometry.cjs');
for(const width of [1200,1800,2800]) test(`source wraps preserve round bends and neighboring loop clearance: ${width}`, () => {
  const chart=make(portBridgeGraph(),{width,height:1000,scale:0.45});
  const local=chart.graph.links.find(l=>l.source.name==='upper'&&l.target.name==='lower');
  const wrapped=chart.graph.links.filter(l=>l.circularPathData?.sourcePortWrap);
  assert.ok(wrapped.length,'Exercise a formerly reversed top departure');
  for(const link of wrapped) {
    const c=link.circularPathData,w=c.sourcePortWrap,sign=link.circularLinkType==='bottom'?-1:1;
    close(parsePath(link.path)[0].nums[0],link.source.x1);
    for(const r of [w.departureRadius,w.rightRadius,w.leftRadius,w.shelfRadius])
      assert.ok(r>=link.width/2+5-1e-5,'Every source wrap must preserve its inner stroke edge');
    assert.ok(sign*(c.sourceY-w.y)>=w.rightRadius+w.departureRadius-1e-5,'Right source leg must not reverse');
    assert.ok(sign*(w.y-c.verticalFullExtent)>=w.leftRadius+w.shelfRadius-1e-5,'Left source leg must not reverse');
    for(const other of chart.graph.links.filter(l=>l.circular&&!l.isVirtual&&l!==link)) {
      const margin=(link.width+other.width)/2;
      // Endpoint sides and bend bounds are asserted separately. Compare the
      // external corridors, where round-distance clearance is conservative;
      // at a butt cap it would incorrectly treat a horizontal port as a disk.
      const endpoints=[link.source,link.target,other.source,other.target];
      const outside=p=>endpoints.every(n=>p[0]<n.x0-margin||p[0]>n.x1+margin||p[1]<n.y0-margin||p[1]>n.y1+margin);
      const distance=minDistance(samplePath(link.path,160).filter(outside),samplePath(other.path,160).filter(outside));
      assert.ok(distance+.3>=margin,'Source wrap must clear '+other.source.name+' → '+other.target.name);
    }
  }
});

function rightwardMixedSourceGraph(separateTarget=false) {
  const nodes=[['origin',0,0],['early-top',1,-1,'top'],['early-bottom',1,-2,'bottom'],
    ['upper',3,-1],['middle',3,-2],['lower',3,-3],['sink',4,0]]
    .map(([name,horizontalSort,verticalSort,circularLinkType])=>({name,horizontalSort,verticalSort,circularLinkType}));
  const links=[['origin','early-top',90],['early-top','early-bottom',70],
    ['early-bottom','upper',30],['early-bottom','middle',20],['early-bottom','lower',25],
    ['upper','sink',20],['middle','sink',15],['lower','sink',18],
    ['upper','early-top',9],['lower','early-top',11],
    ['upper','early-bottom',8],['middle','early-bottom',6],['lower','early-bottom',7]]
    .map(([source,target,value])=>({source,target,value}));
  if(separateTarget) {
    nodes.push({name:'alternate',horizontalSort:2,verticalSort:-1,circularLinkType:'bottom'});
    links.find(l=>l.source==='middle'&&l.target==='early-bottom').target='alternate';
    links.push({source:'origin',target:'alternate',value:19});
  }
  return {nodes,links};
}
for(const separateTarget of [false,true])
for(const width of [1200,1800,2800]) test(`upward returns bypass earlier source nodes on the right: ${width}, separate target ${separateTarget}`,()=>{
  const chart=make(rightwardMixedSourceGraph(separateTarget),{width,height:1000,scale:.45});
  const link=chart.graph.links.find(l=>l.source.name==='lower'&&l.target.name==='early-top');
  assert.equal(link.circularLinkType,'top');
  const c=link.circularPathData,points=samplePath(link.path,120);
  const shelf=points.findIndex(p=>Math.abs(p[1]-c.verticalFullExtent)<1e-5);
  assert.ok(shelf>0);
  assert.ok(points.slice(0,shelf).every(p=>p[0]>=link.source.x1-1e-5),
    'The upward departure must remain on the right of earlier source nodes');
  const circular=chart.graph.links.filter(l=>l.circular&&!l.isVirtual);
  for(let i=0;i<circular.length;i++) for(let j=i+1;j<circular.length;j++) {
    const a=circular[i],b=circular[j],margin=(a.width+b.width)/2;
    const endpoints=[a.source,a.target,b.source,b.target];
    const outside=p=>endpoints.every(n=>p[0]<n.x0-margin||p[0]>n.x1+margin||p[1]<n.y0-margin||p[1]>n.y1+margin);
    assert.ok(minDistance(samplePath(a.path,100).filter(outside),samplePath(b.path,100).filter(outside))+.3>=margin,
      'Reassigning source corridors must preserve neighboring return clearance: '+a.source.name+' / '+b.source.name);
  }
});
