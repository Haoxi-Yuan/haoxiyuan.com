// Shared radar: drawn from the same floor heights and obstacles used for walking.
// Plan +Y points into the room; it is local orientation, not geographical north.
export class InteriorMinimap {
 constructor(canvas){this.canvas=canvas;this.ctx=canvas.getContext('2d');this.layers=[];this.last='';}
 setInterior(interior){
  this.interior=interior;this.last='';this.layers=[];
  const m=interior?.map;if(!m)return;
  this.multi=m.upper.some(v=>v!==m.none);
  for(let level=0;level<(this.multi?2:1);level++){
   const c=document.createElement('canvas');c.width=m.columns;c.height=m.rows;const ctx=c.getContext('2d'),img=ctx.createImageData(c.width,c.height);
   for(let i=0;i<m.ground.length;i++){
    const upper=m.upper[i]!==m.none, floor=level&&upper?m.upper[i]:m.ground[i];
    if(floor===m.none||level&&floor<2300)continue;
    const blocked=m.flags[i]&(level&&upper?2:1),rgba=blocked?[60,65,64,255]:[194,197,185,255];
    img.data.set(rgba,((m.rows-1-Math.floor(i/m.columns))*m.columns+i%m.columns)*4);
   }
   ctx.putImageData(img,0,0);this.layers.push(c);
  }
  this.draw(true);
 }
 clear(){this.status=null;this.interior=null;this.layers=[];this.last='';this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height);}
 draw(force=false){
  const room=this.interior,m=room?.map;if(!m||!this.layers.length)return;
  const w=room.walker,level=this.multi&&w.floor>2.5?1:0,rect=this.canvas.getBoundingClientRect();
  if(!rect.width)return;const dpr=Math.min(devicePixelRatio||1,2),W=Math.round(rect.width*dpr),H=Math.round(rect.height*dpr);
  const key=[W,H,w.x.toFixed(2),w.z.toFixed(2),w.yaw.toFixed(3),level].join(':');if(!force&&key===this.last)return;this.last=key;
  if(this.canvas.width!==W||this.canvas.height!==H){this.canvas.width=W;this.canvas.height=H;}
  const c=this.ctx;c.setTransform(dpr,0,0,dpr,0,0);const width=W/dpr,height=H/dpr;
  c.clearRect(0,0,width,height);c.fillStyle='#202725';c.fillRect(0,0,width,height);
  // A 15 m local window for small rooms, 25 m for KOMA; the visitor stays at its centre.
  const span=this.multi?25:15,scale=width/span,px=width*.5,py=height*.60;
  c.save();c.translate(px,py);c.rotate(w.yaw);c.scale(scale,scale);c.translate(-w.x,w.z);
  c.imageSmoothingEnabled=false;c.drawImage(this.layers[level],m.origin[0]-m.step/2,-m.origin[1]-(m.rows-.5)*m.step,m.columns*m.step,m.rows*m.step);
  const p=room.data.floors?.passage;
  if(p&&!level){const x=(p.x[0]+p.x[1])/2,y=p.y[0]+.55;c.fillStyle='#7bc9bf';c.strokeStyle='#18211f';c.lineWidth=.10;c.fillRect(x-.28,-y-.2,.56,.4);c.strokeRect(x-.28,-y-.2,.56,.4);}
  c.restore();
  c.save();c.translate(px,py);
  const cone=c.createRadialGradient(0,0,3,0,0,48);cone.addColorStop(0,'#eff6dc55');cone.addColorStop(1,'#eff6dc00');c.fillStyle=cone;c.beginPath();c.moveTo(0,0);c.arc(0,0,48,-Math.PI*.69,-Math.PI*.31);c.closePath();c.fill();
  c.shadowBlur=5;c.shadowColor='#000';c.fillStyle='#fafaf2';c.strokeStyle='#161e1c';c.lineWidth=1.6;c.beginPath();c.moveTo(0,-8);c.lineTo(6,6);c.lineTo(0,3);c.lineTo(-6,6);c.closePath();c.fill();c.stroke();c.restore();
  c.font='10px Arial';c.fillStyle='#eff2e8';c.textAlign='right';c.fillText(level?'UPPER':'GROUND',width-10,height-12);
  c.strokeStyle='#c3cbbb';c.lineWidth=1.5;c.beginPath();c.moveTo(10,height-17);c.lineTo(10,height-13);c.lineTo(10+3*scale,height-13);c.lineTo(10+3*scale,height-17);c.stroke();c.textAlign='left';c.fillText('3 m',10,height-21);
  this.canvas.setAttribute('aria-label',`${room.zone()}, ${level?'upper':'ground'} floor. Your position ${w.x.toFixed(1)}, ${w.z.toFixed(1)}. Arrow faces your viewing direction.`);
  this.status={x:w.x,y:w.z,yaw:w.yaw,level,source:'collision-grid',columns:m.columns,rows:m.rows};
 }
}
