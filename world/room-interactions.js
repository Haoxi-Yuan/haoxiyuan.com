// Shared small-room interactions. No KOMA-only props, menus or sounds are downloaded.
export class RoomInteractions {
 constructor(interior){this.interior=interior;this.ready=true;this.seated=null;this.reading=null;this.holding=null;this.served=[];this.menus=[];}
 update(){return false;}
 showSwitch(){}
 click(x,y){
  const hit=this.interior.pick(x,y,[this.interior.root])[0];
  if(!hit||hit.distance>3.5)return null;
  if(hit.object.userData.interaction==='lights'){this.interior.setLights(!this.interior.lightsOn);return 'lights';}
  const seats=this.interior.data.seats||[];
  const seat=seats.find(s=>Math.hypot(s.centre[0]-hit.point.x,s.centre[1]+hit.point.z)<.38&&hit.point.y<1.4);
  if(seat){this.stand();const w=this.interior.walker;this.seated={floor:w.floor,x:w.x,z:w.z};w.x=seat.centre[0];w.z=seat.centre[1];w.floor=(seat.seatHeight||.46)+.72-1.62;w.yaw=(seat.yaw||0)+Math.PI;w.momentum.set(0,0);this.interior.place();return 'seat';}
  return null;
 }
 hover(){return null;}
 stand(){if(!this.seated)return;Object.assign(this.interior.walker,this.seated);this.seated=null;this.interior.place();}
 reset(){this.stand();}
}
