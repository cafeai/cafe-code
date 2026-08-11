import { MATERIALS } from "../config.js";
import { diamondTileColors, hexToRgb, meshEnergyColor, spectralBeamColor, spectralBeamOpacity } from "../color.js";
import { tessellationFacets } from "../geometry.js";
import { facetPaletteIndex } from "../pattern.js";

const rgb = (value, alpha = 1) => `rgba(${Math.round(value[0] * 255)},${Math.round(value[1] * 255)},${Math.round(value[2] * 255)},${alpha})`;
const mix = (a, b, amount) => a.map((value, index) => value + (b[index] - value) * amount);
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const smoothstep = (edge0,edge1,value) => { const normalized=clamp((value-edge0)/(edge1-edge0),0,1);return normalized*normalized*(3-2*normalized); };

// Canvas draws every extrusion face as an individual path on Chromium's main
// thread. Keep its full-frame geometry and backing stores substantially below
// the instanced WebGL budgets so a decorative fallback cannot starve host UI.
const CANVAS_QUALITY_LIMITS = Object.freeze({
  performance: Object.freeze({ dpr: .5, backingPixels: 600_000, tiles: 32, minimumIdleMs: 500 }),
  balanced: Object.freeze({ dpr: .625, backingPixels: 900_000, tiles: 48, minimumIdleMs: 250 }),
  cinematic: Object.freeze({ dpr: .75, backingPixels: 1_250_000, tiles: 64, minimumIdleMs: 150 }),
});

export function canvasQualityLimits(quality) {
  return CANVAS_QUALITY_LIMITS[quality] ?? CANVAS_QUALITY_LIMITS.cinematic;
}

export function fitCanvasDpr(width, height, requested, settings) {
  const limits = canvasQualityLimits(settings.quality);
  const bounded = Math.min(window.devicePixelRatio || 1, requested, limits.dpr);
  let fitted = Math.max(0.01, Math.min(bounded, Math.sqrt(limits.backingPixels / Math.max(1, width * height))));
  // Canvas dimensions are rounded independently. Correct for that rounding so
  // large viewports remain inside the advertised backing-store budget rather
  // than relying on a DPR floor that can exceed it by several times.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const backingWidth = Math.max(1, Math.round(width * fitted));
    const backingHeight = Math.max(1, Math.round(height * fitted));
    const backingPixels = backingWidth * backingHeight;
    if (backingPixels <= limits.backingPixels) break;
    fitted *= Math.sqrt(limits.backingPixels / backingPixels) * 0.999;
  }
  return fitted;
}

function pathPolygon(context, points) {
  context.beginPath(); context.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length; index += 1) context.lineTo(points[index][0], points[index][1]);
  context.closePath();
}

function spectrumAxis(light) {
  if (light.type === "bar") return [.233, .972];
  if (light.type === "laser") return [.584, .812];
  return [.938, .346];
}

function sourceRadius(frame, light) {
  const shapeScale = light.type === "laser" ? .075 : light.type === "bar" ? .48 : 1;
  return Math.max(1, frame.viewport.height * light.radius * light.beamWidth * shapeScale);
}

function fanTravel(frame, light, x, y) {
  const dx=x-light.x,dy=y-light.y;
  if(light.type==="total")return 0;
  if(light.type==="point-bar")return Math.abs(dx);
  if(light.type==="bar"||light.type==="laser"){const[axisX,axisY]=spectrumAxis(light);return Math.abs(dx*-axisY+dy*axisX);}
  return Math.hypot(dx,dy);
}

function sourceRadiusAt(frame,light,x,y){return sourceRadius(frame,light)*(1+light.fanout*Math.min(2,fanTravel(frame,light,x,y)/Math.max(1,frame.viewport.height))*1.8);}
function fanOpacity(frame,light,x,y){return Math.exp(-light.fanout*fanTravel(frame,light,x,y)/Math.max(1,frame.viewport.height)*1.15);}

