import { diamondTileColors, hexToRgb, kelvinToRgb, meshEnergyColor } from "../color.js";
import { MATERIALS } from "../config.js";

const FULLSCREEN_VERTEX = `#version 300 es
precision highp float;
const vec2 P[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));
void main(){gl_Position=vec4(P[gl_VertexID],0.,1.);}`;

const BACKGROUND_FRAGMENT = `#version 300 es
precision highp float; out vec4 outColor;
uniform vec2 uResolution,uLightPosition; uniform vec3 uLightColor,uWhiteColor;
uniform float uLightIntensity,uPrism,uLightRadius,uBeamWidth,uFanout,uLightSpeed,uEnabled,uTime,uMaskPass; uniform int uLightType,uPrismMode;
float capsule(vec2 p,vec2 a,vec2 b){vec2 pa=p-a,ba=b-a;float h=clamp(dot(pa,ba)/max(.001,dot(ba,ba)),0.,1.);return length(pa-ba*h);}
float baseRadius(){return max(1.,uResolution.y*uLightRadius*(uLightType==3?.075:uLightType==2?.48:1.)*uBeamWidth);}
vec2 spectrumAxis(){if(uLightType==2)return normalize(vec2(.24,1.));if(uLightType==3)return normalize(vec2(.72,1.));return normalize(vec2(.84,.31));}
float fanTravel(vec2 p){vec2 delta=p-uLightPosition;if(uLightType==5)return 0.;if(uLightType==1)return abs(delta.x);if(uLightType==2||uLightType==3){vec2 axis=spectrumAxis();return abs(dot(delta,vec2(-axis.y,axis.x)));}return length(delta);}
float fanScale(vec2 p){return 1.+uFanout*clamp(fanTravel(p)/max(1.,uResolution.y),0.,2.)*1.8;}
float fanOpacity(vec2 p){return exp(-uFanout*fanTravel(p)/max(1.,uResolution.y)*1.15);}
float distanceToSource(vec2 p){vec2 s=uLightPosition;
 if(uLightType==0||uLightType==4)return length(p-s);
 if(uLightType==1)return capsule(p,s-vec2(uResolution.x*.16,0.),s+vec2(uResolution.x*.16,0.));
 if(uLightType==2)return abs(dot(p-s,normalize(vec2(.24,1.))));
 if(uLightType==3)return abs(dot(p-s,normalize(vec2(.72,1.))));return 0.;}
float localRadius(vec2 p){return baseRadius()*fanScale(p);}
float rippleCycle(){return fract(uTime*max(.02,uLightSpeed)*.22);}
float influence(vec2 p){if(uLightType==5)return 1.;if(uLightType==4){float cycle=rippleCycle(),extent=length(uResolution)*.9,ring=cycle*extent,width=max(2.,baseRadius()*(.12+cycle*uFanout*.32));float crest=exp(-pow((length(p-uLightPosition)-ring)/width,2.));float impact=exp(-pow(length(p-uLightPosition)/max(1.,baseRadius()*.3),2.))*pow(1.-cycle,5.);return(crest*(1.-cycle*.72)+impact)*fanOpacity(p);}return exp(-pow(distanceToSource(p)/localRadius(p),2.))*fanOpacity(p);}
const float ROYGBIP_HUES[7]=float[7](0.,.075,.155,.36,.60,.71,.82);
vec3 hueGradient(float hue){return clamp(abs(mod(hue*6.+vec3(0.,4.,2.),6.)-3.)-1.,0.,1.);}
vec3 visibleSpectrum(float t){float scaled=clamp(t,0.,1.)*6.;int segment=min(int(floor(scaled)),5);float hue=mix(ROYGBIP_HUES[segment],ROYGBIP_HUES[segment+1],scaled-float(segment));return hueGradient(hue);}
float gradientNoise(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))))-.5;}
float rayField(vec2 p){
 vec2 delta=p-uLightPosition;float slow=uTime*.075;float narrow,wide;
 if(uLightType<=1){
  float angle=atan(delta.y,delta.x);
  narrow=pow(.5+.5*sin(angle*53.+sin(angle*17.)*2.1+slow),14.);
  wide=pow(.5+.5*sin(angle*19.-sin(angle*7.)*1.7-slow*.7),8.);
 }else{
  float spreadCoordinate=dot(delta,spectrumAxis())/fanScale(p);
  narrow=pow(.5+.5*sin(spreadCoordinate*.115+sin(spreadCoordinate*.027)*2.4+slow),14.);
  wide=pow(.5+.5*sin(spreadCoordinate*.041-sin(spreadCoordinate*.013)*1.8-slow*.7),8.);
 }
 return clamp(.08+narrow*.72+wide*.48,0.,1.25);
}
vec3 prismColor(vec3 neutral,vec3 spectrum,float distance,float amount){
 float mixAmount=amount;
 if(uPrismMode==1){float whiteCore=1.-smoothstep(.05,.36,abs(distance));mixAmount*=1.-whiteCore*.96;}
 else if(uPrismMode==2){float fringe=smoothstep(.34,.62,abs(distance))*(1.-smoothstep(.95,1.24,abs(distance)));mixAmount*=fringe;}
 return mix(neutral,spectrum,mixAmount);
}
void main(){vec2 p=vec2(gl_FragCoord.x,uResolution.y-gl_FragCoord.y);
 float body=influence(p);float prismAmount=clamp(uPrism/12.,0.,1.);
 float spectralHalfWidth=localRadius(p)*mix(.18,1.12,prismAmount);
 float signedDistance=dot(p-uLightPosition,spectrumAxis());
 if(uLightType==4){spectralHalfWidth=localRadius(p)*mix(.12,.42,prismAmount);signedDistance=length(p-uLightPosition)-rippleCycle()*length(uResolution)*.9;}
 else if(uLightType==5){spectralHalfWidth=length(uResolution)*.58;signedDistance=dot(p-uResolution*.5,spectrumAxis());}
 float normalizedDistance=signedDistance/spectralHalfWidth;
 float spectrumCoordinate=clamp(.5+normalizedDistance*.5/.82,0.,1.);
 float spectrumWindow=1.-smoothstep(.96,1.34,abs(normalizedDistance));
 float spectrumMix=smoothstep(0.,.15,prismAmount)*spectrumWindow;
 float beamMask=mix(1.,spectrumWindow,prismAmount);
 vec3 neutral=uPrismMode==3?uLightColor:mix(uWhiteColor,uLightColor,.12);
 vec3 beamColor=prismColor(neutral,visibleSpectrum(spectrumCoordinate),normalizedDistance,spectrumMix);
 beamColor=clamp(beamColor+vec3(gradientNoise(gl_FragCoord.xy)/255.)*spectrumMix,0.,1.);
 float rays=rayField(p);float emitterCore=uLightType==5?0.:exp(-pow(distanceToSource(p)/max(1.,baseRadius()*.16),2.))*(uLightType==4?pow(1.-rippleCycle(),5.):1.);
 vec3 spectralRays=beamColor*body*beamMask*(.13+rays*2.35)*(1.+1.15*spectrumMix);
 vec3 radiance=spectralRays*mix(.25,1.,uMaskPass)+neutral*emitterCore*(2.2+uPrism*.055);
 float vignette=1.-.34*pow(length((p-uResolution*.5)/uResolution),1.3);
 vec3 base=vec3(.0015,.0025,.0045)*vignette;
 vec3 emission=radiance*uLightIntensity;float peak=max(max(emission.r,emission.g),emission.b);
 outColor=vec4(base+emission/(1.+peak)*uEnabled,1.);}`;

