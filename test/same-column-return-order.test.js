const test=require('node:test');
const assert=require('node:assert/strict');
globalThis.self=globalThis;
const {SankeyChart}=require('../dist/sankeyPlus.js');
const {samplePath,minDistance}=require('./helpers/circular-path-geometry.cjs');

// Hand-written topology and arbitrary integer weights: a local return bundle
// must nest consistently at both ends, regardless of its members' thickness.
function fixture(width=900){
 const nodes=[['entry',0,0],['upper',1,0],['middle',1,1],['lower',1,2],['exit',2,0]]
  .map(([name,horizontalSort,verticalSort])=>({name,horizontalSort,verticalSort}));
 const links=[['entry','upper',80],['upper','middle',45],['middle','exit',30],
  ['lower','exit',35],['upper','lower',30],['middle','lower',15]]
  .map(([source,target,value])=>({source,target,value}));
 const chart=new SankeyChart({id:n=>n.name,align:'left',width,height:1000,padding:25,scale:.3,iterations:10,
  nodes:{data:nodes,width:15,padding:25,minPadding:30,virtualPadding:7,horizontalSort:true,verticalSort:true,setPositions:false},
  links:{data:links,circularGap:1,circularLinkPortionTopBottom:1,circularLinkPortionLeftRight:.1,useVirtualRoutes:true,
   baseRadius:5,verticalMargin:100,horizontalMargin:60,virtualLinkType:'bezier',sortIterations:12,postSortIterations:4},
  arrows:{enabled:false}});chart.process();return chart;
}
for(const width of [900,1800])test('same-column return bundles retain full-path clearance at width '+width,()=>{
 const chart=fixture(width),returns=chart.graph.links.filter(l=>l.circular&&!l.isVirtual);
 for(let i=0;i<returns.length;i++)for(let j=i+1;j<returns.length;j++){
  const a=returns[i],b=returns[j];
  // Incoming/outgoing strokes on opposite faces of the same node have butt
  // caps and are masked by the node. Centerline tube distance is not a valid
  // collision measure for those endpoint pairs; check shared-side bundles.
  if(a.source===b.target||a.target===b.source) continue;
  const actual=minDistance(samplePath(a.path,160),samplePath(b.path,160));
  const required=(a.width+b.width)/2;
  assert.ok(actual+.1>=required,`Local returns overlap: ${a.source.name}→${a.target.name} / ${b.source.name}→${b.target.name}; clearance=${actual-required}`);
 }
});