function drawSourceShape(context, frame, light, color, alpha, composite = "screen") {
  if (!light.enabled || light.intensity <= 0) return;
  const { width, height } = frame.viewport;
  const x = light.x, y = light.y;
  context.save(); context.globalCompositeOperation = composite;
  if(light.type==="total"){
    context.fillStyle=rgb(color,clamp(alpha,0,1));context.fillRect(0,0,width,height);
  }else if(light.type==="ripple"){
    const cycle=(frame.time*Math.max(.02,light.speed)*.22)%1,ring=cycle*Math.hypot(width,height)*.9,ringWidth=Math.max(2,sourceRadius(frame,light)*(.12+cycle*light.fanout*.32)),outer=Math.max(4,ring+ringWidth*2),gradient=context.createRadialGradient(x,y,0,x,y,outer);
    if(ring<=ringWidth){gradient.addColorStop(0,rgb(color,clamp(alpha*Math.pow(1-cycle,5),0,1)));gradient.addColorStop(Math.min(.98,ringWidth/outer),rgb(color,clamp(alpha*(1-cycle*.72),0,1)));gradient.addColorStop(1,"rgba(0,0,0,0)");}
    else{gradient.addColorStop(0,"rgba(0,0,0,0)");gradient.addColorStop(clamp((ring-ringWidth)/outer,0,.98),"rgba(0,0,0,0)");gradient.addColorStop(clamp(ring/outer,.01,.99),rgb(color,clamp(alpha*(1-cycle*.72),0,1)));gradient.addColorStop(clamp((ring+ringWidth)/outer,.02,1),"rgba(0,0,0,0)");}
    context.fillStyle=gradient;context.fillRect(0,0,width,height);
  }else if (light.type === "point" || light.type === "point-bar") {
    const radius = Math.max(4, sourceRadius(frame, light)*(1+light.fanout*.75));
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, rgb(color, clamp(alpha, 0, 1)));
    gradient.addColorStop(.32, rgb(color, clamp(alpha * .5, 0, .85)));
    gradient.addColorStop(1, "rgba(0,0,0,0)"); context.fillStyle = gradient;
    if (light.type === "point-bar") { context.translate(x,y); context.scale(2.25,1); context.translate(-x,-y); }
    context.fillRect(0,0,width,height);
  } else {
    context.translate(x,y); context.rotate(light.type === "laser" ? -.62 : -.24);
    const span = Math.max(2, height * light.radius * light.beamWidth * (light.type === "laser" ? .075 : .48));
    const extent=width*1.6,endSpan=span*(1+light.fanout*Math.min(2,extent/Math.max(1,height))*1.8);
    context.beginPath();context.moveTo(-extent,-endSpan);context.lineTo(0,-span);context.lineTo(extent,-endSpan);context.lineTo(extent,endSpan);context.lineTo(0,span);context.lineTo(-extent,endSpan);context.closePath();context.clip();
    if(light.fanout>0){const fade=context.createRadialGradient(0,0,0,0,0,extent);fade.addColorStop(0,rgb(color,clamp(alpha,0,1)));fade.addColorStop(1,"rgba(0,0,0,0)");context.fillStyle=fade;}
    else{const gradient=context.createLinearGradient(0,-span,0,span);gradient.addColorStop(0,"rgba(0,0,0,0)");gradient.addColorStop(.5,rgb(color,clamp(alpha,0,1)));gradient.addColorStop(1,"rgba(0,0,0,0)");context.fillStyle=gradient;}
    context.fillRect(-extent,-endSpan,extent*2,endSpan*2);
  }
  context.restore();
}

