'use strict';
// File-backed, uncompressed, little-endian RGBA TIFF. No full-canvas JS buffer.
const fs = require('node:fs');
const sharp = require('sharp');
const assert = require('node:assert/strict');
const { rasterLayout, imageOptions, inspectImage } = require('./resources.cjs');

class DiskRaster {
  static create(filename, width, height) {
    const { rowsPerStrip, strips, count, bitsOffset, offsetsOffset, countsOffset, pixelOffset, fileBytes } = rasterLayout(width, height);
    const header = Buffer.alloc(pixelOffset); header.write('II'); header.writeUInt16LE(42, 2); header.writeUInt32LE(8, 4); header.writeUInt16LE(count, 8);
    const tags = [[256,4,1,width],[257,4,1,height],[258,3,4,bitsOffset],[259,3,1,1],[262,3,1,2],
      [273,4,strips,strips === 1 ? pixelOffset : offsetsOffset],[277,3,1,4],[278,4,1,rowsPerStrip],
      [279,4,strips,strips === 1 ? width * height * 4 : countsOffset],[284,3,1,1],[338,3,1,2]];
    tags.forEach(([tag,type,n,value],i) => { const p=10+i*12; header.writeUInt16LE(tag,p); header.writeUInt16LE(type,p+2); header.writeUInt32LE(n,p+4); header.writeUInt32LE(value,p+8); });
    for (let c=0;c<4;c++) header.writeUInt16LE(8,bitsOffset+c*2);
    for (let i=0;i<strips;i++) { header.writeUInt32LE(pixelOffset+i*rowsPerStrip*width*4,offsetsOffset+i*4); header.writeUInt32LE(Math.min(rowsPerStrip,height-i*rowsPerStrip)*width*4,countsOffset+i*4); }
    const fd=fs.openSync(filename,'wx+');
    try { fs.writeSync(fd,header); fs.ftruncateSync(fd,fileBytes); }
    catch (e) { fs.closeSync(fd); throw e; }
    return new DiskRaster(filename,fd,width,height,pixelOffset);
  }
  constructor(filename,fd,width,height,pixelOffset) { Object.assign(this,{filename,fd,width,height,pixelOffset}); }
  check(r) { assert(['left','top','width','height'].every(k=>Number.isInteger(r[k])) && r.left>=0 && r.top>=0 && r.width>0 && r.height>0 && r.left+r.width<=this.width && r.top+r.height<=this.height,'Raster region out of bounds'); }
  read(r) { this.check(r); const b=Buffer.allocUnsafe(r.width*r.height*4); for(let y=0;y<r.height;y++){ let n=0; while(n<r.width*4){ const got=fs.readSync(this.fd,b,y*r.width*4+n,r.width*4-n,this.pixelOffset+((r.top+y)*this.width+r.left)*4+n); assert(got>0,'Unexpected raster EOF'); n+=got; }} return b; }
  write(r,b) { this.check(r); assert(b.length===r.width*r.height*4,'Raster buffer size mismatch'); for(let y=0;y<r.height;y++){ let n=0; while(n<r.width*4) n+=fs.writeSync(this.fd,b,y*r.width*4+n,r.width*4-n,this.pixelOffset+((r.top+y)*this.width+r.left)*4+n); } }
  async fillFrom(source, origin={left:0,top:0}) { const meta=await inspectImage(source),options=imageOptions(meta.width,meta.height); for(const r of windows(this.width,this.height)) { const pixels=await sharp(source,options).extract({...r,left:r.left+origin.left,top:r.top+origin.top}).ensureAlpha().raw().toBuffer(); this.write(r,pixels); } }
  close() { if(this.fd!==null){ fs.closeSync(this.fd); this.fd=null; } }
}
function* windows(width,height,size=1024) { for(let top=0;top<height;top+=size) for(let left=0;left<width;left+=size) yield {left,top,width:Math.min(size,width-left),height:Math.min(size,height-top)}; }
module.exports={DiskRaster,windows};