const TILE_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec2 aLocal; layout(location=1) in float aLift;
layout(location=2) in float aFacet; layout(location=3) in float aSurface;
layout(location=4) in vec4 aTileA; layout(location=5) in vec4 aTileB;
uniform vec2 uResolution; uniform float uGapWidth,uPerspective,uFacetRelief,uFacetSpeed,uTime;uniform int uTessellation;
out vec2 vScreen; flat out float vFacet,vSurface,vPhase,vPulse,vPattern; out float vHeight;
vec2 facetDirection(float face){
 if(uTessellation==1){float angle=1.5707963-face*1.5707963;return vec2(cos(angle),-sin(angle));}
 if(uTessellation==2){float angle=face*.5235988;return vec2(cos(angle),sin(angle));}
 if(face<.5)return normalize(vec2(.25,.4330127));if(face<1.5)return vec2(-1.,0.);return normalize(vec2(.25,-.4330127));}
void main(){vec2 center=aTileA.xy;float radius=aTileA.z;
 float facetHeight=aTileA.w+sin(uTime*uFacetSpeed*6.2831853+aTileB.x+aFacet*2.0943951)*uFacetRelief;
 float separation=aTileB.z;float scale=max(.04,1.-uGapWidth-separation*.14);
 vec2 local=aLocal*radius*scale+facetDirection(aFacet)*radius*separation*.48;
 float heightPixels=facetHeight*radius*1.18;vec2 radial=center-uResolution*.5;
 vec2 direction=length(radial)>1.?normalize(radial):vec2(0.,-1.);
 vec2 parallax=direction*heightPixels*uPerspective*.34+vec2(0.,-heightPixels*.42);
 vec2 position=center+local+parallax*aLift;
 gl_Position=vec4(position.x/uResolution.x*2.-1.,1.-position.y/uResolution.y*2.,0.,1.);
 vScreen=position;vFacet=aFacet;vSurface=aSurface;vPhase=aTileB.x;vPulse=aTileB.y;vPattern=aTileB.w;vHeight=facetHeight;}`;

const TILE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vScreen; flat in float vFacet,vSurface,vPhase,vPulse,vPattern; in float vHeight; out vec4 outColor;
uniform vec2 uResolution,uLightPosition;uniform vec3 uLightColor,uWhiteColor,uMaterial,uDiamondColorA,uDiamondColorB,uDiamondColorC,uEmberColorA,uEmberColorB;
uniform float uForeground,uLightIntensity,uLightRadius,uBeamWidth,uFanout,uLightSpeed,uPrism,uEnabled,uTime;uniform int uTileBase,uLightType,uPrismMode,uCustomDiamondColors,uEmberPattern,uPatternRotation,uPatternMirror;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
float capsule(vec2 p,vec2 a,vec2 b){vec2 pa=p-a,ba=b-a;float h=clamp(dot(pa,ba)/max(.001,dot(ba,ba)),0.,1.);return length(pa-ba*h);}
float shapedRadius(int kind,float radius,float beamWidth){return max(1.,uResolution.y*radius*(kind==3?.075:kind==2?.48:1.)*beamWidth);}
vec2 shapedAxis(int kind){if(kind==2)return normalize(vec2(.24,1.));if(kind==3)return normalize(vec2(.72,1.));return normalize(vec2(.84,.31));}
float fanTravel(vec2 p,vec2 s,int kind){vec2 delta=p-s;if(kind==5)return 0.;if(kind==1)return abs(delta.x);if(kind==2||kind==3){vec2 axis=shapedAxis(kind);return abs(dot(delta,vec2(-axis.y,axis.x)));}return length(delta);}
float localRadius(vec2 p,vec2 s,int kind,float radius,float beamWidth,float fanout){return shapedRadius(kind,radius,beamWidth)*(1.+fanout*clamp(fanTravel(p,s,kind)/max(1.,uResolution.y),0.,2.)*1.8);}
float fanOpacity(vec2 p,vec2 s,int kind,float fanout){return exp(-fanout*fanTravel(p,s,kind)/max(1.,uResolution.y)*1.15);}
float sourceAt(vec2 p,vec2 s,int kind,float radius,float beamWidth,float fanout){float d;
 if(kind==5)return 1.;if(kind==4){float cycle=fract(uTime*max(.02,uLightSpeed)*.22),ring=cycle*length(uResolution)*.9,width=max(2.,shapedRadius(kind,radius,beamWidth)*(.12+cycle*fanout*.32));float crest=exp(-pow((length(p-s)-ring)/width,2.));float impact=exp(-pow(length(p-s)/max(1.,shapedRadius(kind,radius,beamWidth)*.3),2.))*pow(1.-cycle,5.);return(crest*(1.-cycle*.72)+impact)*fanOpacity(p,s,kind,fanout);}
 if(kind==0)d=length(p-s);else if(kind==1)d=capsule(p,s-vec2(uResolution.x*.16,0.),s+vec2(uResolution.x*.16,0.));
 else d=abs(dot(p-s,shapedAxis(kind)));return exp(-pow(d/localRadius(p,s,kind,radius,beamWidth,fanout),2.))*fanOpacity(p,s,kind,fanout);}
float sourceRadius(vec2 p){return localRadius(p,uLightPosition,uLightType,uLightRadius,uBeamWidth,uFanout);}
vec2 spectrumAxis(){return shapedAxis(uLightType);}
float source(vec2 p){return sourceAt(p,uLightPosition,uLightType,uLightRadius,uBeamWidth,uFanout);}
const float ROYGBIP_HUES[7]=float[7](0.,.075,.155,.36,.60,.71,.82);
vec3 hueGradient(float hue){return clamp(abs(mod(hue*6.+vec3(0.,4.,2.),6.)-3.)-1.,0.,1.);}
vec3 visibleSpectrum(float t){float scaled=clamp(t,0.,1.)*6.;int segment=min(int(floor(scaled)),5);float hue=mix(ROYGBIP_HUES[segment],ROYGBIP_HUES[segment+1],scaled-float(segment));return hueGradient(hue);}
float gradientNoise(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))))-.5;}
vec3 prismColor(vec3 neutral,vec3 spectrum,float distance,float amount){
 float mixAmount=amount;
 if(uPrismMode==1){float whiteCore=1.-smoothstep(.05,.36,abs(distance));mixAmount*=1.-whiteCore*.96;}
 else if(uPrismMode==2){float fringe=smoothstep(.34,.62,abs(distance))*(1.-smoothstep(.95,1.24,abs(distance)));mixAmount*=fringe;}
 return mix(neutral,spectrum,mixAmount);
}
float emberPatternMask(vec2 screen){if(uEmberPattern==0)return 1.;vec2 p=(screen-uResolution*.5)/max(1.,uResolution.y);float radial=length(p);if(uEmberPattern==1)return pow(.5+.5*cos(radial*44.-uTime*1.8),12.);if(uEmberPattern==2){vec2 q=abs(p);float hex=max(q.x*.8660254+q.y*.5,q.y);return 1.-smoothstep(.012,.035,abs(hex-.34));}float angle=atan(p.y,p.x),target=.27+.11*cos(angle*6.);return 1.-smoothstep(.012,.04,abs(radial-target));}
void main(){float rough=uMaterial.x,specular=uMaterial.y,grain=uMaterial.z;
 float body=source(vScreen)*uLightIntensity*uEnabled;float prismAmount=clamp(uPrism/12.,0.,1.);
 float spectralHalfWidth=sourceRadius(vScreen)*mix(.18,1.12,prismAmount);float signedDistance=dot(vScreen-uLightPosition,spectrumAxis());
 if(uLightType==4){spectralHalfWidth=sourceRadius(vScreen)*mix(.12,.42,prismAmount);signedDistance=length(vScreen-uLightPosition)-fract(uTime*max(.02,uLightSpeed)*.22)*length(uResolution)*.9;}
 else if(uLightType==5){spectralHalfWidth=length(uResolution)*.58;signedDistance=dot(vScreen-uResolution*.5,spectrumAxis());}
 float normalizedDistance=signedDistance/spectralHalfWidth;
 float spectrumCoordinate=clamp(.5+normalizedDistance*.5/.82,0.,1.);
 float spectrumWindow=1.-smoothstep(.96,1.34,abs(normalizedDistance));
 float spectrumMix=smoothstep(0.,.15,prismAmount)*spectrumWindow;
 float beamMask=mix(1.,spectrumWindow,prismAmount);body*=beamMask;
 vec3 neutral=uPrismMode==3?uLightColor:mix(uWhiteColor,uLightColor,.12);vec3 beamColor=prismColor(neutral,visibleSpectrum(spectrumCoordinate),normalizedDistance,spectrumMix);
 beamColor=clamp(beamColor+vec3(gradientNoise(gl_FragCoord.xy)/255.)*spectrumMix,0.,1.);
 float noise=(hash(floor(vScreen*(.18+rough*.35))+vPhase)-.5)*grain;
 bool side=vSurface>=0.;vec3 darkBase=vec3(.004,.006,.008);vec3 whiteBase=vec3(.93,.925,.89);
 int facetIndex=int(floor(vFacet+.5));int paletteIndex=(facetIndex*(uPatternMirror==1?-1:1)+uPatternRotation+int(floor(vPattern+.5)))%3;if(paletteIndex<0)paletteIndex+=3;
 vec3 selectedDiamond=paletteIndex==0?uDiamondColorA:(paletteIndex==1?uDiamondColorB:uDiamondColorC);
 vec3 base=uCustomDiamondColors==1?mix(darkBase,selectedDiamond,uForeground):(uTileBase==0?mix(darkBase,whiteBase,uForeground):mix(darkBase,vec3(.055,.06,.064),uForeground));
 float faceLight=side?.13+.055*mod(vSurface,4.):.72+specular*.2;
 float neutralDiffuse=body*(.26+.5*specular)*mix(1.,.08,spectrumMix);
 vec3 emission=beamColor*body*(.22+.85*specular+.25*(1.-rough))*(1.+1.2*spectrumMix);
 float emissionPeak=max(max(emission.r,emission.g),emission.b);emission/=1.+emissionPeak;
 vec3 lit=base*(faceLight+neutralDiffuse)+emission+noise;
 float emberWave=.55+.45*sin(uTime*2.6+vPhase+vFacet*2.0943951);float ember=vPulse*emberWave*emberPatternMask(vScreen);
 vec3 emberColor=mix(uEmberColorA,uEmberColorB,emberWave);lit=mix(lit,emberColor,clamp(ember,0.,.9));
 if(side)lit*=.32+clamp(max(0.,vHeight)*.13,0.,.78);
 outColor=vec4(max(lit,vec3(0.)),1.);}`;