function drawPrismaticRays(context,frame,light,neutral,halfWidth){
  const {width,height}=frame.viewport,axis=spectrumAxis(light),tangent=[-axis[1],axis[0]],extent=Math.hypot(width,height)*1.15;
  context.save();context.globalCompositeOperation="screen";context.lineCap="round";
  if(light.type==="point"||light.type==="point-bar"||light.type==="ripple"){
    const count=56;
    for(let index=0;index<count;index+=1){const normalized=index/(count-1)*2-1,angle=index/count*Math.PI*2,variance=.45+.55*Math.sin(index*12.9898)**2,length=sourceRadius(frame,light)*(1.15+light.fanout*1.8)*(.45+variance);
      const color=spectralBeamColor(normalized,light.prism,neutral,light.prismMode),gradient=context.createLinearGradient(light.x,light.y,light.x+Math.cos(angle)*length,light.y+Math.sin(angle)*length);gradient.addColorStop(0,rgb(neutral,.9));gradient.addColorStop(.16,rgb(color,.72*variance));gradient.addColorStop(1,"rgba(0,0,0,0)");context.strokeStyle=gradient;context.lineWidth=1.2+variance*4.5;context.beginPath();context.moveTo(light.x,light.y);context.lineTo(light.x+Math.cos(angle)*length,light.y+Math.sin(angle)*length);context.stroke();}
  }else{
    const count=48;
    for(let index=0;index<count;index+=1){const normalized=index/(count-1)*2-1,variance=.38+.62*Math.sin(index*18.731)**2,offset=normalized*halfWidth,color=spectralBeamColor(normalized,light.prism,neutral,light.prismMode),startX=light.x+axis[0]*offset-tangent[0]*extent,startY=light.y+axis[1]*offset-tangent[1]*extent,endX=light.x+axis[0]*offset+tangent[0]*extent,endY=light.y+axis[1]*offset+tangent[1]*extent,gradient=context.createLinearGradient(startX,startY,endX,endY);gradient.addColorStop(0,"rgba(0,0,0,0)");gradient.addColorStop(.5,rgb(color,.82*variance));gradient.addColorStop(1,"rgba(0,0,0,0)");context.strokeStyle=gradient;context.lineWidth=1+variance*5;context.beginPath();context.moveTo(startX,startY);context.lineTo(endX,endY);context.stroke();}
  }
  context.restore();
}

function sourceGradient(context, frame, light, spectralContext, spectralCanvas, dpr) {
  context.fillStyle = "#000104"; context.fillRect(0,0,frame.viewport.width,frame.viewport.height);
  if (!light.enabled) return;
  const neutral=light.prismMode==="solid"?light.color:mix(light.white,light.color,.12);
  if (light.prism <= 0) { drawSourceShape(context,frame,light,neutral,Math.min(1,light.intensity*.82)); return; }
  spectralContext.save();spectralContext.setTransform(1,0,0,1,0,0);spectralContext.clearRect(0,0,spectralCanvas.width,spectralCanvas.height);spectralContext.restore();
  spectralContext.setTransform(dpr,0,0,dpr,0,0);
  const axis=spectrumAxis(light),prismAmount=clamp(light.prism/12,0,1);
  const halfWidth=light.type==="total"?Math.hypot(frame.viewport.width,frame.viewport.height)*.58:sourceRadius(frame,light)*(1+light.fanout*1.4)*(light.type==="ripple"?(.12+.3*prismAmount):(.18+(1.12-.18)*prismAmount));
  const gradient=spectralContext.createLinearGradient(light.x-axis[0]*halfWidth,light.y-axis[1]*halfWidth,light.x+axis[0]*halfWidth,light.y+axis[1]*halfWidth);
  for(let index=0;index<=256;index+=1){const position=index/256,normalized=position*2-1;gradient.addColorStop(position,rgb(spectralBeamColor(normalized,light.prism,neutral,light.prismMode),spectralBeamOpacity(normalized,light.prism)));}
  spectralContext.save();spectralContext.globalAlpha=.18;spectralContext.fillStyle=gradient;spectralContext.fillRect(0,0,frame.viewport.width,frame.viewport.height);spectralContext.restore();
  drawPrismaticRays(spectralContext,frame,light,neutral,halfWidth);
  drawSourceShape(spectralContext,frame,light,[1,1,1],Math.min(1,light.intensity*.82),"destination-in");
  context.save();context.setTransform(1,0,0,1,0,0);context.globalCompositeOperation="screen";context.drawImage(spectralCanvas,0,0);context.restore();
}

