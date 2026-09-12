'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const sharp=require('sharp');
const {DiskRaster,windows}=require('./raster.cjs');
const assert=(ok,msg)=>{if(!ok)throw new Error(msg);};
const {validateCanvas,imageOptions,resourceEstimate,checkDisk,tiledTiffBytes}=require('./resources.cjs');
const ID=/^[a-z][a-z0-9-]{0,63}$/;
const header=(w,h)=>`<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
function hash(filename){const h=crypto.createHash('sha256'),fd=fs.openSync(filename,'r'),b=Buffer.allocUnsafe(1024*1024);try{let n;while((n=fs.readSync(fd,b,0,b.length,null)))h.update(b.subarray(0,n));return h.digest('hex');}finally{fs.closeSync(fd);}}
function write(filename,value){const tmp=filename+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');fs.renameSync(tmp,filename);}
const raw=(b,r)=>sharp(b,{raw:{width:r.width,height:r.height,channels:4},...imageOptions(r.width,r.height)});
function blend(dst,src){for(let i=0;i<src.length;i+=4){const a=src[i+3]/255;for(let c=0;c<3;c++)dst[i+c]=Math.round(src[i+c]*a+dst[i+c]*(1-a));dst[i+3]=255;}return dst;}
function cleanup(root){const resolved=path.resolve(root);assert(path.basename(resolved).startsWith('.render-'),'Unexpected temporary path');fs.rmSync(resolved,{recursive:true,force:true});}

class SvgWriter{
  constructor(filename,w,h,xml){this.filename=filename;this.fd=fs.openSync(filename,'wx');this.offset=0;this.index=[];this.xml=xml;this.put(header(w,h));}
  put(s){const b=Buffer.from(s);let n=0;while(n<b.length)n+=fs.writeSync(this.fd,b,n,b.length-n,null);this.offset+=b.length;}
  start(id,label){this.put(`<g id="layer-${this.xml(id)}" inkscape:groupmode="layer" inkscape:label="${this.xml(label)}">`);}
  end(){this.put('</g>\n');}
  async image(pixels,r,id){assert(r.width<=1024&&r.height<=1024,'SVG image exceeds 1024 pixels');const png=await raw(pixels,r).png().toBuffer();
    const nodeId=`raster-${this.xml(id)}`,node=`<image id="${nodeId}" x="${r.left}" y="${r.top}" width="${r.width}" height="${r.height}" preserveAspectRatio="none" href="data:image/png;base64,${png.toString('base64')}"/>`;
    this.index.push({offset:this.offset,length:Buffer.byteLength(node),order:this.index.length,id:nodeId,...r});this.put(node);}
  async raster(disk,origin,id){for(const r of windows(disk.width,disk.height)){await this.image(disk.read(r),{...r,left:r.left+origin.left,top:r.top+origin.top},`${id}-${r.left}-${r.top}`);}}
  finish(){this.put('</svg>\n');this.close();}
  close(){if(this.fd!==null){fs.closeSync(this.fd);this.fd=null;}}
}

async function assemble(j,destination,h){
  sharp.concurrency(1);sharp.cache(false);sharp.cache({memory:64,files:0,items:0});
  const {file,record,current,geometry,seamRoute,routeAt,smooth,num,xml}=h;
  const {width:W,height:H}=j.m,out=path.resolve(destination);
  assert(!fs.existsSync(out),'Output directory already exists; choose a new version');
  validateCanvas(W,H);
  assert(Number.isSafeInteger(j.m.rows)&&Number.isSafeInteger(j.m.cols)&&j.m.rows>0&&j.m.cols>0&&j.m.rows*j.m.cols<=1000,'Invalid manifest grid');
  assert(Array.isArray(j.m.regions)&&j.m.regions.length<=1000,'Invalid editing region list');
  const groups=j.m.detailGroups||[];assert(Array.isArray(groups),'Invalid detail group list');
  const ids=new Set(['base']),groupIds=new Set();
  for(const item of [...j.m.regions,...groups]){assert(ID.test(item.id)&&!ids.has(item.id),`Invalid or duplicate region/group ID ${item.id}`);ids.add(item.id);}
  for(const g of groups){assert(Number.isSafeInteger(g.cols)&&Number.isSafeInteger(g.rows)&&g.cols>0&&g.rows>0&&g.cols*g.rows<=1000,`Invalid detail group grid ${g.id}`);groupIds.add(g.id);file(j,g.mask);}
  for(const t of j.m.regions){assert(['tile','detail','detail-tile'].includes(t.kind),`Unrecognized region ${t.id}`);assert(t.kind==='detail-tile'?groupIds.has(t.groupId):!t.groupId,`Invalid or missing detail group for ${t.id}`);}
  const expected=new Set();for(let row=0;row<j.m.rows;row++)for(let col=0;col<j.m.cols;col++)expected.add(`r${row+1}c${col+1}`);
  for(const t of j.m.regions.filter(t=>t.kind==='tile'))assert(expected.delete(t.id),`Duplicate or unexpected tile ${t.id}`);
  assert(!expected.size,'Manifest is missing planned grid tiles');
  for(const t of j.m.regions){geometry(j.m,t);const r=record(j,t.id);current(j,t,r);assert(r.state==='accepted',`${t.id}: visual QA not accepted`);}
  assert(hash(file(j,j.m.base))===j.m.baseSha256,'Reference base changed');
  for(const g of groups){geometry({...j.m,schemaVersion:1},g);const children=j.m.regions.filter(t=>t.groupId===g.id);assert(children.length===g.cols*g.rows,`Incomplete detail group ${g.id}`);const coords=new Set();for(const t of children){assert(Number.isSafeInteger(t.row)&&Number.isSafeInteger(t.col)&&t.row>=0&&t.row<g.rows&&t.col>=0&&t.col<g.cols&&!coords.has(`${t.row}/${t.col}`),'Invalid detail group grid');coords.add(`${t.row}/${t.col}`);assert(t.region.left>=g.region.left&&t.region.top>=g.region.top&&t.region.left+t.region.width<=g.region.left+g.region.width&&t.region.top+t.region.height<=g.region.top+g.region.height,'Detail child outside parent');}}
  const resourcePlan=resourceEstimate(W,H,j.m.regions,groups),diskCheck=checkDisk(out,resourcePlan.estimatedAdditionalAssemblyBytes);
  fs.mkdirSync(out,{recursive:true});const tmp=fs.mkdtempSync(path.join(out,'.render-'));let canvas,svg;
  const records=[],seamPaths=[];const start=Date.now();let temporaryBytes=0;
  try{
    canvas=DiskRaster.create(path.join(tmp,'canvas.tiff'),W,H);await canvas.fillFrom(file(j,j.m.base));temporaryBytes=fs.statSync(canvas.filename).size;
    svg=new SvgWriter(path.join(out,'refined.svg'),W,H,xml);svg.start('base','Reference base');await svg.raster(canvas,{left:0,top:0},'base-image');svg.end();
    const collect=(t,rec)=>records.push({...rec,region:t.region,groupId:t.groupId||null,destinationScale:[t.region.width/rec.nativeWidth,t.region.height/rec.nativeHeight]});
    async function tile(disk,t,order,origin,emit){
      const rec=record(j,t.id),r=t.region,local={...r,left:r.left-origin.left,top:r.top-origin.top};
      const aligned=await sharp(file(j,rec.aligned),imageOptions(W,H)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      assert(aligned.info.width===r.width&&aligned.info.height===r.height,`${t.id}: aligned dimensions differ from placement`);const pixels=aligned.data,oldPixels=disk.read(local);
      const sw=Math.ceil(r.width/4),sh=Math.ceil(r.height/4),sx=r.width/sw,sy=r.height/sh;
      const old=await raw(oldPixels,r).resize(sw,sh).raw().toBuffer(),newer=await raw(pixels,r).resize(sw,sh).raw().toBuffer();
      const prevX=t.col?order.find(q=>q.row===t.row&&q.col===t.col-1):null,prevY=t.row?order.find(q=>q.row===t.row-1&&q.col===t.col):null;
      const ox=prevX?prevX.region.left+prevX.region.width-r.left:0,oy=prevY?prevY.region.top+prevY.region.height-r.top:0;
      const left=ox?seamRoute(old,newer,sw,sh,Math.round(ox/sx),true,sx):null,top=oy?seamRoute(old,newer,sw,sh,Math.round(oy/sy),false,sy):null;
      const feather=num(t.feather,j.m.feather,0.01);
      for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++){let a=1;if(left&&x<ox)a=Math.min(a,smooth((x-routeAt(left,y,sy))/Math.min(feather,ox/2)+0.5));if(top&&y<oy)a=Math.min(a,smooth((y-routeAt(top,x,sx))/Math.min(feather,oy/2)+0.5));pixels[(y*r.width+x)*4+3]=Math.round(pixels[(y*r.width+x)*4+3]*a);}
      if(left)seamPaths.push(Array.from(left,(v,i)=>[r.left+v,r.top+(i+0.5)*sy]));if(top)seamPaths.push(Array.from(top,(v,i)=>[r.left+(i+0.5)*sx,r.top+v]));
      disk.write(local,blend(oldPixels,pixels));
      if(emit){svg.start(t.id,`${t.id} (${rec.method})`);for(const q of windows(r.width,r.height)){const p=await raw(pixels,r).extract(q).raw().toBuffer();await svg.image(p,{...q,left:q.left+r.left,top:q.top+r.top},`${t.id}-image-${q.left}-${q.top}`);}svg.end();}
      collect(t,rec);
    }
    const tiles=j.m.regions.filter(t=>t.kind==='tile').sort((a,b)=>a.row-b.row||a.col-b.col);
    for(const t of tiles)await tile(canvas,t,tiles,{left:0,top:0},true);
    // Parent groups are composited exactly once after stitching their opaque children.
    const details=[...j.m.regions.filter(t=>t.kind==='detail'),...groups].sort((a,b)=>j.m.regions.findIndex(t=>t.id===a.id||t.groupId===a.id)-j.m.regions.findIndex(t=>t.id===b.id||t.groupId===b.id));
    for(const item of details){
      const r=item.region,isGroup=groups.includes(item);let detailDisk=null;
      try{
        if(isGroup){detailDisk=DiskRaster.create(path.join(tmp,`${item.id}.tiff`),r.width,r.height);await detailDisk.fillFrom(file(j,j.m.base),r);temporaryBytes=Math.max(temporaryBytes,fs.statSync(canvas.filename).size+fs.statSync(detailDisk.filename).size);const children=j.m.regions.filter(t=>t.groupId===item.id).sort((a,b)=>a.row-b.row||a.col-b.col);for(const child of children)await tile(detailDisk,child,children,r,false);}
        const rec=isGroup?null:record(j,item.id);if(rec)collect(item,rec);
        const maskMeta=await sharp(file(j,item.mask),imageOptions(W,H)).metadata();assert(maskMeta.width===r.width&&maskMeta.height===r.height,`${item.id}: mask dimensions differ`);
        // A tiled TIFF avoids repeatedly decoding a large parent PNG mask.
        const maskFile=path.join(tmp,`${item.id}-mask.tiff`);await sharp(file(j,item.mask),imageOptions(W,H)).removeAlpha().greyscale().tiff({compression:'none',tile:true,tileWidth:256,tileHeight:256}).toFile(maskFile);
        svg.start(item.id,isGroup?`${item.id} (detail group)`: `${item.id} (${rec.method})`);
        for(const q of windows(r.width,r.height)){
          const pixels=isGroup?detailDisk.read(q):await sharp(file(j,rec.aligned),imageOptions(W,H)).extract(q).ensureAlpha().raw().toBuffer();
          const mask=await sharp(maskFile,imageOptions(W,H)).extract(q).removeAlpha().greyscale().raw().toBuffer();
          for(let i=0;i<mask.length;i++)pixels[i*4+3]=Math.round(pixels[i*4+3]*mask[i]/255);
          const dst={...q,left:q.left+r.left,top:q.top+r.top};canvas.write(dst,blend(canvas.read(dst),pixels));await svg.image(pixels,dst,`${item.id}-image-${q.left}-${q.top}`);
        }
        svg.end();fs.unlinkSync(maskFile);
      }finally{if(detailDisk){detailDisk.close();fs.unlinkSync(detailDisk.filename);}}
    }
    svg.finish();canvas.close();
    await sharp(canvas.filename,imageOptions(W,H)).removeAlpha().withIccProfile('srgb').png().toFile(path.join(out,'refined.png'));
    const previewScale=Math.min(1,1920/Math.max(W,H)),pw=Math.max(1,Math.round(W*previewScale)),ph=Math.max(1,Math.round(H*previewScale));
    await sharp(canvas.filename,imageOptions(W,H)).resize(pw,ph).jpeg({quality:94}).toFile(path.join(out,'preview.jpg'));
    const overlay=`<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${W} ${H}"><g fill="none" stroke="#00ffb7" stroke-width="${2*W/pw}">${seamPaths.map(p=>`<polyline points="${p.map(v=>v.join(',')).join(' ')}"/>`).join('')}</g></svg>`;
    await sharp(path.join(out,'preview.jpg')).composite([{input:Buffer.from(overlay)}]).jpeg().toFile(path.join(out,'seams.jpg'));
    const report={schemaVersion:2,sourceName:j.m.sourceName,sourceSha256:j.m.sourceSha256,width:W,height:H,preset:j.m.preset||null,
      generatedRegions:records.filter(r=>r.method==='generated').length,retainedRegions:records.filter(r=>r.method==='retained').length,
      disclosure:'Interpretive detail. Output canvas size differs from native generation resolution. SVG embeds raster layers.',
      svgSha256:hash(path.join(out,'refined.svg')),pngSha256:hash(path.join(out,'refined.png')),svgIndex:svg.index,records,
      resources:{...resourcePlan,diskCheck,assemblyMilliseconds:Date.now()-start,peakResidentBytes:process.resourceUsage().maxRSS*1024,temporaryRasterBytes:temporaryBytes}};
    write(path.join(out,'report.json'),report);return{output:out,dimensions:[W,H],generated:report.generatedRegions,retained:report.retainedRegions,resources:report.resources};
  }finally{if(canvas)canvas.close();if(svg)svg.close();cleanup(tmp);}
}