const OCCLUDER_FRAGMENT = `#version 300 es
precision highp float;out vec4 outColor;
void main(){outColor=vec4(0.,0.,0.,1.);}`;

const SHAFT_FRAGMENT = `#version 300 es
precision highp float;out vec4 outColor;
uniform sampler2D uLightMask;uniform vec2 uTextureResolution,uLightUv;uniform vec3 uShaftWhite;uniform float uShaftStrength;uniform int uShaftType;
void main(){
 vec2 uv=gl_FragCoord.xy/uTextureResolution;
 vec2 stepVector=uShaftType==5?normalize(vec2(-.58,.82))*.011:(uLightUv-uv)*.025;
 vec3 accumulated=vec3(0.);float decay=1.;
 for(int index=0;index<32;index++){
  uv+=stepVector;vec3 sampleColor=texture(uLightMask,clamp(uv,vec2(0.),vec2(1.))).rgb;
  float energy=max(max(sampleColor.r,sampleColor.g),sampleColor.b);
  accumulated+=sampleColor*smoothstep(.02,.4,energy)*decay;decay*=.956;
 }
 vec2 rayVector=gl_FragCoord.xy/uTextureResolution-uLightUv;rayVector.x*=uTextureResolution.x/uTextureResolution.y;
 float angle=atan(rayVector.y,rayVector.x);float fine=pow(.5+.5*sin(angle*71.+sin(angle*19.)*2.2),16.);float broad=pow(.5+.5*sin(angle*29.-sin(angle*11.)*1.6),9.);float secondary=pow(.5+.5*cos(angle*113.+sin(angle*31.)),22.);float rayProfile=.3+fine*.82+broad*.4+secondary*.2;
 vec3 opticalDepth=accumulated*(uShaftStrength/11.)*rayProfile;
 vec3 shafts=vec3(1.)-exp(-opticalDepth*2.35);float spectralPeak=max(max(shafts.r,shafts.g),shafts.b);float hotCore=smoothstep(.18,.86,spectralPeak);shafts=mix(shafts,uShaftWhite*spectralPeak,.18+hotCore*.24);float peak=max(max(shafts.r,shafts.g),shafts.b);
 outColor=vec4(shafts,clamp(.35+peak,0.,1.));
}`;

