'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const sharp=require('sharp');
const {DiskRaster}=require('../scripts/raster.cjs');
const render=require('../scripts/render.cjs');
const p=require('../scripts/pipeline.cjs');
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const helpers={file:(j,s)=>path.join(j.root,s),record:(j,id)=>j.records[id],current:(j,t,r)=>assert.equal(r.state,'accepted'),geometry:(m,t)=>assert.ok(t.region.left+t.region.width<=m.width&&t.region.top+t.region.height<=m.height),seamRoute:p.seamRoute,
  routeAt:(route,x,scale)=>{const q=clamp((x+0.5)/scale-0.5,0,route.length-1),i=Math.floor(q),k=Math.min(i+1,route.length-1);return route[i]+(route[k]-route[i])*(q-i);},smooth:x=>{x=clamp(x,0,1);return x*x*(3-2*x);},num:(v,f)=>v===undefined?f:Number(v),xml:s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]))};
async function setup(t,w=181,h=123){const root=fs.mkdtempSync(path.join(os.tmpdir(),'render-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  await sharp({create:{width:w,height:h,channels:3,background:'#193852'}}).tiff({compression:'none',tile:true}).toFile(path.join(root,'base.tiff'));
  return {root,m:{schemaVersion:2,width:w,height:h,cols:2,rows:2,pad:12,feather:8,base:'base.tiff',baseSha256:render.hash(path.join(root,'base.tiff')),regions:[]},records:{}};
}
async function grid(j,region,cols,rows,pad,groupId){
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    const l=Math.round(col*region.width/cols),tt=Math.round(row*region.height/rows),right=Math.round((col+1)*region.width/cols),bottom=Math.round((row+1)*region.height/rows),x=Math.max(0,l-pad),y=Math.max(0,tt-pad);
    const id=(groupId?groupId+'-':'')+`r${row+1}c${col+1}`,r={left:region.left+x,top:region.top+y,width:Math.min(region.width,right+pad)-x,height:Math.min(region.height,bottom+pad)-y};
    const t={id,kind:groupId?'detail-tile':'tile',groupId,row,col,region:r};j.m.regions.push(t);
    const b=Buffer.alloc(r.width*r.height*4);
    for(let yy=0;yy<r.height;yy++)for(let xx=0;xx<r.width;xx++){const i=(yy*r.width+xx)*4;b[i]=groupId?220:20+col*63;b[i+1]=groupId?30:50+row*72;b[i+2]=groupId?40:100+(xx+yy)%70;b[i+3]=255;}
    await sharp(b,{raw:{width:r.width,height:r.height,channels:4}}).png().toFile(path.join(j.root,id+'.png'));j.records[id]={id,state:'accepted',method:'generated',aligned:id+'.png',nativeWidth:r.width,nativeHeight:r.height};
  }
}
// Pre-0.2 full-buffer tile compositor, kept as an independent regression oracle.
async function memoryReference(j){
  const W=j.m.width,H=j.m.height,canvas=await sharp(path.join(j.root,j.m.base)).ensureAlpha().raw().toBuffer();
  const tiles=j.m.regions.filter(t=>t.kind==='tile').sort((a,b)=>a.row-b.row||a.col-b.col);
  for(const t of tiles){const r=t.region,pixels=await sharp(path.join(j.root,j.records[t.id].aligned)).ensureAlpha().raw().toBuffer();
    const sw=Math.ceil(r.width/4),sh=Math.ceil(r.height/4),sx=r.width/sw,sy=r.height/sh;
    const old=await sharp(canvas,{raw:{width:W,height:H,channels:4}}).extract(r).resize(sw,sh).raw().toBuffer(),newer=await sharp(pixels,{raw:{width:r.width,height:r.height,channels:4}}).resize(sw,sh).raw().toBuffer();
    const prevX=t.col?tiles.find(q=>q.row===t.row&&q.col===t.col-1):null,prevY=t.row?tiles.find(q=>q.row===t.row-1&&q.col===t.col):null;
    const ox=prevX?prevX.region.left+prevX.region.width-r.left:0,oy=prevY?prevY.region.top+prevY.region.height-r.top:0;
    const left=ox?p.seamRoute(old,newer,sw,sh,Math.round(ox/sx),true,sx):null,top=oy?p.seamRoute(old,newer,sw,sh,Math.round(oy/sy),false,sy):null;
    for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++){let a=1;if(left&&x<ox)a=Math.min(a,helpers.smooth((x-helpers.routeAt(left,y,sy))/Math.min(j.m.feather,ox/2)+0.5));if(top&&y<oy)a=Math.min(a,helpers.smooth((y-helpers.routeAt(top,x,sx))/Math.min(j.m.feather,oy/2)+0.5));const i=(y*r.width+x)*4,k=((r.top+y)*W+r.left+x)*4;a=Math.round(pixels[i+3]*a)/255;for(let c=0;c<3;c++)canvas[k+c]=Math.round(pixels[i+c]*a+canvas[k+c]*(1-a));}
  }
  return sharp(canvas,{raw:{width:W,height:H,channels:4}}).removeAlpha().raw().toBuffer();
}
test('fixed-layout TIFF handles single/multiple strips and random patches',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'raster-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const height of [1,63,64,65,129]){const d=DiskRaster.create(path.join(root,height+'.tiff'),31,height),b=Buffer.alloc(31*height*4,255);for(let i=0;i<b.length;i+=4)b[i]=(i*37)%256;d.write({left:0,top:0,width:31,height},b);const patch=Buffer.alloc(11*4,90);for(let i=3;i<patch.length;i+=4)patch[i]=255;d.write({left:5,top:height-1,width:11,height:1},patch);patch.copy(b,((height-1)*31+5)*4);d.close();assert.deepEqual(await sharp(d.filename).raw().toBuffer(),b);}
});
test('disk seam assembly matches actual full SVG and region verification',async t=>{
  const j=await setup(t);await grid(j,{left:0,top:0,width:j.m.width,height:j.m.height},2,2,12);
  const out=path.join(j.root,'out');await render.assemble(j,out,helpers);const result=await render.verify(out);assert.equal(result.passed,true);assert.equal(result.pixelsCompared,j.m.width*j.m.height);
  const png=await sharp(path.join(out,'refined.png')).removeAlpha().raw().toBuffer(),svg=await sharp(path.join(out,'refined.svg')).removeAlpha().raw().toBuffer();let sum=0,max=0,n=0;for(let i=0;i<png.length;i++){const d=Math.abs(png[i]-svg[i]);sum+=d;max=Math.max(max,d);if(d>10)n++;}
  assert.deepEqual(png,await memoryReference(j));
  assert.equal(result.meanChannelDifference,sum/png.length);assert.equal(result.maxChannelDifference,max);assert.equal(result.fractionAbove10,n/png.length);
  const report=JSON.parse(fs.readFileSync(path.join(out,'report.json')));assert.ok(report.svgIndex.every(n=>n.width<=1024&&n.height<=1024));assert.ok(!fs.readdirSync(out).some(n=>n.startsWith('.render-')));
  report.svgIndex[0].offset++;fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report));await assert.rejects(render.verify(out),/index differs/);
});
test('parent detail mask is applied once after stitching child grid',async t=>{
  const j=await setup(t);await grid(j,{left:0,top:0,width:j.m.width,height:j.m.height},2,2,12);
  const baseline=path.join(j.root,'baseline');await render.assemble(j,baseline,helpers);
  const region={left:24,top:16,width:132,height:91};await grid(j,region,2,2,10,'face');
  await sharp({create:{width:region.width,height:region.height,channels:3,background:{r:128,g:128,b:128}}}).png().toFile(path.join(j.root,'mask.png'));
  j.m.detailGroups=[{id:'face',region,mask:'mask.png',cols:2,rows:2,pad:10}];const out=path.join(j.root,'group');await render.assemble(j,out,helpers);assert.equal((await render.verify(out)).passed,true);
  const before=await sharp(path.join(baseline,'refined.png')).removeAlpha().raw().toBuffer(),after=await sharp(path.join(out,'refined.png')).removeAlpha().raw().toBuffer();
  for(const [x,y] of [[60,35],[90,60],[100,65]]){const i=(y*j.m.width+x)*3;for(let c=0;c<3;c++)assert.equal(after[i+c],Math.round([220,30,40][c]*128/255+before[i+c]*(1-128/255)));}
});
test('large image windows equal a complete SVG render and reject active content',async t=>{
  const j=await setup(t,1101,1051);j.m.cols=2;j.m.rows=2;await grid(j,{left:0,top:0,width:j.m.width,height:j.m.height},2,2,32);
  const out=path.join(j.root,'out');await render.assemble(j,out,helpers);const result=await render.verify(out);assert.equal(result.verificationWindows,4);
  const png=await sharp(path.join(out,'refined.png')).removeAlpha().raw().toBuffer(),svg=await sharp(path.join(out,'refined.svg')).removeAlpha().raw().toBuffer();let sum=0;for(let i=0;i<png.length;i++)sum+=Math.abs(png[i]-svg[i]);assert.equal(result.meanChannelDifference,sum/png.length);
  const svgFile=path.join(out,'refined.svg'),reportFile=path.join(out,'report.json');fs.appendFileSync(svgFile,'<script/>');const report=JSON.parse(fs.readFileSync(reportFile));report.svgSha256=render.hash(svgFile);fs.writeFileSync(reportFile,JSON.stringify(report));await assert.rejects(render.verify(out),/Unexpected SVG content/);
});
test('oversized detail group is split in SVG and respects later detail order',async t=>{
  const j=await setup(t,1203,1105);await grid(j,{left:0,top:0,width:j.m.width,height:j.m.height},2,2,32);
  const region={left:30,top:30,width:1104,height:1025};await grid(j,region,2,2,32,'large');
  await sharp({create:{width:region.width,height:region.height,channels:3,background:'#808080'}}).png().toFile(path.join(j.root,'mask.png'));
  j.m.detailGroups=[{id:'large',region,mask:'mask.png',cols:2,rows:2,pad:32}];
  const last={id:'last',kind:'detail',region:{left:400,top:400,width:20,height:20},mask:'last-mask.png'};
  await sharp({create:{width:20,height:20,channels:3,background:'#00ff00'}}).png().toFile(path.join(j.root,'last.png'));
  await sharp({create:{width:20,height:20,channels:3,background:'#ffffff'}}).png().toFile(path.join(j.root,last.mask));j.m.regions.push(last);j.records.last={id:'last',state:'accepted',method:'generated',aligned:'last.png',nativeWidth:20,nativeHeight:20};
  const out=path.join(j.root,'out');await render.assemble(j,out,helpers);assert.equal((await render.verify(out)).passed,true);
  const report=JSON.parse(fs.readFileSync(path.join(out,'report.json')));assert.equal(report.svgIndex.filter(n=>n.id.startsWith('raster-large-image-')).length,4);
  assert.ok(report.svgIndex.every(n=>n.width<=1024&&n.height<=1024));assert.equal(report.records.length,9);
  const pixel=await sharp(path.join(out,'refined.png')).extract({left:410,top:410,width:1,height:1}).removeAlpha().raw().toBuffer();assert.deepEqual(pixel,Buffer.from([0,255,0]));
});
test('invalid group graphs and unsafe or duplicate IDs fail before output creation',async t=>{
  const j=await setup(t);await grid(j,{left:0,top:0,width:j.m.width,height:j.m.height},2,2,12);
  const r={left:20,top:20,width:100,height:80};await grid(j,r,2,2,10,'face');
  await sharp({create:{width:100,height:80,channels:3,background:'#808080'}}).png().toFile(path.join(j.root,'mask.png'));
  const g={id:'face',region:r,mask:'mask.png',cols:2,rows:2,pad:10};j.m.detailGroups=[g];
  const valid=JSON.stringify(j.m),out=path.join(j.root,'invalid');
  const rejects=async(edit,pattern)=>{j.m=JSON.parse(valid);edit(j.m);await assert.rejects(render.assemble(j,out,helpers),pattern);assert.equal(fs.existsSync(out),false);};
  await rejects(m=>m.detailGroups.push({...g}),/duplicate/);
  await rejects(m=>{m.detailGroups[0].id='../escape';},/Invalid or duplicate/);
  await rejects(m=>{delete m.regions.find(t=>t.groupId).groupId;},/Invalid or missing detail group/);
  await rejects(m=>{m.regions[0].groupId='face';},/Invalid or missing detail group/);
  await rejects(m=>{m.detailGroups[0].cols=1.5;},/Invalid detail group grid/);
  await rejects(m=>{m.regions[0].id='base';},/Invalid or duplicate/);
  await rejects(m=>{m.regions[1].id=m.regions[0].id;},/Invalid or duplicate/);
});