function drawGapParticles(context, frame, color) {
  context.save(); context.globalCompositeOperation="screen"; context.fillStyle=rgb(color);context.shadowColor=rgb(color);context.shadowBlur=8;
  for(let index=0;index<frame.gapInstanceCount;index+=1){const offset=index*4;context.globalAlpha=frame.gapInstances[offset+3];context.beginPath();context.arc(frame.gapInstances[offset],frame.gapInstances[offset+1],frame.gapInstances[offset+2],0,Math.PI*2);context.fill();}
  context.restore();
}

function tileShift(centerX,centerY,height,radius,frame,settings){const dx=centerX-frame.viewport.width/2,dy=centerY-frame.viewport.height/2,length=Math.max(1,Math.hypot(dx,dy)),pixels=height*radius*1.18;return[dx/length*pixels*settings.perspectiveStrength*.34,dy/length*pixels*settings.perspectiveStrength*.34-pixels*.42];}
function sourceInfluence(frame, light, x, y, offset = 0) {
  if (!light.enabled) return 0;
  if(light.type==="total")return light.intensity;
  const [axisX,axisY]=spectrumAxis(light);let dx=x-(light.x+axisX*offset),dy=y-(light.y+axisY*offset),distance;
  if(light.type==="ripple"){const cycle=(frame.time*Math.max(.02,light.speed)*.22)%1,ring=cycle*Math.hypot(frame.viewport.width,frame.viewport.height)*.9,width=Math.max(2,sourceRadius(frame,light)*(.12+cycle*light.fanout*.32)),crest=Math.exp(-(((Math.hypot(dx,dy)-ring)/width)**2)),impact=Math.exp(-((Math.hypot(dx,dy)/Math.max(1,sourceRadius(frame,light)*.3))**2))*((1-cycle)**5);return(crest*(1-cycle*.72)+impact)*fanOpacity(frame,light,x,y)*light.intensity;}
  if(light.type==="point-bar")dx=Math.sign(dx)*Math.max(0,Math.abs(dx)-frame.viewport.width*.16);
  if(light.type==="bar"||light.type==="laser")distance=Math.abs(dx*axisX+dy*axisY);
  else distance=Math.hypot(dx,dy);
  return Math.exp(-((distance / sourceRadiusAt(frame,light,x,y)) ** 2)) * fanOpacity(frame,light,x,y) * light.intensity;
}

function prismSample(frame, light, x, y) {
  const neutral=light.prismMode==="solid"?light.color:mix(light.white,light.color,.12);
  if (!light.enabled) return { color: neutral, influence: 0, spectrumAmount: 0 };
  const [axisX,axisY]=spectrumAxis(light),prismAmount=clamp(light.prism/12,0,1);
  let halfWidth=sourceRadiusAt(frame,light,x,y)*(.18+(1.12-.18)*prismAmount),signedOffset=(x-light.x)*axisX+(y-light.y)*axisY;
  if(light.type==="ripple"){const cycle=(frame.time*Math.max(.02,light.speed)*.22)%1;halfWidth=sourceRadiusAt(frame,light,x,y)*(.12+.3*prismAmount);signedOffset=Math.hypot(x-light.x,y-light.y)-cycle*Math.hypot(frame.viewport.width,frame.viewport.height)*.9;}
  else if(light.type==="total"){halfWidth=Math.hypot(frame.viewport.width,frame.viewport.height)*.58;signedOffset=(x-frame.viewport.width*.5)*axisX+(y-frame.viewport.height*.5)*axisY;}
  const normalizedDistance=signedOffset/halfWidth;
  return { color: spectralBeamColor(normalizedDistance,light.prism,neutral,light.prismMode), influence: sourceInfluence(frame,light,x,y)*spectralBeamOpacity(normalizedDistance,light.prism), spectrumAmount: smoothstep(0,.15,prismAmount)*spectralBeamOpacity(normalizedDistance,12) };
}

