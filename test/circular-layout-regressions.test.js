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

const {parsePath,arcToCenter,samplePath,minDistance}=require('./helpers/circular-path-geometry.cjs');
function assertRoundRoute(link) {
  const commands=parsePath(link.path),start=commands[0].nums;
  close(start[0],link.source.x1,'A return must leave its source right edge');
  const end=commands.at(-1).nums;
  close(end[0],link.target.x0,'A return must enter its target left edge');
  const unit=v=>{const length=Math.hypot(...v);return length>1e-9?v.map(x=>x/length):null;};
  let x=start[0],y=start[1],previous=null;
  for(const command of commands.slice(1)) {
    let incoming,outgoing,next;
    if(command.cmd==='L') {
      next=command.nums;
      incoming=outgoing=unit([next[0]-x,next[1]-y]);
    } else {
      assert.equal(command.cmd,'A');
      const [rx,ry,rotation,large,sweep,ex,ey]=command.nums;
      const arc=arcToCenter(x,y,rx,ry,rotation,large,sweep,ex,ey);
      assert.ok(Math.abs(arc.dtheta)<=Math.PI/2+1e-5,'A corner must not become an enlarged half-turn');
      const curvature=Math.min(arc.rx**2/arc.ry,arc.ry**2/arc.rx);
      assert.ok(curvature>=link.width/2+5-1e-5,'The inner stroke edge must not fold at a corner');
      const tangent=theta=>unit([
        Math.sign(arc.dtheta)*(-arc.rx*Math.sin(theta)*Math.cos(arc.phi)-arc.ry*Math.cos(theta)*Math.sin(arc.phi)),
        Math.sign(arc.dtheta)*(-arc.rx*Math.sin(theta)*Math.sin(arc.phi)+arc.ry*Math.cos(theta)*Math.cos(arc.phi))]);
      incoming=tangent(arc.theta1);outgoing=tangent(arc.theta1+arc.dtheta);next=[ex,ey];
    }
    if(previous&&incoming) assert.ok(previous[0]*incoming[0]+previous[1]*incoming[1]>=1-1e-5,
      'Adjacent segments must meet tangentially without a reversal or kink');
    if(outgoing) previous=outgoing;
    [x,y]=next;
  }
}
for(const width of [1200,1800,2800]) test(`complete circular routes preserve joins and neighboring clearance: ${width}`,()=>{
  const chart=make(portBridgeGraph(),{width,height:1000,scale:.45});
  const links=chart.graph.links.filter(l=>l.circular&&!l.isVirtual);
  assert.ok(links.length>=5);
  for(const link of links) {
    assertRoundRoute(link);
    for(const other of links.filter(l=>l!==link)) {
      const margin=(link.width+other.width)/2;
      const endpoints=[link.source,link.target,other.source,other.target];
      const outside=p=>endpoints.every(n=>p[0]<n.x0-margin||p[0]>n.x1+margin||p[1]<n.y0-margin||p[1]>n.y1+margin);
      assert.ok(minDistance(samplePath(link.path,160).filter(outside),samplePath(other.path,160).filter(outside))+.3>=margin,
        'Return must clear '+other.source.name+' → '+other.target.name);
    }
    for(const node of chart.graph.nodes.filter(n=>!n.virtual&&n!==link.source&&n!==link.target)) {
      const clearance=Math.min(...samplePath(link.path,160).map(([x,y])=>Math.hypot(
        Math.max(node.x0-x,0,x-node.x1),Math.max(node.y0-y,0,y-node.y1))));
      assert.ok(clearance+.3>=link.width/2,'A return must not cut through another node');
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

for(const separateTarget of [false,true]) for(const width of [1200,1800,2800])
test(`both return bands keep their departure beside the source right edge: ${width}, separate ${separateTarget}`,()=>{
 const chart=make(rightwardMixedSourceGraph(separateTarget),{width,height:1000,scale:.45});
 for(const link of chart.graph.links.filter(l=>l.circular&&!l.isVirtual&&l.source.column>l.target.column)) {
  const points=samplePath(link.path,160),top=link.circularLinkType==='top';
  const shelf=(top?Math.min:Math.max)(...points.map(p=>p[1]));
  const end=points.findIndex(p=>Math.abs(p[1]-shelf)<1e-5);
  assert.ok(end>0);
  assert.ok(points.slice(0,end).every(p=>p[0]>=link.source.x1-1e-5),
   link.source.name+' → '+link.target.name+' must not turn back through its source column before reaching its shelf');
 }
});

// Overlapping source ranges for two stacked targets. The extra returns to
// origin exercise mixed source ordering without using production graph data.
function overlappingTargetFamilies(withSelfLoop = false) {
  const nodes = [
    ['origin', 0, 0], ['upper-target', 1, -1, 'bottom'],
    ['lower-target', 1, -2, 'bottom'], ['step', 2, 0],
    ['early', 3, -1], ['peer', 3, -2], ['middle', 4, 0],
    ['late', 5, 0], ['sink', 6, 0]
  ].map(([name, horizontalSort, verticalSort, circularLinkType]) =>
    ({name, horizontalSort, verticalSort, circularLinkType}));
  const links = [
    ['origin', 'upper-target', 100], ['origin', 'lower-target', 50],
    ['upper-target', 'step', 70], ['lower-target', 'step', 40],
    ['step', 'early', 55], ['step', 'peer', 35],
    ['early', 'middle', 35], ['peer', 'middle', 25],
    ['middle', 'late', 40], ['late', 'sink', 20],
    ['early', 'upper-target', 17], ['peer', 'upper-target', 9],
    ['middle', 'upper-target', 19], ['late', 'lower-target', 7],
    ['early', 'lower-target', 5], ['early', 'origin', 6],
    ['peer', 'origin', 8]
  ].map(([source, target, value]) => ({source, target, value}));
  if (withSelfLoop) {
    // Hold corridor choice fixed to isolate source/frame clearance from the
    // separate route-cost optimizer as the local self-loop load changes.
    links.filter(l => ['upper-target', 'lower-target', 'origin'].includes(l.target))
      .forEach(l => { l._forceCircularLinkType = l.target === 'origin' ? 'top' : 'bottom'; });
    links.push({source: 'peer', target: 'peer', value: 3});
  }
  return {nodes, links};
}
for (const withSelfLoop of [false, true])
for (const width of [1500, 1750, 2700, 4000]) {
  test(`overlapping target families retain complete return clearance at width ${width}, self-loop ${withSelfLoop}`, () => {
    const chart = make(overlappingTargetFamilies(withSelfLoop), {width, height: 1000, scale: 0.45});
    const returns = chart.graph.links.filter(l => l.circular && !l.isVirtual);
    for (const link of returns) {
      assertRoundRoute(link);
      for (const node of chart.graph.nodes.filter(n => !n.virtual && n !== link.source && n !== link.target)) {
        const clearance = Math.min(...samplePath(link.path, 220).map(([x, y]) => Math.hypot(
          Math.max(node.x0 - x, 0, x - node.x1), Math.max(node.y0 - y, 0, y - node.y1))));
        assert.ok(clearance + 0.3 >= link.width / 2,
          `${link.source.name} → ${link.target.name} cuts through ${node.name}`);
      }
    }
    for (let i = 0; i < returns.length; i++) {
      for (const other of returns.slice(i + 1)) {
        const link = returns[i], margin = (link.width + other.width) / 2;
        // No endpoint masks: inspect the complete paths, including target
        // turns and source stubs where a corridor repair can move a collision.
        assert.ok(minDistance(samplePath(link.path, 220), samplePath(other.path, 220)) + 0.3 >= margin,
          `${link.source.name} → ${link.target.name} crosses ${other.source.name} → ${other.target.name}`);
      }
    }
  });
  test(`overlapping target families do not leave vacant target lanes at width ${width}, self-loop ${withSelfLoop}`, () => {
    const chart = make(overlappingTargetFamilies(withSelfLoop), {width, height: 1000, scale: 0.45});
    const bundle = chart.graph.links.filter(l => l.circular && !l.isVirtual && l.target.name === 'upper-target')
      .sort((a, b) => a.circularPathData.targetY - b.circularPathData.targetY);
    assert.equal(new Set(bundle.map(l => l.circularLinkType)).size, 1,
      'Keep the target family together when resolving conflicting source intervals');
    for (let i = 1; i < bundle.length; i++) {
      const a = bundle[i - 1], b = bundle[i];
      const gap = Math.abs(a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent) -
        (a.width + b.width) / 2;
      close(gap, chart.config.links.circularGap, 'Adjacent shelves must have only the configured gap');
    }
  });
}

function sourceFrameGapGraph() {
  const nodes = [
    ['origin', 0, 0], ['upper-target', 1, -1], ['lower-target', 1, -2],
    ['upper', 3, -1], ['lower', 3, -2], ['sink', 4, 0]
  ].map(([name, horizontalSort, verticalSort]) => ({name, horizontalSort, verticalSort}));
  const links = [
    ['origin', 'upper-target', 100], ['origin', 'lower-target', 45],
    ['upper-target', 'upper', 65], ['lower-target', 'lower', 30],
    ['upper', 'sink', 40], ['lower', 'sink', 20],
    ['upper', 'upper-target', 17], ['lower', 'lower-target', 7], ['upper', 'upper', 11]
  ].map(([source, target, value]) => ({source, target, value,
    ...(['upper', 'lower'].includes(source) && ['upper-target', 'lower-target', 'upper'].includes(target)
      ? {_forceCircularLinkType: 'bottom'} : {})}));
  return {nodes, links};
}
for (const width of [1200, 1500, 2000, 4000])
test(`disjoint local frame does not leave an empty right source lane at width ${width}`, () => {
  const chart = make(sourceFrameGapGraph(), {width, height: 1000, scale: 0.45});
  const links = chart.graph.links.filter(l => l.circular && !l.isVirtual);
  const inner = links.find(l => l.source.name === 'lower');
  const outer = links.find(l => l.source.name === 'upper' && l.target.name === 'upper-target');
  const loop = links.find(l => l.source === l.target);
  assert.ok(inner.circularPathData.sourceY > loop.circularPathData.verticalFullExtent +
    (inner.width + loop.width) / 2, 'This local frame must not occupy the inner departure corridor');
  const gap = outer.circularPathData.rightFullExtent - inner.circularPathData.rightFullExtent -
    (inner.width + outer.width) / 2;
  close(gap, chart.config.links.circularGap, 'Reuse the unoccupied source lane beside the outer frame');
  for (const link of links) {
    assertRoundRoute(link);
    for (const other of links.filter(l => l !== link)) {
      assert.ok(minDistance(samplePath(link.path, 220), samplePath(other.path, 220)) + 0.3 >=
        (link.width + other.width) / 2, 'Compaction must preserve complete route and self-loop clearance');
    }
  }
});

function bottomShelfSlotsGraph() {
  // Minimized synthetic topology: removing any edge loses the obsolete-slot
  // regression or its clear bottom-corridor geometry.
  const {nodes} = overlappingTargetFamilies();
  const links = [
    ['origin', 'lower-target', 33], ['upper-target', 'step', 26],
    ['early', 'middle', 25], ['peer', 'middle', 10], ['late', 'sink', 15],
    ['early', 'upper-target', 4], ['peer', 'upper-target', 7],
    ['middle', 'upper-target', 8], ['late', 'lower-target', 32],
    ['early', 'origin', 37], ['peer', 'origin', 22]
  ].map(([source, target, value]) => ({source, target, value,
    ...(['upper-target', 'lower-target', 'origin'].includes(target)
      ? {_forceCircularLinkType: target === 'origin' ? 'top' : 'bottom'} : {})}));
  return {nodes, links};
}

for (const width of [1500, 2000, 2700, 4000])
test(`bottom target turns release vacant shelf slots at width ${width}`, () => {
  const chart = make(bottomShelfSlotsGraph(), {width, height: 1000, scale: 0.45});
  const links = chart.graph.links.filter(l => l.circular && !l.isVirtual && l.circularLinkType === 'bottom');
  const bundle = links.filter(l => l.target.name === 'upper-target')
    .sort((a, b) => a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent);
  assert.equal(bundle.length, 3);
  for (let i = 1; i < bundle.length; i++) {
    const a = bundle[i - 1], b = bundle[i];
    const gap = b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent - (a.width + b.width) / 2;
    close(gap, chart.config.links.circularGap, 'An obsolete target turn slot must not reserve an empty shelf lane');
  }
  const corridor = links.slice().sort((a, b) =>
    a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent);
  let boundaries = 0;
  for (let i = 1; i < corridor.length; i++) {
    const a = corridor[i - 1], b = corridor[i];
    if (a.target === b.target) continue;
    boundaries++;
    close(b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent -
      (a.width + b.width) / 2, chart.config.links.circularGap,
      'A target-node boundary must not retain a vacant turn slot');
  }
  assert.ok(boundaries > 0, 'Exercise stacked target-node bundles in a shared corridor');
  for (const link of links) {
    assertRoundRoute(link);
    for (const node of chart.graph.nodes.filter(n => !n.virtual && n !== link.source && n !== link.target)) {
      const clearance = Math.min(...samplePath(link.path, 220).map(([x, y]) => Math.hypot(
        Math.max(node.x0 - x, 0, x - node.x1), Math.max(node.y0 - y, 0, y - node.y1))));
      assert.ok(clearance + 0.3 >= link.width / 2, 'Compacted bottom routes must retain node-body clearance');
    }
    for (const other of links.filter(l => l !== link))
      assert.ok(minDistance(samplePath(link.path, 220), samplePath(other.path, 220)) + 0.3 >=
        (link.width + other.width) / 2, 'Compacted target corners and complete bottom routes must retain clearance');
  }
});


// Independently authored integer-weight graph: two return destinations in
// neighboring columns, three sources sharing a column, and local cycles.
function neighboringReturnTargets() {
  const nodes = [["origin", -1, 0], ["far", 0, -1], ["near", 1, 0], ["cap", 1, 1], ["turn0", 3, 0], ["turn1", 3, 1], ["turn2", 3, 2], ["sink", 4, 0]].map(([name, horizontalSort, verticalSort]) => ({name, horizontalSort, verticalSort}));
  const links = [["origin", "far", 20], ["origin", "near", 45], ["origin", "cap", 35], ["far", "near", 14], ["near", "cap", 17], ["cap", "near", 15], ["cap", "far", 2], ["near", "far", 3], ["far", "far", 7], ["cap", "cap", 8], ["near", "near", 12], ["far", "turn0", 3], ["near", "turn0", 15], ["cap", "turn0", 9], ["turn0", "sink", 18], ["turn0", "near", 11], ["turn0", "far", 3], ["turn0", "cap", 2], ["far", "turn1", 4], ["near", "turn1", 13], ["cap", "turn1", 10], ["turn1", "sink", 18], ["turn1", "near", 9], ["turn1", "far", 4], ["turn1", "cap", 3], ["far", "turn2", 5], ["near", "turn2", 11], ["cap", "turn2", 11], ["turn2", "sink", 18], ["turn2", "near", 7], ["turn2", "far", 5], ["turn2", "cap", 4]].map(([source, target, value]) => ({source, target, value}));
  return {nodes, links};
}
for (const width of [1500, 1800, 2400]) {
  test('compaction preserves whole return target bundles at width ' + width, () => {
    const data = neighboringReturnTargets();
    const chart = new SankeyChart({
      align: 'left', id: n => n.name, width, height: 1000, scale: 0.3,
      iterations: 10, padding: 25,
      nodes: {data: data.nodes, width: 15, padding: 25, minPadding: 30,
        virtualPadding: 7, horizontalSort: true, verticalSort: true},
      links: {data: data.links, circularGap: 1, baseRadius: 5, verticalMargin: 100,
        sortIterations: 12, postSortIterations: 4},
      arrows: {enabled: false}
    });
    chart.process();
    const returns = chart.graph.links.filter(l => l.circular && !l.isVirtual &&
      l.circularLinkType === 'bottom' && l.source.name.startsWith('turn') &&
      ['near', 'far'].includes(l.target.name));
    assert.equal(returns.length, 6);
    const nearEdge = Math.max(...returns.filter(l => l.target.name === 'near')
      .map(l => l.circularPathData.verticalFullExtent + l.width / 2));
    const farEdge = Math.min(...returns.filter(l => l.target.name === 'far')
      .map(l => l.circularPathData.verticalFullExtent - l.width / 2));
    assert.ok(farEdge - nearEdge >= 1 - 1e-6,
      'A farther target bundle must follow the entire nearer target bundle');
    for (const group of ['near', 'far'].map(name => returns.filter(l => l.target.name === name))) {
      for (const coordinate of ['verticalFullExtent', 'rightFullExtent']) {
        group.sort((a, b) => a.circularPathData[coordinate] - b.circularPathData[coordinate]);
        for (let i = 1; i < group.length; i++) {
          const a = group[i - 1], b = group[i];
          const gap = b.circularPathData[coordinate] - a.circularPathData[coordinate] - (a.width + b.width) / 2;
          close(gap, 1, 'Compaction must remove unused shelf and right-leg slots');
        }
      }
      for (const link of group) assertRoundRoute(link);
      for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        assert.ok(minDistance(samplePath(a.path, 220), samplePath(b.path, 220)) + 0.3 >=
          (a.width + b.width) / 2, 'Packing a target bundle must preserve complete-route clearance');
      }
    }
    const centers = returns.map(link => ({
      x: link.circularPathData.rightFullExtent - link.circularPathData.rightLargeArcRadius,
      y: link.circularPathData.verticalFullExtent - link.circularPathData.rightLargeArcRadius
    }));
    for (const center of centers) {
      close(center.x, centers[0].x, 'Adjacent target bundles must share their source-side bend center');
      close(center.y, centers[0].y, 'Adjacent target bundles must form concentric source-side turns');
    }
    for (const link of returns) assert.ok(!/NaN|Infinity/.test(link.path));
  });
}


test('staggered bundle consolidation keeps internal spacing, bend radii and nodes intact', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/returnBundleGroups.js'), 'utf8');
  const {preserveReturnBundleGroups} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const origin = {column: 4, x0: 300, x1: 315, y0: 10, y1: 50};
  const near = {column: 2}, far = {column: 1};
  const makeLink = (target, shelf) => ({source: origin, target, circular: true,
    circularLinkType: 'bottom', width: 4,
    circularPathData: {verticalFullExtent: shelf, verticalRightInnerExtent: shelf - 8,
      verticalLeftInnerExtent: shelf - 6, verticalBuffer: 5,
      rightLargeArcRadius: 8, leftLargeArcRadius: 6, sourceX: shelf, rightFullExtent: shelf + 10}});
  const links = [makeLink(near, 100), makeLink(far, 110), makeLink(near, 120), makeLink(far, 130)];
  const before = structuredClone(links), nodeBefore = {...origin};
  preserveReturnBundleGroups({links}, 1);
  close(links[3].circularPathData.verticalFullExtent - links[1].circularPathData.verticalFullExtent, 20);
  for (let i = 0; i < links.length; i++) {
    const old = before[i].circularPathData, now = links[i].circularPathData;
    close(now.verticalFullExtent - now.verticalRightInnerExtent, old.verticalFullExtent - old.verticalRightInnerExtent);
    close(now.verticalFullExtent - now.verticalLeftInnerExtent, old.verticalFullExtent - old.verticalLeftInnerExtent);
    close(now.leftLargeArcRadius, old.leftLargeArcRadius); close(now.rightLargeArcRadius, old.rightLargeArcRadius);
  }
  assert.deepEqual(origin, nodeBefore);
  const once = JSON.stringify(links); preserveReturnBundleGroups({links}, 1);
  assert.equal(JSON.stringify(links), once, 'Repeated finalization must be stable');
});


function topReturnShelfGraph() {
  // Small independent integer-weight cycle with a same-column arrival and
  // two later-column arrivals. A neighboring branch tightens the target turns.
  const nodes = [['origin', 0, 0], ['target', 1, 2], ['local', 1, 0],
    ['cap', 1, -1], ['turn0', 2, 0], ['turn1', 2, 1], ['turn2', 2, 2], ['sink', 3, 0]]
    .map(([name, horizontalSort, verticalSort]) => ({name, horizontalSort, verticalSort}));
  const links = [['origin', 'local', 25], ['target', 'turn2', 30],
    ['local', 'target', 9], ['cap', 'cap', 7], ['local', 'cap', 3],
    ['cap', 'turn1', 9], ['turn0', 'sink', 15],
    ['turn1', 'target', 7], ['turn2', 'target', 11]]
    .map(([source, target, value]) => ({source, target, value,
      ...(target === 'target' || source === target ? {_forceCircularLinkType: 'top'} : {})}));
  return {nodes, links};
}
for (const width of [1200, 1500, 2000]) test('top return shelves count their gap once at width ' + width, () => {
  const data = topReturnShelfGraph();
  const chart = new SankeyChart({id: n => n.name, align: 'left', width, height: 1000,
    padding: 25, scale: 0.1, iterations: 10,
    nodes: {data: data.nodes, width: 15, padding: 25, minPadding: 30,
      virtualPadding: 7, horizontalSort: true, verticalSort: true},
    links: {data: data.links, circularGap: 1, baseRadius: 5, verticalMargin: 100,
      sortIterations: 12, postSortIterations: 4}, arrows: {enabled: false}});
  chart.process();
  const group = chart.graph.links.filter(l => l.circular && !l.isVirtual && l.target.name === 'target')
    .sort((a, b) => b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent);
  assert.equal(group.length, 3);
  assert.ok(group.every(l => l.width > 1), 'Exercise visible strokes');
  assert.equal(group[0].source.column, group[0].target.column, 'Include the local inner return');
  for (let i = 1; i < group.length; i++) {
    const a = group[i - 1], b = group[i];
    close(a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent -
      (a.width + b.width) / 2, 1, 'Top shelves must not count the turn clearance twice');
  }
  for (const link of group) {
    const c = link.circularPathData;
    assert.ok(c.verticalLeftInnerExtent <= c.targetY - c.leftSmallArcRadius + 1e-6,
      'Tightening must not fold the target leg');
    for (const other of group.filter(l => l !== link))
      assert.ok(minDistance(samplePath(link.path, 220), samplePath(other.path, 220)) + 0.3 >=
        (link.width + other.width) / 2, 'Compacted top return curves must remain separate');
  }
});


for (const width of [1200, 1500, 2000]) test('top bundle boundaries follow tightened inner shelves at width ' + width, () => {
  const data = topReturnShelfGraph();
  data.links = data.links.filter(l => !(l.source === 'local' && l.target === 'cap'));
  data.links.push({source: 'target', target: 'local', value: 13, _forceCircularLinkType: 'top'});
  const chart = new SankeyChart({id: n => n.name, align: 'left', width, height: 1000,
    padding: 25, scale: 0.1, iterations: 10,
    nodes: {data: data.nodes, width: 15, padding: 25, minPadding: 30,
      virtualPadding: 7, horizontalSort: true, verticalSort: true},
    links: {data: data.links, circularGap: 1, baseRadius: 5, verticalMargin: 100,
      sortIterations: 12, postSortIterations: 4}, arrows: {enabled: false}});
  chart.process();
  const returns = chart.graph.links.filter(l => l.circular && !l.isVirtual &&
    l.circularLinkType === 'top' && l.source !== l.target);
  const inner = returns.filter(l => l.target.name === 'target')
    .sort((a, b) => a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent)[0];
  const outer = returns.find(l => l.source.name === 'target' && l.target.name === 'local');
  close(inner.circularPathData.verticalFullExtent - outer.circularPathData.verticalFullExtent -
    (inner.width + outer.width) / 2, 1, 'Neighboring target bundles must follow an inward shelf move');
  close(inner.circularPathData.verticalLeftInnerExtent, outer.circularPathData.verticalLeftInnerExtent,
    'Neighboring target bundles must retain a common shelf bend center');
  for (const link of returns) {
    const c = link.circularPathData;
    assert.ok(c.verticalLeftInnerExtent <= c.targetY - c.leftSmallArcRadius + 1e-6);
    assert.ok(c.verticalRightInnerExtent <= c.sourceY - c.rightSmallArcRadius + 1e-6);
    for (const other of returns.filter(l => l !== link))
      assert.ok(minDistance(
        samplePath(link.path, 220).filter(([x]) => x <= link.target.x0),
        samplePath(other.path, 220).filter(([x]) => x <= other.target.x0)) + 0.3 >=
        (link.width + other.width) / 2, 'The complete target turns must remain separate across bundle boundaries');
  }
});

for (const width of [1200, 1500, 2000]) test('top shelf moves propagate through target bundles in earlier columns at width ' + width, () => {
  const data = topReturnShelfGraph();
  data.nodes.find(n => n.name === 'origin').horizontalSort = -1;
  data.nodes.push({name: 'earlier', horizontalSort: 0, verticalSort: 0});
  data.links = data.links.filter(l => !(l.source === 'local' && l.target === 'cap'));
  data.links.push({source: 'origin', target: 'earlier', value: 18},
    {source: 'earlier', target: 'target', value: 14},
    {source: 'target', target: 'local', value: 13, _forceCircularLinkType: 'top'},
    {source: 'local', target: 'earlier', value: 5, _forceCircularLinkType: 'top'},
    {source: 'target', target: 'earlier', value: 3, _forceCircularLinkType: 'top'});
  const chart = new SankeyChart({id: n => n.name, align: 'left', width, height: 1000,
    padding: 25, scale: 0.1, iterations: 10,
    nodes: {data: data.nodes, width: 15, padding: 25, minPadding: 30,
      virtualPadding: 7, horizontalSort: true, verticalSort: true},
    links: {data: data.links, circularGap: 1, baseRadius: 5, verticalMargin: 100,
      sortIterations: 12, postSortIterations: 4}, arrows: {enabled: false}});
  chart.process();
  const returns = chart.graph.links.filter(l => l.circular && !l.isVirtual &&
    l.circularLinkType === 'top' && l.source !== l.target)
    .sort((a, b) => b.circularPathData.verticalFullExtent - a.circularPathData.verticalFullExtent);
  assert.equal(returns.length, 6);
  assert.equal(new Set(returns.map(l => l.target)).size, 3, 'Exercise a chain of three whole target bundles');
  assert.equal(new Set(returns.map(l => l.target.column)).size, 2, 'Propagate beyond the previous target column');
  for (let i = 1; i < returns.length; i++) {
    const a = returns[i - 1], b = returns[i];
    close(a.circularPathData.verticalFullExtent - b.circularPathData.verticalFullExtent -
      (a.width + b.width) / 2, 1, 'No obsolete shelf slot may remain anywhere in the bundle chain');
  }
  const earlier = returns.filter(l => l.target.name === 'earlier');
  assert.equal(earlier.length, 2);
  for (const link of returns) {
    const c = link.circularPathData;
    assert.ok(c.verticalLeftInnerExtent <= c.targetY - c.leftSmallArcRadius + 1e-6, 'Target leg must not fold');
    assert.ok(c.verticalRightInnerExtent <= c.sourceY - c.rightSmallArcRadius + 1e-6, 'Source leg must not fold');
    assert.ok(!/NaN|Infinity/.test(link.path));
  }
  assert.ok(minDistance(samplePath(earlier[0].path, 220), samplePath(earlier[1].path, 220)) + 0.3 >=
    (earlier[0].width + earlier[1].width) / 2, 'Moving a whole earlier-column bundle must retain its full-route clearance');
});

for (const width of [1500, 1800, 2400]) test('top return source legs keep target families together at width ' + width, () => {
  const data = neighboringReturnTargets();
  for (const link of data.links)
    if (link.source.startsWith('turn') && ['near', 'cap'].includes(link.target))
      link._forceCircularLinkType = 'top';
  const chart = new SankeyChart({id: n => n.name, align: 'left', width, height: 1000,
    padding: 25, scale: 0.3, iterations: 10,
    nodes: {data: data.nodes, width: 15, padding: 25, minPadding: 30,
      virtualPadding: 7, horizontalSort: true, verticalSort: true},
    links: {data: data.links, circularGap: 1, baseRadius: 5, verticalMargin: 100,
      sortIterations: 12, postSortIterations: 4}, arrows: {enabled: false}});
  chart.process();
  const returns = chart.graph.links.filter(l => l.circular && !l.isVirtual &&
    l.circularLinkType === 'top' && l.source.name.startsWith('turn'))
    .sort((a, b) => a.circularPathData.rightFullExtent - b.circularPathData.rightFullExtent);
  assert.equal(returns.length, 6);
  const runs = returns.filter((l, i) => i === 0 || l.target !== returns[i - 1].target);
  assert.equal(runs.length, 2, 'Per-node source passes must not interleave whole target families');
  for (let i = 1; i < returns.length; i++) {
    const a = returns[i - 1], b = returns[i];
    close(b.circularPathData.rightFullExtent - a.circularPathData.rightFullExtent -
      (a.width + b.width) / 2, 1, 'No empty right-leg slot may remain inside or between families');
  }
  for (const link of returns) {
    const c = link.circularPathData;
    assert.ok(c.rightDepartureInnerExtent >= c.sourceX, 'A compacted return must leave the right side of its source');
    assertRoundRoute(link);
    assert.ok(c.verticalRightInnerExtent <= c.sourceY - c.rightSmallArcRadius + 1e-6);
    for (const other of returns.filter(l => l !== link && l.target === link.target))
      assert.ok(minDistance(samplePath(link.path, 220), samplePath(other.path, 220)) + 0.3 >=
        (link.width + other.width) / 2, 'Full routes inside a packed source family must remain separate');
  }
});

for (const width of [1200, 1500, 2000]) test('pinched top arrivals reserve height for round turns at width ' + width, () => {
  const data = topReturnShelfGraph();
  data.links = data.links.filter(l => !(l.source === 'local' && l.target === 'cap'));
  data.links.push({source: 'target', target: 'local', value: 13, _forceCircularLinkType: 'top'});
  const chart = new SankeyChart({id: n => n.name, align: 'left', width, height: 1000,
    padding: 25, scale: 0.005, iterations: 10,
    nodes: {data: data.nodes, width: 15, padding: 25, minPadding: 30,
      virtualPadding: 7, horizontalSort: true, verticalSort: true},
    links: {data: data.links, circularGap: 1, baseRadius: 5, verticalMargin: 100,
      sortIterations: 12, postSortIterations: 4}, arrows: {enabled: false}});
  chart.process();
  const group = chart.graph.links.filter(l => l.circular && !l.isVirtual && l.target.name === 'target');
  assert.equal(group.length, 3);
  for (const link of group) {
    const c = link.circularPathData;
    assert.ok(link.width > 0, 'Exercise real positive-width strokes');
    close(c.leftSmallArcRadius, c.leftLargeArcRadius, 'Reserve shelf height instead of flattening the arrival arc');
    assert.ok(c.verticalLeftInnerExtent <= c.targetY - c.leftSmallArcRadius + 1e-6, 'Round arrivals need a nonnegative target leg');
    for (const other of group.filter(l => l !== link))
      assert.ok(minDistance(samplePath(link.path, 220), samplePath(other.path, 220)) + 0.3 >=
        (link.width + other.width) / 2, 'Rounding a pinched family must retain full-route clearance');
  }
});

for (const width of [1200, 1800, 2400]) for (const mirrored of [false, true])
test(`return source leg clears a foreign opposite-band self-loop at width ${width}, mirrored ${mirrored}`, () => {
  // Independently chosen integer weights. The extra local loop is important:
  // its source-slot compaction previously discarded another loop's clearance.
  const nodes = [['upper', 0, 2], ['lower', 0, 1], ['anchor', 0, 0], ['sink', 1, 0]]
    .map(([name, horizontalSort, verticalSort]) => ({name, horizontalSort,
      verticalSort: mirrored ? -verticalSort : verticalSort}));
  const side = band => mirrored ? (band === 'top' ? 'bottom' : 'top') : band;
  const links = [['upper', 'upper', 7], ['upper', 'sink', 29],
    ['anchor', 'anchor', 13], ['lower', 'upper', 5],
    ['lower', 'lower', 11], ['lower', 'sink', 17]]
    .map(([source, target, value]) => ({source, target, value,
      ...(source === target ? {_forceCircularLinkType: side(source === 'anchor' ? 'top' : 'bottom')} :
        source === 'lower' && target === 'upper' ? {_forceCircularLinkType: side('top')} : {})}));
  const chart = new SankeyChart({id: n => n.name, align: 'left', width, height: 1000,
    padding: 25, scale: 0.3, iterations: 10,
    nodes: {data: nodes, width: 15, padding: 25, minPadding: 30,
      virtualPadding: 7, horizontalSort: true, verticalSort: true},
    links: {data: links, circularGap: 1, baseRadius: 5, verticalMargin: 100,
      sortIterations: 12, postSortIterations: 4}, arrows: {enabled: false}});
  chart.process();
  const arrival = chart.graph.links.find(l => l.source.name === 'lower' && l.target.name === 'upper');
  const loop = chart.graph.links.find(l => l.source.name === 'upper' && l.source === l.target);
  assert.equal(arrival.circularLinkType, side('top'));
  assert.equal(loop.circularLinkType, side('bottom'));
  // Inspect the complete strokes, including the neighborhood of the shared
  // target. Masking shared node ports hid precisely this regression.
  assert.ok(minDistance(samplePath(arrival.path, 240), samplePath(loop.path, 240)) + 0.15 >=
    (arrival.width + loop.width) / 2, 'The return leg overlaps a self-loop belonging to another source node');
  assertRoundRoute(arrival);
  assertRoundRoute(loop);
});