const PARTICLE_VERTEX = `#version 300 es
precision highp float;layout(location=0) in vec4 aParticle;uniform vec2 uResolution;out float vAlpha;
void main(){gl_Position=vec4(aParticle.x/uResolution.x*2.-1.,1.-aParticle.y/uResolution.y*2.,0.,1.);gl_PointSize=max(1.,aParticle.z*2.);vAlpha=aParticle.w;}`;
const PARTICLE_FRAGMENT = `#version 300 es
precision highp float;in float vAlpha;out vec4 outColor;uniform vec3 uColor;
void main(){float d=length(gl_PointCoord-.5)*2.;outColor=vec4(uColor*1.8,smoothstep(1.,0.,d)*vAlpha);}`;

function shader(gl,type,source){const value=gl.createShader(type);gl.shaderSource(value,source);gl.compileShader(value);if(!gl.getShaderParameter(value,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(value)||"Shader compile error";gl.deleteShader(value);throw new Error(message);}return value;}
function makeProgram(gl,vertexSource,fragmentSource){const value=gl.createProgram(),vertex=shader(gl,gl.VERTEX_SHADER,vertexSource),fragment=shader(gl,gl.FRAGMENT_SHADER,fragmentSource);gl.attachShader(value,vertex);gl.attachShader(value,fragment);gl.linkProgram(value);gl.deleteShader(vertex);gl.deleteShader(fragment);if(!gl.getProgramParameter(value,gl.LINK_STATUS)){const message=gl.getProgramInfoLog(value)||"Program link error";gl.deleteProgram(value);throw new Error(message);}return value;}

function pushVertex(output,point,lift,facet,surface){output.push(point[0],point[1],lift,facet,surface);}
function pushTriangle(output,a,b,c,liftA,liftB,liftC,facet,surface){pushVertex(output,a,liftA,facet,surface);pushVertex(output,b,liftB,facet,surface);pushVertex(output,c,liftC,facet,surface);}
function polygonCentroid(points){const total=points.reduce((sum,point)=>[sum[0]+point[0],sum[1]+point[1]],[0,0]);return[total[0]/points.length,total[1]/points.length];}
function insetPolygon(points,amount){const center=polygonCentroid(points);return points.map((point)=>[center[0]+(point[0]-center[0])*amount,center[1]+(point[1]-center[1])*amount]);}
function appendPolygon(sides,tops,points,facet){
  for(let edge=0;edge<points.length;edge+=1){const a=points[edge],b=points[(edge+1)%points.length];pushTriangle(sides,a,b,b,0,0,1,facet,edge);pushTriangle(sides,a,b,a,0,1,1,facet,edge);}
  for(let index=1;index<points.length-1;index+=1)pushTriangle(tops,points[0],points[index],points[index+1],1,1,1,facet,-1);
}
function createTileMeshes(mode){
  const vertices=Array.from({length:6},(_,index)=>[Math.cos(index*Math.PI/3),Math.sin(index*Math.PI/3)]);
  const sides=[],tops=[];
  let facets;
  if(mode==="cairo-pentagon"){
    const p={a:[-11/14,0],b:[-3/14,1],c:[3/14,1],d:[11/14,0],e:[3/14,-1],f:[-3/14,-1],lt:[-.5,.5],mt:[0,3/14],rt:[.5,.5],mb:[0,-3/14],rb:[.5,-.5],lb:[-.5,-.5]};
    facets=[[p.b,p.c,p.rt,p.mt,p.lt],[p.d,p.rb,p.mb,p.mt,p.rt],[p.e,p.f,p.lb,p.mb,p.rb],[p.a,p.lt,p.mt,p.mb,p.lb]].map((points)=>insetPolygon(points,.985));
  }else if(mode==="hexagram"){
    const star=Array.from({length:12},(_,index)=>{const angle=index*Math.PI/6,radius=index%2===0?1:.5;return[Math.cos(angle)*radius,Math.sin(angle)*radius];});
    facets=star.map((point,index)=>[[0,0],point,star[(index+1)%star.length]]);
  }else facets=[[ [0,0],vertices[0],vertices[1],vertices[2] ],[ [0,0],vertices[2],vertices[3],vertices[4] ],[ [0,0],vertices[4],vertices[5],vertices[0] ]];
  for(let facet=0;facet<facets.length;facet+=1){
    appendPolygon(sides,tops,facets[facet],facet);
  }
  return {sides:new Float32Array(sides),tops:new Float32Array(tops)};
}
function tessellationIndex(mode){return Math.max(0,["rhombille","cairo-pentagon","hexagram"].indexOf(mode));}
function lightTypeIndex(type){return Math.max(0,["point","point-bar","bar","laser","ripple","total"].indexOf(type));}
function prismModeIndex(mode){return Math.max(0,["neon","white-core","white-fringe","solid"].indexOf(mode));}
function emberPatternIndex(pattern){return Math.max(0,["organic","rings","hexagon","star"].indexOf(pattern));}
function createVao(gl,mesh,instanceBuffer){const vao=gl.createVertexArray();gl.bindVertexArray(vao);const meshBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,meshBuffer);gl.bufferData(gl.ARRAY_BUFFER,mesh,gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,20,0);
  for(let index=1;index<4;index+=1){gl.enableVertexAttribArray(index);gl.vertexAttribPointer(index,1,gl.FLOAT,false,20,8+(index-1)*4);}
  gl.bindBuffer(gl.ARRAY_BUFFER,instanceBuffer);for(let index=0;index<2;index+=1){const location=4+index;gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,4,gl.FLOAT,false,32,index*16);gl.vertexAttribDivisor(location,1);}gl.bindVertexArray(null);return{vao,meshBuffer,vertexCount:mesh.length/5};}