function emberPatternMask(settings,frame,x,y){if(settings.emberPattern==="organic")return 1;const px=(x-frame.viewport.width*.5)/Math.max(1,frame.viewport.height),py=(y-frame.viewport.height*.5)/Math.max(1,frame.viewport.height),radial=Math.hypot(px,py);if(settings.emberPattern==="rings")return(.5+.5*Math.cos(radial*44-frame.time*1.8))**12;if(settings.emberPattern==="hexagon"){const qx=Math.abs(px),qy=Math.abs(py),hex=Math.max(qx*.8660254+qy*.5,qy);return 1-smoothstep(.012,.035,Math.abs(hex-.34));}const target=.27+.11*Math.cos(Math.atan2(py,px)*6);return 1-smoothstep(.012,.04,Math.abs(radial-target));}

function polygonCentroid(points){const total=points.reduce((sum,point)=>[sum[0]+point[0],sum[1]+point[1]],[0,0]);return[total[0]/points.length,total[1]/points.length];}
function scalePolygon(points,center,scale){return points.map(([x,y])=>[center[0]+(x-center[0])*scale,center[1]+(y-center[1])*scale]);}
function facetDirection(mode,facet){if(mode==="cairo-pentagon"){const angle=Math.PI/2-facet*Math.PI/2;return[Math.cos(angle),-Math.sin(angle)];}if(mode==="hexagram"){const angle=facet*Math.PI/6;return[Math.cos(angle),Math.sin(angle)];}return facet===0?[.25,.433]:facet===1?[-.5,0]:[.25,-.433];}

function drawTiles(context,frame,settings,light){
  const material=MATERIALS[settings.material],darkBase=[.004,.006,.008],baseWhite=settings.tileBase==="white"?[.93,.925,.89]:[.055,.06,.064],base=mix(darkBase,baseWhite,settings.foregroundIllumination),customColors=diamondTileColors(settings),emberColors=[hexToRgb(settings.emberColorA),hexToRgb(settings.emberColorB)],gapScale=1-settings.gapWidth,mode=settings.tessellationMode;
  for(let index=0;index<frame.grid.tiles.length;index+=1){const offset=index*8,centerX=frame.tileInstances[offset],centerY=frame.tileInstances[offset+1],radius=frame.tileInstances[offset+2],height=frame.tileInstances[offset+3],phase=frame.tileInstances[offset+4],pulse=frame.tileInstances[offset+5],separation=frame.tileInstances[offset+6],pattern=frame.tileInstances[offset+7];
    let baseFacets=tessellationFacets(mode,centerX,centerY,radius,mode==="cairo-pentagon"?1:Math.max(.04,gapScale-separation*.14));
    if(mode==="cairo-pentagon")baseFacets=baseFacets.map((points)=>scalePolygon(points,polygonCentroid(points),Math.max(.04,1-settings.gapWidth*1.5-separation*.08)));
    const tops=[],facetBases=[];
    for(let facet=0;facet<baseFacets.length;facet+=1){const paletteIndex=facetPaletteIndex(facet,pattern,settings),facetBase=settings.customDiamondColorsEnabled?mix(darkBase,customColors[paletteIndex],settings.foregroundIllumination):base;facetBases.push(facetBase);const facetHeight=height+Math.sin(frame.time*settings.facetReliefSpeed*Math.PI*2+phase+facet*2.094)*settings.facetRelief;const shift=tileShift(centerX,centerY,facetHeight,radius,frame,settings);const direction=facetDirection(mode,facet),length=Math.max(.001,Math.hypot(...direction)),sx=direction[0]/length*radius*separation*.48,sy=direction[1]/length*radius*separation*.48;
      const bottom=baseFacets[facet].map(([x,y])=>[x+sx,y+sy]);const top=bottom.map(([x,y])=>[x+shift[0],y+shift[1]]);tops.push(top);
      for(let edge=0;edge<bottom.length;edge+=1){const next=(edge+1)%bottom.length;pathPolygon(context,[bottom[edge],bottom[next],top[next],top[edge]]);context.fillStyle=rgb(mix([.002,.004,.006],facetBase,.14+edge*.03));context.fill();}
    }
    const source=sourceInfluence(frame,light,centerX,centerY);const prism=prismSample(frame,light,centerX,centerY);const neutralSource=source*(1-.92*prism.spectrumAmount);
    for(let facet=0;facet<tops.length;facet+=1){const surface=facetBases[facet].map(value=>value*(.72+material.specular*.2+neutralSource*.3));const emberWave=.55+.45*Math.sin(frame.time*2.6+phase+facet*2.094),ember=pulse*emberWave*emberPatternMask(settings,frame,centerX,centerY);let color=mix(surface,mix(emberColors[0],emberColors[1],emberWave),clamp(ember,0,.9));
      if(prism.influence>0&&prism.spectrumAmount>0)color=mix(color,prism.color,clamp(prism.influence*(.06+.16*material.specular)*prism.spectrumAmount,0,.94));
      pathPolygon(context,tops[facet]);context.fillStyle=rgb(color);context.fill();
    }
  }
}

