const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
let clone;
test.before(async()=> {
 const source=fs.readFileSync(path.join(__dirname,'../src/clone.js'),'utf8');
 ({clone}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')));
});
test('cloning a cyclic graph preserves shared node and link identities',()=> {
 const a={name:'a',sourceLinks:[],targetLinks:[]},b={name:'b',sourceLinks:[],targetLinks:[]};
 const link={source:a,target:b,value:3};a.sourceLinks.push(link);b.targetLinks.push(link);
 const graph={nodes:[a,b],links:[link],aliases:[a,link,a]};const copy=clone(graph);
 assert.notEqual(copy.nodes[0],a);assert.notEqual(copy.links[0],link);
 assert.equal(copy.links[0].source,copy.nodes[0]);assert.equal(copy.nodes[0].sourceLinks[0],copy.links[0]);
 assert.equal(copy.links[0].target,copy.nodes[1]);assert.equal(copy.nodes[1].targetLinks[0],copy.links[0]);
 assert.equal(copy.aliases[0],copy.nodes[0]);assert.equal(copy.aliases[1],copy.links[0]);assert.equal(copy.aliases[2],copy.nodes[0]);
 copy.nodes[0].name='changed';assert.equal(a.name,'a');
});
test('repeated graph aliases are inspected only once',()=> {
 let inspections=0;
 const shared=new Proxy({value:7},{getPrototypeOf(target){inspections++;return Reflect.getPrototypeOf(target);}});
 const copy=clone(Array(1000).fill(shared));
 assert.ok(copy.every(item=>item===copy[0]));
 assert.ok(inspections<=20,`Repeated references caused ${inspections} prototype inspections`);
});
test('clone preserves collection cycles, metadata, and depth limits',()=> {
 const shared={n:1},map=new Map(),set=new Set();map.set(shared,set);set.add(map);set.add(shared);
 const stamp=new Date(1700000000000),pattern=/ab/gi;pattern.lastIndex=2;
 const key=Symbol('metadata');const value={map,set,shared,stamp,pattern};value[key]=shared;
 Object.defineProperty(value,'hidden',{value:shared,enumerable:false});
 const copy=clone(value,{includeNonEnumerable:true});
 assert.equal(copy.map.get(copy.shared),copy.set);assert.ok(copy.set.has(copy.map));assert.ok(copy.set.has(copy.shared));
 assert.deepEqual(copy[key],shared);assert.deepEqual(copy.hidden,shared);
 assert.equal(Object.getOwnPropertyDescriptor(copy,'hidden').enumerable,false);
 assert.equal(+copy.stamp,+stamp);assert.equal(copy.pattern.source,pattern.source);assert.equal(copy.pattern.lastIndex,2);
 assert.equal(clone(value,true,1).shared,shared);
 const acyclic=clone({a:shared,b:shared},false);assert.notEqual(acyclic.a,acyclic.b);
});

test('virtual routing archive is one detached graph snapshot',()=> {
 globalThis.self=globalThis;
 const {SankeyChart}=require('../dist/sankeyPlus.js');
 const nodes=['start','a','b','end'].map((name,horizontalSort)=>({name,horizontalSort,verticalSort:0}));
 const links=[['start','a'],['a','b'],['b','end'],['start','end']].map(([source,target])=>({source,target,value:10}));
 const chart=new SankeyChart({id:n=>n.name,width:1200,height:500,scale:1,nodes:{data:nodes,horizontalSort:true,verticalSort:true},links:{data:links,useVirtualRoutes:true}});chart.process();
 const archived=new Map(chart.graph.virtualNodes.map(n=>[n.index,n]));
 assert.ok(archived.size>0,'Fixture must create a virtual route');
 for(const link of chart.graph.virtualLinks) {
  for(const end of [link.source,link.target]) {
   if(end.virtual)assert.equal(end,archived.get(end.index),'Archive links must reuse copied virtual nodes');
   else assert.notEqual(end,chart.graph.nodes.find(n=>n.index===end.index),'Archived real endpoints must be detached');
  }
 }
});