const uniformCaches=new WeakMap();
function uniformLocation(gl,target,name){let cache=uniformCaches.get(target);if(!cache){cache=new Map();uniformCaches.set(target,cache);}if(!cache.has(name))cache.set(name,gl.getUniformLocation(target,name));return cache.get(name);}
function setVec2(gl,target,name,x,y){const location=uniformLocation(gl,target,name);if(location!==null)gl.uniform2f(location,x,y);}
function setVec3(gl,target,name,value){const location=uniformLocation(gl,target,name);if(location!==null)gl.uniform3f(location,value[0],value[1],value[2]);}
function setFloat(gl,target,name,value){const location=uniformLocation(gl,target,name);if(location!==null)gl.uniform1f(location,value);}
function setInt(gl,target,name,value){const location=uniformLocation(gl,target,name);if(location!==null)gl.uniform1i(location,value);}

function lightUniforms(gl,target,frame,light,maskPass=false){setVec2(gl,target,"uResolution",frame.viewport.width,frame.viewport.height);setVec2(gl,target,"uLightPosition",light.x,light.y);setVec3(gl,target,"uLightColor",light.color);setVec3(gl,target,"uWhiteColor",light.white);setFloat(gl,target,"uLightIntensity",light.intensity);setFloat(gl,target,"uLightRadius",light.radius);setFloat(gl,target,"uBeamWidth",light.beamWidth);setFloat(gl,target,"uFanout",light.fanout);setFloat(gl,target,"uLightSpeed",light.speed);setFloat(gl,target,"uPrism",light.prism);setFloat(gl,target,"uEnabled",light.enabled?1:0);setFloat(gl,target,"uTime",frame.time);setFloat(gl,target,"uMaskPass",maskPass?1:0);setInt(gl,target,"uLightType",lightTypeIndex(light.type));setInt(gl,target,"uPrismMode",prismModeIndex(light.prismMode));}