export function createCanvasRenderer(canvas){
  const context=canvas.getContext("2d",{alpha:false});if(!context)return{available:false,fallbackReason:"canvas2d-unavailable",dispose(){}};
  const frameCanvas=document.createElement("canvas"),frameContext=frameCanvas.getContext("2d",{alpha:false});if(!frameContext)return{available:false,fallbackReason:"canvas2d-unavailable",dispose(){}};
  const spectralCanvas=document.createElement("canvas"),spectralContext=spectralCanvas.getContext("2d",{alpha:true});if(!spectralContext)return{available:false,fallbackReason:"canvas2d-unavailable",dispose(){}};
  let dpr=1,disposed=false;
  function resize(width,height,requestedDpr,settings){dpr=fitCanvasDpr(width,height,requestedDpr,settings);for(const target of[canvas,frameCanvas,spectralCanvas]){target.width=Math.max(1,Math.round(width*dpr));target.height=Math.max(1,Math.round(height*dpr));if(target.style){target.style.width=`${width}px`;target.style.height=`${height}px`;}}}
  function render(frame,settings,lights){if(disposed)return{status:"disposed",drawCalls:0};const startedAt=performance.now();frameContext.setTransform(dpr,0,0,dpr,0,0);sourceGradient(frameContext,frame,lights.behind,spectralContext,spectralCanvas,dpr);drawGapParticles(frameContext,frame,meshEnergyColor(frame.time,settings));drawTiles(frameContext,frame,settings,lights.front);context.save();context.setTransform(1,0,0,1,0,0);context.globalCompositeOperation="copy";context.drawImage(frameCanvas,0,0);context.restore();const limits=canvasQualityLimits(settings.quality),mesh=settings.tessellationMode==="cairo-pentagon"?"cairo-four-pentagon":settings.tessellationMode==="hexagram"?"hexagram-twelve-facet":"bounded-three-prism";return{status:"rendered",drawCalls:1,tileInstances:frame.grid.tiles.length,tileBudget:limits.tiles,minimumIdleMs:limits.minimumIdleMs,renderDurationMs:performance.now()-startedAt,gapInstances:frame.gapInstanceCount,dpr,mesh};}
  return{available:true,fallbackReason:null,resize,render,dispose(){disposed=true;}};
}
