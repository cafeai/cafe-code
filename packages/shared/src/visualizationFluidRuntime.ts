/** Canonical finite admission bound for helper counters in diagnostic fixtures.
 * It is not an execution allowance, clock, resource quota or native authority.
 * The ordinary-page source uses the same built-in Number.MAX_SAFE_INTEGER. */
export const VISUALIZATION_FLUID_DIAGNOSTIC_COUNTER_MAX = Number.MAX_SAFE_INTEGER;

/** Fixed ordinary-page library adapted from the user-supplied MIT fluid implementation.
 * Solver/shader/palette/orbit equations are retained; Cafe changes only bounded
 * allocation/work/lifecycle, final display gain, transparency and unused disabled
 * bloom removal. Continuous motion does not change the supplied solver equations.
 * Source input SHA-256: e67688917b113eff12c54425e5a903e54e96a2512cb2f326c1c92f94b6b572ac.
 * This constant is bundled source, never a runtime filesystem read or native API.
 */
export const VISUALIZATION_FLUID_RUNTIME_SOURCE = `    /*
     * WebGL Fluid Simulation — Pavel Dobryakov — MIT License.
     * Adapted for bounded generated-document decoration; solver equations retained.
     *
     * Copyright (c) Pavel Dobryakov
     *
     * Permission is hereby granted, free of charge, to any person obtaining a
     * copy of this software and associated documentation files (the "Software"),
     * to deal in the Software without restriction, including without limitation
     * the rights to use, copy, modify, merge, publish, distribute, sublicense,
     * and/or sell copies of the Software, and to permit persons to whom the
     * Software is furnished to do so, subject to the following conditions:
     *
     * The above copyright notice and this permission notice shall be included
     * in all copies or substantial portions of the Software.
     *
     * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
     * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
     * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
     * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
     * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
     * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
     * DEALINGS IN THE SOFTWARE.
     */

(() => {
  'use strict';
  // The marker is ordinary page presentation, never host/source authority.
  // No marker means no WebGL context, observers, texture, listener set or RAF.
  function boot() {
    const markers = document.querySelectorAll('canvas[data-cafe-fluid]');
    if (markers.length !== 1) return;
    const canvas = markers[0];
    if (!(canvas instanceof HTMLCanvasElement)) return;
    canvas.style.pointerEvents = 'none';
    canvas.setAttribute('aria-hidden', 'true');
    // Normalize only this opted-in decoration, never chart marks or text. An
    // older author may already use a quieter opacity: preserve that value and
    // cap brighter decoration once rather than watching or rewriting source.
    // This presentation scalar is not a resource or execution-security limit.
    const authoredOpacity=Number(getComputedStyle(canvas).opacity);
    const decorativeOpacity=Number.isFinite(authoredOpacity)&&authoredOpacity>=0&&authoredOpacity<=1?Math.min(.15,authoredOpacity):.15;
    canvas.style.setProperty('opacity',String(decorativeOpacity),'important');
    canvas.style.background = 'linear-gradient(135deg,rgba(0,190,255,.132),rgba(123,44,255,.132),rgba(255,40,180,.132))';
    let gl, ext, density, velocity, divergence, curl, pressure;
    let clearProgram,displayProgram,displayShadingProgram,splatProgram,advectionProgram,divergenceProgram,curlProgram,vorticityProgram,pressureProgram,gradienSubtractProgram,blit;
    let simWidth=0,simHeight=0,dyeWidth=0,dyeHeight=0;
    const textures=[],framebuffers=[],programs=[],shaders=[],buffers=[],teardown=[];
    let textureBytes=0,frames=0,rafHandle=0,lastFrame=0,resizeCount=0;
    let destroyed=false,virtualSeeded=false,orbitAngle=0,vPrevX=0,vPrevY=0,virtualColor=null;
    let pendingPointer=null,pointerInputs=0,pointerColorSteps=0,virtualColorSteps=0;
    const pointers=[{x:0,y:0,dx:0,dy:0,moved:false,color:{r:0,g:0,b:0}}];
    const splatStack=[];
    let initialized=false,waiting=false,zeroLayouts=0;
    const pendingOff=[];
    function stopWaiting(){waiting=false;for(const off of pendingOff.splice(0))off();}
    const ORBIT_RADIUS=300,ORBIT_SPEED=0.026,ORBIT_START_DELAY=700;
    const config={SIM_RESOLUTION:200,DYE_RESOLUTION:512,DENSITY_DISSIPATION:0.958,VELOCITY_DISSIPATION:0.96,PRESSURE_DISSIPATION:0.8,PRESSURE_ITERATIONS:20,CURL:42,SPLAT_RADIUS:0.22,SHADING:true};
    const motion=matchMedia('(prefers-reduced-motion: reduce)');
    const reduced=()=>motion.matches||document.documentElement.dataset.cafeReducedMotion==='true';
    // Qualified tiny/menu masking preserves the chart's logical visibility,
    // while a separate paint cue pauses only this cooperative decoration.
    // Absent paint metadata preserves older hosts and portable export behavior;
    // neither scalar grants native presentation or execution authority.
    const visible=()=>document.documentElement.dataset.cafeVisible==='true'&&document.documentElement.dataset.cafePresentationVisible!=='false'&&!document.hidden&&canvas.isConnected;
    // Counters are bounded diagnostics, never a clock or native authority. A
    // healthy visible chart must not freeze after an arbitrary lifetime count.
    const incrementCounter=value=>Math.min(Number.MAX_SAFE_INTEGER,value+1);
    const state=value=>{canvas.dataset.cafeFluidState=value;};
    const counters=()=>{canvas.dataset.cafeFluidFrames=String(frames);canvas.dataset.cafeFluidPointerInputs=String(pointerInputs);canvas.dataset.cafeFluidTextureBytes=String(textureBytes);canvas.dataset.cafeFluidTextures=String(textures.length);canvas.dataset.cafeFluidPrograms=String(programs.length);canvas.dataset.cafeFluidBuffers=String(buffers.length);canvas.dataset.cafeFluidRaf=String(rafHandle!==0);};
    function stop(){if(rafHandle)cancelAnimationFrame(rafHandle);rafHandle=0;counters();}
    function on(target,type,handler,options){target.addEventListener(type,handler,options);teardown.push(()=>target.removeEventListener(type,handler,options));}
    function clearTargets(){if(gl){for(const value of textures)gl.deleteTexture(value);for(const value of framebuffers)gl.deleteFramebuffer(value);}textures.length=framebuffers.length=0;textureBytes=0;density=velocity=divergence=curl=pressure=undefined;}
    function destroy(reason){if(destroyed)return;destroyed=true;stop();for(const off of teardown.splice(0))off();clearTargets();if(gl){for(const value of programs)gl.deleteProgram(value);for(const value of shaders)gl.deleteShader(value);for(const value of buffers)gl.deleteBuffer(value);}programs.length=shaders.length=buffers.length=0;state(reason);counters();}
    function fail(){destroy('unsupported');}
    function channels(format){return format===gl.RED?1:format===gl.RG?2:4;}
    function formatProbe(internalFormat,format,type){let texture,fbo;try{texture=gl.createTexture();fbo=gl.createFramebuffer();if(!texture||!fbo)return false;gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,internalFormat,4,4,0,format,type,null);gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);return gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;}finally{if(texture)gl.deleteTexture(texture);if(fbo)gl.deleteFramebuffer(fbo);}}
    function supportedFormat(internalFormat,format,type){if(formatProbe(internalFormat,format,type))return {internalFormat,format};if(internalFormat===gl.R16F)return supportedFormat(gl.RG16F,gl.RG,type);if(internalFormat===gl.RG16F)return supportedFormat(gl.RGBA16F,gl.RGBA,type);return null;}
    function context(){const params={alpha:true,depth:false,stencil:false,antialias:false,preserveDrawingBuffer:true};gl=canvas.getContext('webgl2',params);const modern=!!gl;if(!gl)gl=canvas.getContext('webgl',params);if(!gl)throw Error('Fluid unavailable');const half=modern?null:gl.getExtension('OES_texture_half_float');if(!modern&&!half)throw Error('Fluid unavailable');if(modern)gl.getExtension('EXT_color_buffer_float');const type=modern?gl.HALF_FLOAT:half.HALF_FLOAT_OES;const rgba=supportedFormat(modern?gl.RGBA16F:gl.RGBA,gl.RGBA,type);const rg=modern?supportedFormat(gl.RG16F,gl.RG,type):rgba;const r=modern?supportedFormat(gl.R16F,gl.RED,type):rgba;if(!rgba||!rg||!r)throw Error('Fluid unavailable');ext={formatRGBA:rgba,formatRG:rg,formatR:r,halfFloatTexType:type,supportLinearFiltering:!!gl.getExtension(modern?'OES_texture_float_linear':'OES_texture_half_float_linear')};config.SHADING=ext.supportLinearFiltering;gl.clearColor(0,0,0,0);}
    function compileShader(type,source){if(shaders.length>=12)throw Error('Fluid unavailable');const shader=gl.createShader(type);if(!shader)throw Error('Fluid unavailable');shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error('Fluid unavailable');return shader;}
    class GLProgram{constructor(vertex,fragment){if(programs.length>=10)throw Error('Fluid unavailable');this.uniforms={};this.program=gl.createProgram();if(!this.program)throw Error('Fluid unavailable');programs.push(this.program);gl.attachShader(this.program,vertex);gl.attachShader(this.program,fragment);gl.bindAttribLocation(this.program,0,'aPosition');gl.linkProgram(this.program);if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw Error('Fluid unavailable');const count=gl.getProgramParameter(this.program,gl.ACTIVE_UNIFORMS);if(!Number.isInteger(count)||count<0||count>16)throw Error('Fluid unavailable');for(let i=0;i<count;i++){const value=gl.getActiveUniform(this.program,i);this.uniforms[value.name]=gl.getUniformLocation(this.program,value.name);}}bind(){gl.useProgram(this.program);}}
    // Source dimensions keep a common ratio: SIM short side 200/max 400;
    // dye short side 512/max 1024. Extreme ratios reduce both sides, not stretch.
    function resolution(short,max){const ratio=canvas.width/canvas.height;let w=ratio>=1?Math.round(short*ratio):short,h=ratio>=1?short:Math.round(short/ratio);const scale=Math.min(1,max/Math.max(w,h));return {width:Math.max(1,Math.floor(w*scale)),height:Math.max(1,Math.floor(h*scale))};}
    function createFBO(w,h,internalFormat,format,type,param){const bytes=w*h*channels(format)*2;if(!Number.isSafeInteger(bytes)||w<1||h<1||Math.max(w,h)>1024||textures.length>=8||textureBytes+bytes>16*1024*1024)throw Error('Fluid unavailable');gl.activeTexture(gl.TEXTURE0);const texture=gl.createTexture();if(!texture)throw Error('Fluid unavailable');textures.push(texture);textureBytes+=bytes;gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,param);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,param);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,internalFormat,w,h,0,format,type,null);const fbo=gl.createFramebuffer();if(!fbo)throw Error('Fluid unavailable');framebuffers.push(fbo);gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Fluid unavailable');gl.viewport(0,0,w,h);gl.clear(gl.COLOR_BUFFER_BIT);return {texture,fbo,width:w,height:h,attach(id){gl.activeTexture(gl.TEXTURE0+id);gl.bindTexture(gl.TEXTURE_2D,texture);return id;}};}
    function createDoubleFBO(...args){let a=createFBO(...args),b=createFBO(...args);return {get read(){return a},get write(){return b},swap(){const old=a;a=b;b=old}};}
    function initFramebuffers(){const sim=resolution(200,400),dye=resolution(512,1024);simWidth=sim.width;simHeight=sim.height;dyeWidth=dye.width;dyeHeight=dye.height;const rgba=ext.formatRGBA,rg=ext.formatRG,r=ext.formatR,type=ext.halfFloatTexType,filter=ext.supportLinearFiltering?gl.LINEAR:gl.NEAREST;const bytes=2*dyeWidth*dyeHeight*channels(rgba.format)*2+2*simWidth*simHeight*channels(rg.format)*2+4*simWidth*simHeight*channels(r.format)*2;const maxTexture=gl.getParameter(gl.MAX_TEXTURE_SIZE);if(!Number.isSafeInteger(bytes)||bytes>16*1024*1024||!Number.isFinite(maxTexture)||maxTexture<Math.max(dyeWidth,dyeHeight,simWidth,simHeight))throw Error('Fluid unavailable');clearTargets();density=createDoubleFBO(dyeWidth,dyeHeight,rgba.internalFormat,rgba.format,type,filter);velocity=createDoubleFBO(simWidth,simHeight,rg.internalFormat,rg.format,type,filter);divergence=createFBO(simWidth,simHeight,r.internalFormat,r.format,type,gl.NEAREST);curl=createFBO(simWidth,simHeight,r.internalFormat,r.format,type,gl.NEAREST);pressure=createDoubleFBO(simWidth,simHeight,r.internalFormat,r.format,type,gl.NEAREST);counters();}
    // CSS can fill a wide chat column without purchasing more GPU work: both
    // drawing-buffer axes remain 1..512 and every solver/texture quota above is
    // unchanged. Even extreme logical aspects use that finite physical ratio.
    function resizeCanvas(){const rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio;if(!Number.isFinite(dpr)||dpr<=0||!Number.isFinite(rect.width)||!Number.isFinite(rect.height)||rect.width<=0||rect.height<=0||rect.width>4096||rect.height>2000){const scalar=(value,max)=>Number.isFinite(value)&&value>=0&&value<=max?String(value):'unknown';canvas.dataset.cafeFluidRejectedWidth=scalar(rect.width,4096);canvas.dataset.cafeFluidRejectedHeight=scalar(rect.height,4000);canvas.dataset.cafeFluidRejectedDpr=scalar(dpr,16);throw Error('Fluid unavailable');}const scale=Math.min(dpr,512/Math.max(rect.width,rect.height)),w=Math.max(1,Math.floor(rect.width*scale)),h=Math.max(1,Math.floor(rect.height*scale));if(canvas.width===w&&canvas.height===h&&density)return false;if(++resizeCount>8)throw Error('Fluid unavailable');clearTargets();canvas.width=w;canvas.height=h;if(ext)initFramebuffers();return true;}
    function render(){gl.disable(gl.BLEND);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.enable(gl.BLEND);const program=config.SHADING?displayShadingProgram:displayProgram;program.bind();if(config.SHADING)gl.uniform2f(program.uniforms.texelSize,1/gl.drawingBufferWidth,1/gl.drawingBufferHeight);gl.uniform1i(program.uniforms.uTexture,density.read.attach(0));blit(null);}
    function pointerPos(clientX,clientY){const rect=canvas.getBoundingClientRect();if(clientX<rect.left||clientY<rect.top||clientX>rect.right||clientY>rect.bottom)return null;return {x:(clientX-rect.left)*canvas.width/rect.width,y:(clientY-rect.top)*canvas.height/rect.height};}
    // Real passive pointer input is one latest scalar pair, consumed at most
    // once per solver frame. It neither renews work nor captures focus/scroll.
    function input(){if(pendingPointer){const point=pointerPos(pendingPointer.x,pendingPointer.y);pendingPointer=null;if(point){const p=pointers[0];p.dx=(point.x-p.x)*5;p.dy=(point.y-p.y)*5;p.x=point.x;p.y=point.y;p.moved=true;p.color=generateColor();pointerInputs=incrementCounter(pointerInputs);}}if(splatStack.length>0)multipleSplats(splatStack.pop());for(const p of pointers){if(p.moved){splat(p.x,p.y,p.dx,p.dy,p.color);p.moved=false;}}if(++pointerColorSteps>=4){pointerColorSteps=0;for(const p of pointers)p.color=generateColor();}}
    // One latest RAF at no more than thirty solver frames per second. Native
    // presentation and document visibility independently pause it; visibility
    // changes preserve the same solver targets, palette phase and orbit state.
    function schedule(){if(destroyed||rafHandle||reduced()||!visible()){if(!destroyed)state(!visible()?'paused':reduced()?'static':'running');counters();return;}rafHandle=requestAnimationFrame(update);state('running');counters();}
    function update(now){rafHandle=0;if(destroyed||reduced()||!visible()){schedule();return;}if(now-lastFrame<1000/30){schedule();return;}lastFrame=now;try{if(resizeCanvas())multipleSplats(34);driveVirtualPointer();input();step(0.016);render();frames=incrementCounter(frames);counters();schedule();}catch{fail();}}
    // Reduced-motion output still follows real visible layout. Rebuild only
    // from event delivery, never hidden/duplicate work or a static RAF loop.
    // The ordinary resize fence deletes old targets and retains its eight-size
    // admission cap; static warm-up has twelve steps, never a hidden RAF loop.
    function visibility(){stop();pendingPointer=null;if(destroyed)return;if(!canvas.isConnected){destroy('disposed');return;}if(reduced()&&visible()){try{if(resizeCanvas())warmup();}catch{fail();return;}}schedule();}
    function warmup(){multipleSplats(34);for(let i=0;i<8;i++)splatStack.push(10+Math.floor(Math.random()*10));for(let i=0;i<12;i++){input();step(0.016);frames=incrementCounter(frames);}render();counters();}
    function pointer(event){if(!event.isTrusted||!visible()||reduced()||destroyed||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY)||Math.abs(event.clientX)>1000000||Math.abs(event.clientY)>1000000)return;pendingPointer={x:event.clientX,y:event.clientY};}
    function step(dt) {
        gl.disable(gl.BLEND);
        gl.viewport(0, 0, simWidth, simHeight);

        curlProgram.bind();
        gl.uniform2f(curlProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight);
        gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
        blit(curl.fbo);

        vorticityProgram.bind();
        gl.uniform2f(vorticityProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight);
        gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
        gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
        gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
        gl.uniform1f(vorticityProgram.uniforms.dt, dt);
        blit(velocity.write.fbo);
        velocity.swap();

        divergenceProgram.bind();
        gl.uniform2f(divergenceProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight);
        gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
        blit(divergence.fbo);

        clearProgram.bind();
        gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
        gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE_DISSIPATION);
        blit(pressure.write.fbo);
        pressure.swap();

        pressureProgram.bind();
        gl.uniform2f(pressureProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight);
        gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
        for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
            gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
            blit(pressure.write.fbo);
            pressure.swap();
        }

        gradienSubtractProgram.bind();
        gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight);
        gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
        gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
        blit(velocity.write.fbo);
        velocity.swap();

        advectionProgram.bind();
        gl.uniform2f(advectionProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight);
        if (!ext.supportLinearFiltering)
            gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, 1.0 / simWidth, 1.0 / simHeight);
        let velocityId = velocity.read.attach(0);
        gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
        gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
        gl.uniform1f(advectionProgram.uniforms.dt, dt);
        gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
        blit(velocity.write.fbo);
        velocity.swap();

        gl.viewport(0, 0, dyeWidth, dyeHeight);

        if (!ext.supportLinearFiltering)
            gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, 1.0 / dyeWidth, 1.0 / dyeHeight);
        gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
        gl.uniform1i(advectionProgram.uniforms.uSource, density.read.attach(1));
        gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
        blit(density.write.fbo);
        density.swap();
    }

    function splat(x, y, dx, dy, color) {
        gl.viewport(0, 0, simWidth, simHeight);
        splatProgram.bind();
        gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
        gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
        gl.uniform2f(splatProgram.uniforms.point, x / canvas.width, 1.0 - y / canvas.height);
        gl.uniform3f(splatProgram.uniforms.color, dx, -dy, 1.0);
        gl.uniform1f(splatProgram.uniforms.radius, config.SPLAT_RADIUS / 100.0);
        blit(velocity.write.fbo);
        velocity.swap();

        gl.viewport(0, 0, dyeWidth, dyeHeight);
        gl.uniform1i(splatProgram.uniforms.uTarget, density.read.attach(0));
        gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
        blit(density.write.fbo);
        density.swap();
    }

    function multipleSplats(amount) {
        for (let i = 0; i < amount; i++) {
            const color = generateColor();
            color.r *= 10.0;
            color.g *= 10.0;
            color.b *= 10.0;
            const x = canvas.width * Math.random();
            const y = canvas.height * Math.random();
            const dx = 1000 * (Math.random() - 0.5);
            const dy = 1000 * (Math.random() - 0.5);
            splat(x, y, dx, dy, color);
        }
    }

    function driveVirtualPointer() {
        if (frames < Math.ceil(ORBIT_START_DELAY * 30 / 1000))
            return;
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const base = Math.min(ORBIT_RADIUS, canvas.width * 0.35, canvas.height * 0.35);
        const r = base * (0.72 + 0.28 * Math.sin(orbitAngle * 0.37));
        // The supplied breathing factor is 0.37 = 37/100. Both sin/cos terms
        // therefore share a 2π×100 period; wrap there without a visible seam or
        // an ever-growing argument that loses precision during long viewing.
        orbitAngle = (orbitAngle + ORBIT_SPEED) % (Math.PI * 200);
        const x = cx + Math.cos(orbitAngle) * r;
        const y = cy + Math.sin(orbitAngle) * r;
        if (!virtualSeeded) {
            virtualSeeded = true;
            vPrevX = x;
            vPrevY = y;
            return;
        }
        if (!virtualColor || ++virtualColorSteps >= 4) {
            virtualColor = generateColor();
            virtualColor.r *= 3.2;
            virtualColor.g *= 3.2;
            virtualColor.b *= 3.2;
            virtualColorSteps = 0;
        }
        const dx = (x - vPrevX) * 9.0;
        const dy = (y - vPrevY) * 9.0;
        vPrevX = x;
        vPrevY = y;
        splat(x, y, dx, dy, virtualColor);
    }

    function generateColor() {
        // Electric cyan→blue→violet→magenta band, full brightness, for a vivid,
        // slick, immersive palette.
        const h = 0.5 + Math.random() * 0.42;
        let c = HSVtoRGB(h, 0.95, 1.0);
        c.r *= 0.92;
        c.g *= 0.92;
        c.b *= 0.92;
        return c;
    }

    function HSVtoRGB(h, s, v) {
        let r, g, b, i, f, p, q, t;
        i = Math.floor(h * 6);
        f = h * 6 - i;
        p = v * (1 - s);
        q = v * (1 - f * s);
        t = v * (1 - (1 - f) * s);

        switch (i % 6) {
            case 0: r = v, g = t, b = p; break;
            case 1: r = q, g = v, b = p; break;
            case 2: r = p, g = v, b = t; break;
            case 3: r = p, g = q, b = v; break;
            case 4: r = t, g = p, b = v; break;
            case 5: r = v, g = p, b = q; break;
        }
        return { r, g, b };
    }


    function initialize() {
      if(initialized||destroyed)return;
      let rect;try{rect=canvas.getBoundingClientRect();}catch{initialized=true;stopWaiting();fail();return;}
      const dpr=window.devicePixelRatio;
      // An acknowledged native viewer initially has a genuine 0x0 DOM layout
      // while its pixels remain uncommitted. Wait only before any GPU work;
      // positive invalid layouts and every GPU failure stay terminal. Native
      // cues are presentation, not authority or a refreshed execution budget.
      if(Number.isFinite(dpr)&&dpr>0&&Number.isFinite(rect.width)&&Number.isFinite(rect.height)&&rect.width>=0&&rect.height>=0&&rect.width<=4096&&rect.height<=2000&&(rect.width===0||rect.height===0)){
        canvas.dataset.cafeFluidLayoutObservations=String(++zeroLayouts);
        if(zeroLayouts>=8){initialized=true;stopWaiting();fail();return;}
        state('waiting');counters();
        if(!waiting){
          waiting=true;
          try{
            const resize=new ResizeObserver(initialize);pendingOff.push(()=>resize.disconnect());resize.observe(canvas);
            const removal=new MutationObserver(()=>{if(!canvas.isConnected)destroy('disposed');});pendingOff.push(()=>removal.disconnect());removal.observe(canvas.parentNode,{childList:true});
            for(const type of ['cafe-visibility-changed','cafe-presentation-changed','cafe-presentation-visibility-changed']){window.addEventListener(type,initialize);pendingOff.push(()=>window.removeEventListener(type,initialize));}
            const removed=()=>destroy('disposed');window.addEventListener('pagehide',removed,{once:true});pendingOff.push(()=>window.removeEventListener('pagehide',removed));
            teardown.push(stopWaiting);
          }catch{initialized=true;stopWaiting();fail();}
        }
        return;
      }
      initialized=true;stopWaiting();
      try {
      // Size admission happens before context allocation. Unsupported layouts
      // retain the finite static local gradient and all chart foreground text.
      resizeCanvas();context();
    const baseVertexShader = compileShader(gl.VERTEX_SHADER, \`
        precision highp float;
        attribute vec2 aPosition;
        varying vec2 vUv;
        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform vec2 texelSize;
        void main () {
            vUv = aPosition * 0.5 + 0.5;
            vL = vUv - vec2(texelSize.x, 0.0);
            vR = vUv + vec2(texelSize.x, 0.0);
            vT = vUv + vec2(0.0, texelSize.y);
            vB = vUv - vec2(0.0, texelSize.y);
            gl_Position = vec4(aPosition, 0.0, 1.0);
        }
    \`);

    const clearShader = compileShader(gl.FRAGMENT_SHADER, \`
        precision mediump float;
        precision mediump sampler2D;
        varying highp vec2 vUv;
        uniform sampler2D uTexture;
        uniform float value;
        void main () {
            gl_FragColor = value * texture2D(uTexture, vUv);
        }
    \`);

    const displayShader = compileShader(gl.FRAGMENT_SHADER, \`
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        void main () {
            // Final presentation only: retain the supplied dye/solver state,
            // with ten percent more colour than the original display baseline.
            vec3 C = texture2D(uTexture, vUv).rgb * 1.1;
            float a = max(C.r, max(C.g, C.b));
            gl_FragColor = vec4(C, a);
        }
    \`);

    const displayShadingShader = compileShader(gl.FRAGMENT_SHADER, \`
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform sampler2D uTexture;
        uniform vec2 texelSize;
        void main () {
            vec3 L = texture2D(uTexture, vL).rgb;
            vec3 R = texture2D(uTexture, vR).rgb;
            vec3 T = texture2D(uTexture, vT).rgb;
            vec3 B = texture2D(uTexture, vB).rgb;
            vec3 C = texture2D(uTexture, vUv).rgb;
            float dx = length(R) - length(L);
            float dy = length(T) - length(B);
            vec3 n = normalize(vec3(dx, dy, length(texelSize)));
            vec3 l = vec3(0.0, 0.0, 1.0);
            float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
            C.rgb *= diffuse * 1.1;
            float a = max(C.r, max(C.g, C.b));
            gl_FragColor = vec4(C, a);
        }
    \`);

    const splatShader = compileShader(gl.FRAGMENT_SHADER, \`
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        uniform sampler2D uTarget;
        uniform float aspectRatio;
        uniform vec3 color;
        uniform vec2 point;
        uniform float radius;
        void main () {
            vec2 p = vUv - point.xy;
            p.x *= aspectRatio;
            vec3 splat = exp(-dot(p, p) / radius) * color;
            vec3 base = texture2D(uTarget, vUv).xyz;
            gl_FragColor = vec4(base + splat, 1.0);
        }
    \`);

    const advectionManualFilteringShader = compileShader(gl.FRAGMENT_SHADER, \`
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uSource;
        uniform vec2 texelSize;
        uniform vec2 dyeTexelSize;
        uniform float dt;
        uniform float dissipation;
        vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
            vec2 st = uv / tsize - 0.5;
            vec2 iuv = floor(st);
            vec2 fuv = fract(st);
            vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
            vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
            vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
            vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
            return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
        }
        void main () {
            vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
            gl_FragColor = dissipation * bilerp(uSource, coord, dyeTexelSize);
            gl_FragColor.a = 1.0;
        }
    \`);

    const advectionShader = compileShader(gl.FRAGMENT_SHADER, \`
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uSource;
        uniform vec2 texelSize;
        uniform float dt;
        uniform float dissipation;
        void main () {
            vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
            gl_FragColor = dissipation * texture2D(uSource, coord);
            gl_FragColor.a = 1.0;
        }
    \`);

    const divergenceShader = compileShader(gl.FRAGMENT_SHADER, \`
        precision mediump float;
        precision mediump sampler2D;
        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D uVelocity;
        void main () {
            float L = texture2D(uVelocity, vL).x;
            float R = texture2D(uVelocity, vR).x;
            float T = texture2D(uVelocity, vT).y;
            float B = texture2D(uVelocity, vB).y;
            vec2 C = texture2D(uVelocity, vUv).xy;
            if (vL.x < 0.0) { L = -C.x; }
            if (vR.x > 1.0) { R = -C.x; }
            if (vT.y > 1.0) { T = -C.y; }
            if (vB.y < 0.0) { B = -C.y; }
            float div = 0.5 * (R - L + T - B);
            gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
        }
    \`);

    const curlShader = compileShader(gl.FRAGMENT_SHADER, \`
        precision mediump float;
        precision mediump sampler2D;
        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D uVelocity;
        void main () {
            float L = texture2D(uVelocity, vL).y;
            float R = texture2D(uVelocity, vR).y;
            float T = texture2D(uVelocity, vT).x;
            float B = texture2D(uVelocity, vB).x;
            float vorticity = R - L - T + B;
            gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
        }
    \`);

    const vorticityShader = compileShader(gl.FRAGMENT_SHADER, \`
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform sampler2D uVelocity;
        uniform sampler2D uCurl;
        uniform float curl;
        uniform float dt;
        void main () {
            float L = texture2D(uCurl, vL).x;
            float R = texture2D(uCurl, vR).x;
            float T = texture2D(uCurl, vT).x;
            float B = texture2D(uCurl, vB).x;
            float C = texture2D(uCurl, vUv).x;
            vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
            force /= length(force) + 0.0001;
            force *= curl * C;
            force.y *= -1.0;
            vec2 vel = texture2D(uVelocity, vUv).xy;
            gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
        }
    \`);

    const pressureShader = compileShader(gl.FRAGMENT_SHADER, \`
        precision mediump float;
        precision mediump sampler2D;
        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D uPressure;
        uniform sampler2D uDivergence;
        vec2 boundary (vec2 uv) {
            return uv;
        }
        void main () {
            float L = texture2D(uPressure, boundary(vL)).x;
            float R = texture2D(uPressure, boundary(vR)).x;
            float T = texture2D(uPressure, boundary(vT)).x;
            float B = texture2D(uPressure, boundary(vB)).x;
            float C = texture2D(uPressure, vUv).x;
            float divergence = texture2D(uDivergence, vUv).x;
            float pressure = (L + R + B + T - divergence) * 0.25;
            gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
        }
    \`);

    const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, \`
        precision mediump float;
        precision mediump sampler2D;
        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D uPressure;
        uniform sampler2D uVelocity;
        vec2 boundary (vec2 uv) {
            return uv;
        }
        void main () {
            float L = texture2D(uPressure, boundary(vL)).x;
            float R = texture2D(uPressure, boundary(vR)).x;
            float T = texture2D(uPressure, boundary(vT)).x;
            float B = texture2D(uPressure, boundary(vB)).x;
            vec2 velocity = texture2D(uVelocity, vUv).xy;
            velocity.xy -= vec2(R - L, T - B);
            gl_FragColor = vec4(velocity, 0.0, 1.0);
        }
    \`);

      clearProgram=new GLProgram(baseVertexShader,clearShader),displayProgram=new GLProgram(baseVertexShader,displayShader),displayShadingProgram=new GLProgram(baseVertexShader,displayShadingShader),splatProgram=new GLProgram(baseVertexShader,splatShader),advectionProgram=new GLProgram(baseVertexShader,ext.supportLinearFiltering?advectionShader:advectionManualFilteringShader),divergenceProgram=new GLProgram(baseVertexShader,divergenceShader),curlProgram=new GLProgram(baseVertexShader,curlShader),vorticityProgram=new GLProgram(baseVertexShader,vorticityShader),pressureProgram=new GLProgram(baseVertexShader,pressureShader),gradienSubtractProgram=new GLProgram(baseVertexShader,gradientSubtractShader);
      const vertices=gl.createBuffer();if(!vertices)throw Error('Fluid unavailable');buffers.push(vertices);const indices=gl.createBuffer();if(!indices)throw Error('Fluid unavailable');buffers.push(indices);gl.bindBuffer(gl.ARRAY_BUFFER,vertices);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,-1,1,1,1,1,-1]),gl.STATIC_DRAW);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indices);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2,0,2,3]),gl.STATIC_DRAW);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);gl.enableVertexAttribArray(0);
      blit=destination=>{gl.bindFramebuffer(gl.FRAMEBUFFER,destination);gl.drawElements(gl.TRIANGLES,6,gl.UNSIGNED_SHORT,0);};
      initFramebuffers();

      // All solver work uses the supplied equations. Hidden posters receive
      // twelve bounded warm-up steps, not a perpetual hidden animation loop.
      // Preserve the supplied dense 34-splat entrance plus its eight 10..19
      // follow-up waves. The stack is fixed at eight; twelve finite warm-up
      // steps solve/drain it before a hidden poster, never hidden RAF delivery.
      warmup();
      on(window,'pointermove',pointer,{passive:true});
      on(document,'visibilitychange',visibility);
      on(window,'cafe-visibility-changed',visibility);
      on(window,'cafe-presentation-changed',visibility);
      on(window,'cafe-presentation-visibility-changed',visibility);
      on(motion,'change',visibility);
      on(window,'pagehide',()=>destroy('disposed'),{once:true});
      on(canvas,'webglcontextlost',()=>destroy('context-lost'),{once:true});
      const resize=new ResizeObserver(()=>{if(destroyed)return;if(!canvas.isConnected){destroy('disposed');return;}visibility();});teardown.push(()=>resize.disconnect());resize.observe(canvas);
      // An exact own-canvas removal releases resources without any perpetual
      // observer or RAF after disposal. No scan/reconfiguration API is exposed.
      const removal=new MutationObserver(()=>{if(!canvas.isConnected)destroy('disposed');});teardown.push(()=>removal.disconnect());removal.observe(canvas.parentNode,{childList:true});
      schedule();
      }catch{fail();}
    }
    initialize();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
`;

/** Embedding is generated-only and preserves immutable received HTML verbatim. */
export function visualizationFluidScript(kind: "generated" | "mcp-app"): string {
  return kind === "generated" ? "<script>" + VISUALIZATION_FLUID_RUNTIME_SOURCE + "</script>" : "";
}