export function createWebGlRenderer(canvas,onStateChange=()=>{}){
  const gl=canvas.getContext("webgl2",{alpha:false,antialias:true,depth:false,stencil:false,failIfMajorPerformanceCaveat:true,powerPreference:"high-performance",premultipliedAlpha:true,preserveDrawingBuffer:false,desynchronized:false});
  if(!gl)return{available:false,fallbackReason:"webgl2-unavailable",dispose(){}};
  if(gl.getParameter(gl.MAX_TEXTURE_SIZE)<256||gl.getParameter(gl.MAX_VERTEX_ATTRIBS)<6)return{available:false,fallbackReason:"insufficient-capability",dispose(){gl.getExtension("WEBGL_lose_context")?.loseContext();}};
  let disposed=false,contextLost=false,programs,buffers,sideMeshes,topMeshes,lightMaskTexture,lightMaskFramebuffer,renderedFrames=0,lastError=gl.NO_ERROR;const lose=gl.getExtension("WEBGL_lose_context");
  const initialize=()=>{programs={background:makeProgram(gl,FULLSCREEN_VERTEX,BACKGROUND_FRAGMENT),tile:makeProgram(gl,TILE_VERTEX,TILE_FRAGMENT),occluder:makeProgram(gl,TILE_VERTEX,OCCLUDER_FRAGMENT),shaft:makeProgram(gl,FULLSCREEN_VERTEX,SHAFT_FRAGMENT),particle:makeProgram(gl,PARTICLE_VERTEX,PARTICLE_FRAGMENT)};buffers={tile:gl.createBuffer(),gap:gl.createBuffer()};sideMeshes={};topMeshes={};for(const mode of["rhombille","cairo-pentagon","hexagram"]){const meshes=createTileMeshes(mode);sideMeshes[mode]=createVao(gl,meshes.sides,buffers.tile);topMeshes[mode]=createVao(gl,meshes.tops,buffers.tile);}lightMaskTexture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,lightMaskTexture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,Math.max(1,canvas.width),Math.max(1,canvas.height),0,gl.RGBA,gl.UNSIGNED_BYTE,null);lightMaskFramebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,lightMaskFramebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,lightMaskTexture,0);gl.bindFramebuffer(gl.FRAMEBUFFER,null);};
  try{initialize();}catch(error){return{available:false,fallbackReason:"gpu-initialization-failed",error,dispose(){}};}
  const lost=(event)=>{event.preventDefault();contextLost=true;onStateChange({status:"context-lost",fallbackReason:"context-lost"});};
  const restored=()=>{try{initialize();contextLost=false;onStateChange({status:"restored",fallbackReason:null});}catch{onStateChange({status:"context-lost",fallbackReason:"gpu-initialization-failed"});}};
  canvas.addEventListener("webglcontextlost",lost);canvas.addEventListener("webglcontextrestored",restored);
  function resize(width,height,dpr){canvas.width=Math.max(1,Math.round(width*dpr));canvas.height=Math.max(1,Math.round(height*dpr));canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;gl.bindTexture(gl.TEXTURE_2D,lightMaskTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,canvas.width,canvas.height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);gl.bindTexture(gl.TEXTURE_2D,null);gl.viewport(0,0,canvas.width,canvas.height);}
  function render(frame,settings,lights){
    if(disposed)return{status:"disposed",drawCalls:0,tileInstances:0};if(contextLost)return{status:"context-lost",drawCalls:0,tileInstances:0};
    const mode=sideMeshes[settings.tessellationMode]?settings.tessellationMode:"rhombille",sideMesh=sideMeshes[mode],topMesh=topMeshes[mode],modeIndex=tessellationIndex(mode);
    gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.bindBuffer(gl.ARRAY_BUFFER,buffers.tile);gl.bufferData(gl.ARRAY_BUFFER,frame.tileInstances,gl.DYNAMIC_DRAW);let drawCalls=0;

    gl.bindFramebuffer(gl.FRAMEBUFFER,lightMaskFramebuffer);gl.viewport(0,0,canvas.width,canvas.height);gl.disable(gl.BLEND);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(programs.background);lightUniforms(gl,programs.background,frame,lights.behind,true);gl.drawArrays(gl.TRIANGLES,0,3);drawCalls+=1;
    gl.useProgram(programs.occluder);setVec2(gl,programs.occluder,"uResolution",frame.viewport.width,frame.viewport.height);setFloat(gl,programs.occluder,"uGapWidth",settings.gapWidth);setFloat(gl,programs.occluder,"uPerspective",settings.perspectiveStrength);setFloat(gl,programs.occluder,"uFacetRelief",settings.facetRelief);setFloat(gl,programs.occluder,"uFacetSpeed",settings.facetReliefSpeed);setFloat(gl,programs.occluder,"uTime",frame.time);setInt(gl,programs.occluder,"uTessellation",modeIndex);
    gl.bindVertexArray(sideMesh.vao);gl.drawArraysInstanced(gl.TRIANGLES,0,sideMesh.vertexCount,frame.grid.tiles.length);drawCalls+=1;gl.bindVertexArray(topMesh.vao);gl.drawArraysInstanced(gl.TRIANGLES,0,topMesh.vertexCount,frame.grid.tiles.length);drawCalls+=1;gl.bindVertexArray(null);

    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);gl.useProgram(programs.background);lightUniforms(gl,programs.background,frame,lights.behind);gl.drawArrays(gl.TRIANGLES,0,3);drawCalls+=1;
    if(frame.gapInstanceCount>0){gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.useProgram(programs.particle);setVec2(gl,programs.particle,"uResolution",frame.viewport.width,frame.viewport.height);setVec3(gl,programs.particle,"uColor",meshEnergyColor(frame.time,settings));gl.bindBuffer(gl.ARRAY_BUFFER,buffers.gap);gl.bufferData(gl.ARRAY_BUFFER,frame.gapInstances.subarray(0,frame.gapInstanceCount*4),gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,4,gl.FLOAT,false,16,0);gl.drawArrays(gl.POINTS,0,frame.gapInstanceCount);drawCalls+=1;}
    gl.disable(gl.BLEND);gl.useProgram(programs.tile);lightUniforms(gl,programs.tile,frame,lights.front);const material=MATERIALS[settings.material],diamondColors=diamondTileColors(settings);setVec3(gl,programs.tile,"uMaterial",[material.roughness,material.specular,material.grain]);setVec3(gl,programs.tile,"uDiamondColorA",diamondColors[0]);setVec3(gl,programs.tile,"uDiamondColorB",diamondColors[1]);setVec3(gl,programs.tile,"uDiamondColorC",diamondColors[2]);setVec3(gl,programs.tile,"uEmberColorA",hexToRgb(settings.emberColorA));setVec3(gl,programs.tile,"uEmberColorB",hexToRgb(settings.emberColorB));setFloat(gl,programs.tile,"uGapWidth",settings.gapWidth);setFloat(gl,programs.tile,"uPerspective",settings.perspectiveStrength);setFloat(gl,programs.tile,"uFacetRelief",settings.facetRelief);setFloat(gl,programs.tile,"uFacetSpeed",settings.facetReliefSpeed);setFloat(gl,programs.tile,"uForeground",settings.foregroundIllumination);setFloat(gl,programs.tile,"uTime",frame.time);setInt(gl,programs.tile,"uTileBase",settings.tileBase==="white"?0:1);setInt(gl,programs.tile,"uCustomDiamondColors",settings.customDiamondColorsEnabled?1:0);setInt(gl,programs.tile,"uEmberPattern",emberPatternIndex(settings.emberPattern));setInt(gl,programs.tile,"uTessellation",modeIndex);setInt(gl,programs.tile,"uPatternRotation",settings.patternRotation);setInt(gl,programs.tile,"uPatternMirror",settings.patternMirror?1:0);
    gl.bindVertexArray(sideMesh.vao);gl.drawArraysInstanced(gl.TRIANGLES,0,sideMesh.vertexCount,frame.grid.tiles.length);drawCalls+=1;
    gl.bindVertexArray(topMesh.vao);gl.drawArraysInstanced(gl.TRIANGLES,0,topMesh.vertexCount,frame.grid.tiles.length);drawCalls+=1;gl.bindVertexArray(null);
    if(lights.behind.enabled&&lights.behind.intensity>0){gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.ONE,gl.ONE,gl.ZERO,gl.ONE);gl.useProgram(programs.shaft);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,lightMaskTexture);setInt(gl,programs.shaft,"uLightMask",0);setVec2(gl,programs.shaft,"uTextureResolution",canvas.width,canvas.height);setVec2(gl,programs.shaft,"uLightUv",lights.behind.x/Math.max(1,frame.viewport.width),1-lights.behind.y/Math.max(1,frame.viewport.height));setVec3(gl,programs.shaft,"uShaftWhite",lights.behind.prismMode==="solid"?lights.behind.color:lights.behind.white);const shaftScale=lights.behind.type==="ripple"?.18:1;setFloat(gl,programs.shaft,"uShaftStrength",Math.min(3,Math.sqrt(lights.behind.intensity)*(.55+lights.behind.prism/12*.85))*shaftScale);setInt(gl,programs.shaft,"uShaftType",lightTypeIndex(lights.behind.type));gl.drawArrays(gl.TRIANGLES,0,3);gl.bindTexture(gl.TEXTURE_2D,null);drawCalls+=1;}
    renderedFrames+=1;if(renderedFrames===1||renderedFrames%120===0)lastError=gl.getError();return{status:lastError===gl.NO_ERROR?"rendered":"gl-error",glError:lastError,drawCalls,tileInstances:frame.grid.tiles.length,gapInstances:frame.gapInstanceCount,mesh:mode==="rhombille"?"bounded-three-prism":mode==="cairo-pentagon"?"cairo-four-pentagon":"hexagram-twelve-facet",lightShaftSamples:32};
  }
  return{available:true,fallbackReason:null,resize,render,forceContextLoss(){lose?.loseContext();},forceContextRestore(){lose?.restoreContext();},dispose(){if(disposed)return;disposed=true;canvas.removeEventListener("webglcontextlost",lost);canvas.removeEventListener("webglcontextrestored",restored);Object.values(programs).forEach((value)=>gl.deleteProgram(value));Object.values(buffers).forEach((value)=>gl.deleteBuffer(value));gl.deleteTexture(lightMaskTexture);gl.deleteFramebuffer(lightMaskFramebuffer);for(const mesh of[...Object.values(sideMeshes),...Object.values(topMeshes)])gl.deleteBuffer(mesh.meshBuffer);}};
}