async function scanSvg(filename,width,height){
  let pending=Buffer.alloc(0),consumed=0,started=false,closed=false,depth=0,maxDataAttributeBytes=0;const index=[],ids=new Set();
  for await(const chunk of fs.createReadStream(filename,{highWaterMark:1024*1024})){
    pending=Buffer.concat([pending,chunk]);assert(pending.length<12*1024*1024,'Oversized SVG element');let end;
    while((end=pending.indexOf(62))!==-1){
      const token=pending.subarray(0,end+1),text=token.toString('utf8'),lead=text.match(/^\s*/)[0].length,tag=text.slice(lead);const offset=consumed+lead;
      if(!started){assert(tag===header(width,height),'Unexpected SVG root or dimensions');started=true;}
      else if(tag==='<\/svg>'){assert(depth===0&&!closed,'Invalid SVG nesting');closed=true;}
      else if(!closed&&/^<g id="[^"<>]*" inkscape:groupmode="layer" inkscape:label="[^"<>]*">$/.test(tag)){assert(depth===0,'Nested SVG groups are unsupported');const id=tag.match(/^<g id="([^"]*)"/)[1];assert(!ids.has(id),'Duplicate SVG element ID');ids.add(id);depth=1;}
      else if(!closed&&tag==='</g>'){assert(depth===1,'Invalid SVG group end');depth=0;}
      else {
        assert(!closed&&depth===1,'Unexpected SVG content');
        const m=tag.match(/^<image id="([^"<>]*)" x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" preserveAspectRatio="none" href="data:image\/png;base64,([A-Za-z0-9+/]*={0,2})"\/>$/);
        assert(m,'SVG must contain embedded PNG images only; unexpected active or external content');
        assert(!ids.has(m[1]),'Duplicate SVG element ID');ids.add(m[1]);
        const r={left:+m[2],top:+m[3],width:+m[4],height:+m[5]};assert(r.width>0&&r.height>0&&r.width<=1024&&r.height<=1024&&r.left+r.width<=width&&r.top+r.height<=height,'Invalid embedded image geometry');
        const png=Buffer.from(m[6],'base64'),meta=await sharp(png,{limitInputPixels:1048576}).metadata();assert(meta.format==='png'&&meta.width===r.width&&meta.height===r.height,'Embedded PNG dimensions differ');
        index.push({offset,length:Buffer.byteLength(tag),order:index.length,id:m[1],...r});maxDataAttributeBytes=Math.max(maxDataAttributeBytes,m[6].length+22);
      }
      pending=pending.subarray(end+1);consumed+=token.length;
    }
  }
  assert(started&&closed&&depth===0&&/^\s*$/.test(pending.toString())&&index.length,'Incomplete SVG document');return{index,maxDataAttributeBytes};
}
function readNode(fd,n){const b=Buffer.allocUnsafe(n.length);let p=0;while(p<b.length){const got=fs.readSync(fd,b,p,b.length-p,n.offset+p);assert(got>0,'Unexpected SVG EOF');p+=got;}return b;}
async function verify(destination,opt={}){
  sharp.concurrency(1);sharp.cache(false);sharp.cache({memory:64,files:0,items:0});
  for(const k of Object.keys(opt))assert(['max-mean-difference','max-outlier-fraction'].includes(k),`Unknown option --${k}`);
  const out=path.resolve(destination),report=JSON.parse(fs.readFileSync(path.join(out,'report.json'),'utf8')),svg=path.join(out,'refined.svg'),png=path.join(out,'refined.png');
  assert(hash(svg)===report.svgSha256&&hash(png)===report.pngSha256,'Export hashes changed');
  const {width:W,height:H}=report;validateCanvas(W,H);
  // Legacy v1 exports can be validated through the bounded path only after reassembly;
  // retain the old renderer in the CLI for already-produced legacy SVG documents.
  const scanned=await scanSvg(svg,report.width,report.height);
  assert(Array.isArray(report.svgIndex)&&JSON.stringify(scanned.index)===JSON.stringify(report.svgIndex),'SVG node index differs from actual saved document');
  const meta=await sharp(png,imageOptions(W,H)).metadata();assert(meta.width===report.width&&meta.height===report.height,'Full-resolution dimensions do not match');
  const diskCheck=checkDisk(out,tiledTiffBytes(W,H));
  const tmp=fs.mkdtempSync(path.join(out,'.render-')),raster=path.join(tmp,'comparison.tiff');let fd;let sum=0,max=0,outliers=0,channels=0,count=0;const start=Date.now();
  try{
    await sharp(png,imageOptions(W,H)).removeAlpha().tiff({compression:'none',tile:true,tileWidth:256,tileHeight:256}).toFile(raster);
    fd=fs.openSync(svg,'r');
    for(const r of windows(report.width,report.height)){
      const nodes=scanned.index.filter(n=>n.left<r.left+r.width&&n.left+n.width>r.left&&n.top<r.top+r.height&&n.top+n.height>r.top);
      const root=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}" viewBox="${r.left} ${r.top} ${r.width} ${r.height}">`);
      const doc=Buffer.concat([root,...nodes.map(n=>readNode(fd,n)),Buffer.from('</svg>')]);
      const a=await sharp(raster,imageOptions(W,H)).extract(r).removeAlpha().raw().toBuffer(),b=await sharp(doc,{limitInputPixels:1048576}).removeAlpha().raw().toBuffer();
      assert(a.length===b.length&&a.length===r.width*r.height*3,'Window render dimensions differ');
      for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);sum+=d;if(d>max)max=d;if(d>10)outliers++;}channels+=a.length;count++;
    }
    const threshold=(key,fallback)=>{const n=opt[key]===undefined?fallback:Number(opt[key]);assert(Number.isFinite(n)&&n>=0,`Invalid numeric value: ${opt[key]}`);return n;};
    const result={width:report.width,height:report.height,diskCheck,meanChannelDifference:sum/channels,maxChannelDifference:max,fractionAbove10:outliers/channels,
      embeddedImages:scanned.index.length,maxDataAttributeBytes:scanned.maxDataAttributeBytes,svgSha256:report.svgSha256,pngSha256:report.pngSha256,
      pixelsCompared:channels/3,verificationWindows:count,peakResidentBytes:process.resourceUsage().maxRSS*1024,temporaryRasterBytes:fs.statSync(raster).size,verificationMilliseconds:Date.now()-start,
      visualQA:'Separate visual inspection required; this verifies render and file consistency only.'};
    result.passed=result.meanChannelDifference<=threshold('max-mean-difference',0.5)&&result.fractionAbove10<=threshold('max-outlier-fraction',0.001);
    write(path.join(out,'verification.json'),result);assert(result.passed,'SVG/PNG comparison failed; inspect verification.json');return result;
  }finally{if(fd!==undefined)fs.closeSync(fd);cleanup(tmp);}
}
module.exports={assemble,verify,scanSvg,DiskRaster,hash,blend};
