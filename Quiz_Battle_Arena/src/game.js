import Phaser from 'phaser';

const COLORS = { cyan: 0x55e8df, pink: 0xff6196, purple: 0x9b87ff, gold: 0xffc857, green: 0x61e294, white: 0xf4f6ff, muted: 0x8690b3 };
const avatarColors = ['#55e8df','#ff6196','#9b87ff','#ffc857','#61e294','#ff8d55','#6da6ff','#ef78ff'];
const gameRuntime = { state: null, question: null, scene: null, socket: null, keys: null, seq: 0, dashPressed: false, abilityPressed: false, joystick: { active:false,x:0,y:0,id:null }, target: null };

export function startArena(container, socket, handlers = {}) {
  gameRuntime.socket = socket; gameRuntime.handlers = handlers; gameRuntime.state = null; gameRuntime.question = null;
  const scene = {
    key: 'Arena',
    create() {
      gameRuntime.scene = this;
      this.input.keyboard.addCapture(['W','A','S','D','UP','DOWN','LEFT','RIGHT','SPACE']);
      this.keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,E'); gameRuntime.keys = this.keys;
      this.input.on('pointerdown', pointer => {
        if (pointer.worldX < 210 && pointer.worldY > 350) {
          gameRuntime.joystick = { active:true, x:pointer.id, y:pointer.id, id:pointer.id, startX:pointer.worldX, startY:pointer.worldY, dx:0, dy:0 };
        }
      });
      this.input.on('pointermove', pointer => {
        const joy = gameRuntime.joystick;
        if (!joy.active || pointer.id !== joy.id) return;
        joy.dx = Math.max(-1,Math.min(1,(pointer.worldX-joy.startX)/60));
        joy.dy = Math.max(-1,Math.min(1,(pointer.worldY-joy.startY)/60));
      });
      this.input.on('pointerup', pointer => { if(gameRuntime.joystick.active && pointer.id===gameRuntime.joystick.id)gameRuntime.joystick={active:false,x:0,y:0,id:null}; });
      this.graphics = this.add.graphics();
      this.label = this.add.text(0,0,'',{fontFamily:'Inter,system-ui',fontSize:'15px',color:'#f4f6ff',fontStyle:'bold',align:'center',wordWrap:{width:145}}).setOrigin(.5).setDepth(5);
      this.zoneLabels = Array.from({length:4}, () => this.add.text(0,0,'',{fontFamily:'Inter,system-ui',fontSize:'20px',fontStyle:'900',color:'#ffffff'}).setOrigin(.5).setDepth(2).setVisible(false));
      this.trapLabels = Array.from({length:4}, () => this.add.text(0,0,'⚠',{fontFamily:'system-ui',fontSize:'14px',color:'#ffce65'}).setOrigin(.5).setDepth(3).setVisible(false));
      this.input.on('gameobjectdown', (_pointer, object) => object?.onTap?.());
    },
    update(time, delta) {
      const s = gameRuntime.state;
      if (!s) return;
      const prev=gameRuntime.previousState;const blend=Math.min(1,Math.max(0,(performance.now()-gameRuntime.receivedAt)/50));
      const smooth=(current,old)=>current==null||old==null?current:old+(current-old)*blend;
      const renderState=prev&&prev.matchId===s.matchId?{...s,
        self:{...s.self,x:smooth(s.self?.x,prev.self?.x),y:smooth(s.self?.y,prev.self?.y)},
        players:s.players.map(p=>{const before=prev.players.find(x=>x.id===p.id);return before?{...p,x:smooth(p.x,before.x),y:smooth(p.y,before.y)}:p;}),
        enemies:s.enemies.map(e=>{const before=prev.enemies.find(x=>x.id===e.id);return before?{...e,x:smooth(e.x,before.x),y:smooth(e.y,before.y)}:e;})
      }:s;
      this.graphics.clear();
      const g=this.graphics;
      g.fillStyle(0x10172c,1); g.fillRoundedRect(12,12,936,516,28);
      g.lineStyle(1,0x293353,.8); g.strokeRoundedRect(12,12,936,516,28);
      // Subtle arena grid and accessible perimeter marks.
      g.lineStyle(1,0x212b49,.42);
      for(let x=44;x<950;x+=48){g.lineBetween(x,24,x,516);} for(let y=36;y<520;y+=48){g.lineBetween(24,y,936,y);}
      g.lineStyle(3,0x55e8df,.7); g.strokeRoundedRect(23,23,914,494,22);
      (renderState.zones||[]).forEach((z,i)=>{
        const color=[0xff657f,0x5bb6ff,0xffc857,0x69e4a5][i%4];
        g.fillStyle(color,.14); g.fillCircle(z.x,z.y,44);
        g.lineStyle(3,color,.9); g.strokeCircle(z.x,z.y,44);
        g.fillStyle(color,.23); g.fillCircle(z.x,z.y,31);
        this.zoneLabels[i]?.setPosition(z.x,z.y-3).setText(z.letter).setVisible(true).setAlpha(.94);
      });
      for(let i=(renderState.zones||[]).length;i<this.zoneLabels.length;i++)this.zoneLabels[i].setVisible(false);
      (renderState.hazards||[]).forEach((h,i)=>{
        const pulse=.5+Math.sin(time/110)*.16;const color=h.active?0xff5578:0xffce65;
        g.fillStyle(color,h.active ? .23 : .08);g.fillCircle(h.x,h.y,h.active?32:28);
        g.lineStyle(h.active?3:2,color,h.active ? .95 : pulse);g.strokeCircle(h.x,h.y,h.active?30:22+Math.sin(time/100)*4);
        if(h.active){for(let n=0;n<4;n++){const angle=n*Math.PI/2;const x=h.x+Math.cos(angle)*13,y=h.y+Math.sin(angle)*13;g.fillStyle(0xff829a,.92);g.fillTriangle(x-6,y+6,x+6,y+6,x,y-7);}}
        this.trapLabels[i]?.setPosition(h.x,h.y-35).setText(h.warning?'⚠':'').setVisible(Boolean(h.warning));
      });
      for(let i=(renderState.hazards||[]).length;i<this.trapLabels.length;i++)this.trapLabels[i].setVisible(false);
      for(const e of renderState.enemies||[]){
        g.fillStyle(0xff5f78,1);g.fillCircle(e.x,e.y,14);g.lineStyle(2,0xffbac8,.9);g.strokeCircle(e.x,e.y,14);
        g.fillStyle(0x361a35,1);g.fillCircle(e.x-4,e.y-2,2);g.fillCircle(e.x+4,e.y-2,2);
      }
      const colors=avatarColors;
      (renderState.players||[]).forEach((p,i)=>{
        if(p.x==null||p.y==null||!p.alive)return;
        const color=Phaser.Display.Color.HexStringToColor(colors[i%colors.length]).color;
        g.fillStyle(color,.22);g.fillCircle(p.x,p.y,28);
        g.fillStyle(color,1);g.fillRoundedRect(p.x-15,p.y-17,30,34,9);
        g.fillStyle(0x172038,1);g.fillRoundedRect(p.x-10,p.y-8,20,12,5);
        g.fillStyle(0xffffff,.95);g.fillCircle(p.x-5,p.y-2,2);g.fillCircle(p.x+5,p.y-2,2);
        g.fillStyle(0x18213b,1);g.fillRoundedRect(p.x-22,p.y+22,44,5,3);
        g.fillStyle(p.hp<35?0xff5573:0x61e294,1);g.fillRoundedRect(p.x-22,p.y+22,44*Math.max(0,p.hp/p.maxHp),5,3);
        if(p.locked){g.lineStyle(3,0xffffff,.85);g.strokeCircle(p.x,p.y,23);}
      });
      if(gameRuntime.joystick.active){const j=gameRuntime.joystick;g.fillStyle(0xffffff,.08);g.fillCircle(j.startX,j.startY,52);g.lineStyle(2,0x55e8df,.6);g.strokeCircle(j.startX,j.startY,52);g.fillStyle(0x55e8df,.55);g.fillCircle(j.startX+(j.dx||0)*35,j.startY+(j.dy||0)*35,18);}
      const elapsed=Math.max(0,s.endsAt-Date.now());
      if(gameRuntime.handlers?.hud&&time-(this.lastHud||0)>100){gameRuntime.handlers.hud(renderState,elapsed);this.lastHud=time;}
      if(s.phase==='ACTIVE'&&!s.self?.locked){
        const j=gameRuntime.joystick;
        const key=this.keys||{};
        let ax=(key.D?.isDown||key.RIGHT?.isDown?1:0)-(key.A?.isDown||key.LEFT?.isDown?1:0);
        let ay=(key.S?.isDown||key.DOWN?.isDown?1:0)-(key.W?.isDown||key.UP?.isDown?1:0);
        if(j.active){ax=j.dx||0;ay=j.dy||0;}
        if(ax||ay){const mag=Math.hypot(ax,ay);ax/=Math.max(1,mag);ay/=Math.max(1,mag);}
        const dash=Boolean(key.SPACE?.isDown||gameRuntime.dashPressed),ability=Boolean(key.E?.isDown||gameRuntime.abilityPressed);
        if(time-(this.lastInput||0)>49){gameRuntime.seq++;gameRuntime.socket?.emit('game:input',{x:ax,y:ay,dash,ability,seq:gameRuntime.seq});this.lastInput=time;gameRuntime.dashPressed=false;gameRuntime.abilityPressed=false;}
      }
    }
  };
  const app = new Phaser.Game({ type: Phaser.AUTO, parent: container, backgroundColor:'#0e1427', scale:{mode:Phaser.Scale.FIT,autoCenter:Phaser.Scale.CENTER_BOTH,width:960,height:540}, render:{antialias:true,pixelArt:false,roundPixels:true}, scene });
  return { destroy:()=>{app.destroy(true);gameRuntime.scene=null;gameRuntime.state=null;gameRuntime.previousState=null;gameRuntime.joystick={active:false,x:0,y:0,id:null};}, setState:state=>{gameRuntime.previousState=gameRuntime.state?.matchId===state.matchId?gameRuntime.state:null;gameRuntime.state=state;gameRuntime.receivedAt=performance.now();}, setQuestion:q=>{gameRuntime.question=q;} };
}

export function pressDash(){gameRuntime.dashPressed=true;}
export function pressAbility(){gameRuntime.abilityPressed=true;}