function rainbow(time,speed){const hue=(time*speed*60)%360;return hslToRgb(hue);}
function hslToRgb(hue){const h=((hue%360)+360)%360/60;const sector=Math.floor(h);const fraction=h-sector;return [[1,fraction,0],[1-fraction,1,0],[0,1,fraction],[0,1-fraction,1],[fraction,0,1],[1,0,1-fraction]][sector];}
function resolveRig(frame,settings,pointer,prefix,phase){const key=(suffix)=>settings[`${prefix}${suffix}`];const motion=key("LightMotion");let x,y;
  if(motion==="pointer"&&settings.pointerLightDepthEnabled&&pointer?.active){x=pointer.x;y=pointer.y;}
  else if(motion==="fixed"||motion==="pointer"){x=frame.viewport.width*key("LightFixedX");y=frame.viewport.height*key("LightFixedY");}
  else if(motion==="wander"){const clock=frame.time*key("LightSpeed");x=frame.viewport.width*(.5+.3*Math.sin(clock*.71+phase)+.11*Math.sin(clock*1.83+phase*.4));y=frame.viewport.height*(.5+.28*Math.cos(clock*.57+phase)+.09*Math.sin(clock*1.39+phase));}
  else{const clock=frame.time*key("LightSpeed");x=frame.viewport.width*(.5+.34*Math.sin(clock*.91+phase));y=frame.viewport.height*(.5+.32*Math.cos(clock*.73+phase));}
  const prismMode=key("PrismMode");return{enabled:key("LightEnabled"),type:key("LightType"),x,y,color:key("RainbowCycle")?rainbow(frame.time,key("RainbowSpeed")):hexToRgb(key("LightColor")),white:kelvinToRgb(key("WhiteTemperatureKelvin")),intensity:key("LightIntensity"),radius:key("LightRadius"),beamWidth:key("LightBeamWidth"),fanout:key("LightFanout"),speed:key("LightSpeed"),prism:prismMode==="solid"?0:key("PrismStrength"),prismMode};}
export function resolveLights(frame,settings,pointer){return{behind:resolveRig(frame,settings,pointer,"behind",0.37),front:resolveRig(frame,settings,pointer,"front",2.41)};}
