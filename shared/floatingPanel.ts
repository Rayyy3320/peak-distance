// 页面外壳只负责定位，设置与工作区运行在扩展源 iframe 内。
export function initFloatingPanel() {
  let host: HTMLElement | null = null;
  let normalOpen = false;
  let x: number | null = null, y = 24;
  let frameReady=false;
  let readyCallbacks: Array<(ok:boolean)=>void>=[];
  let observedSubs:Element|null=null;
  const subtitlesResize=new ResizeObserver(()=>place());
  const hide = () => { if(host) host.hidden = true; document.dispatchEvent(new Event('pd-panel-layout')); };
  const place = () => {
    if (!host) return;
    const parent = document.fullscreenElement ?? document.documentElement;
    const subs=document.getElementById('blc-subs');
    if(subs!==observedSubs){subtitlesResize.disconnect();if(subs)subtitlesResize.observe(subs);observedSubs=subs;}
    const reserved=document.fullscreenElement?Math.max(160,(document.getElementById('blc-subs')?.offsetHeight??80)+88):12;
    const player=document.getElementById('movie_player')?.getBoundingClientRect();
    const safeBottom=document.fullscreenElement?innerHeight-reserved:player&&player.bottom>260&&player.top<innerHeight?Math.min(innerHeight-12,player.bottom-64):innerHeight-12;
    host.style.maxHeight=`${Math.max(180,safeBottom-24)}px`;
    if (host.parentElement !== parent) {
      const movable = parent as Element & {moveBefore?:(node:Node,child:Node|null)=>void};
      if(host.isConnected && movable.moveBefore) movable.moveBefore(host,null); else parent.append(host);
    }
    host.style.left = `${Math.max(12, Math.min(x ?? innerWidth - 412, innerWidth - host.offsetWidth - 12))}px`;
    host.style.top = `${Math.max(12,Math.min(y,safeBottom-host.offsetHeight))}px`;
    document.dispatchEvent(new Event('pd-panel-layout'));
  };
  const show = async (view?:string) => {
    if(!host) {
      host = document.createElement('aside'); host.id = 'pd-floating-panel';
      host.style.cssText = 'position:fixed;width:min(400px,calc(100vw - 24px));height:min(720px,calc(100dvh - 32px));z-index:2147483645;';
      const root = host.attachShadow({mode:'open'});
      root.innerHTML = `<style>:host{color-scheme:light}.shell{height:100%;display:flex;flex-direction:column;overflow:hidden;border:1px solid #ddd9cf;border-radius:12px;background:#f7f4ec;box-shadow:0 12px 40px #0003}.drag{border:0;background:#e9e6df;color:#59636b;height:16px;flex:none;cursor:move;touch-action:none;font:12px/12px system-ui}.drag:focus-visible{outline:2px solid #1a5fc4;outline-offset:-2px}iframe{border:0;width:100%;flex:1;min-height:0;background:#f7f4ec}</style><div class="shell"><button class="drag" aria-label="拖动面板，方向键移动">⋯</button><iframe title="Peak Distance 学习面板" allow="clipboard-write"></iframe></div>`;
      const frame = root.querySelector('iframe')!;
      frame.src = browser.runtime.getURL('/sidepanel.html') + '?floating=1';
      const drag = root.querySelector<HTMLElement>('.drag')!;
      drag.addEventListener('pointerdown', e => {
        const bounds = host!.getBoundingClientRect(), sx=e.clientX, sy=e.clientY;
        drag.setPointerCapture(e.pointerId);
        const move = (ev:PointerEvent) => {x=bounds.left+ev.clientX-sx;y=bounds.top+ev.clientY-sy;place();};
        const stop = () => {drag.removeEventListener('pointermove',move);drag.removeEventListener('pointerup',stop);};
        drag.addEventListener('pointermove',move);drag.addEventListener('pointerup',stop);
      });
      drag.addEventListener('keydown', e => {if(e.key.startsWith('Arrow')) {e.preventDefault(); const r=host!.getBoundingClientRect();x=r.left+(e.key==='ArrowRight'?16:e.key==='ArrowLeft'?-16:0);y=r.top+(e.key==='ArrowDown'?16:e.key==='ArrowUp'?-16:0);place();}});
      host.addEventListener('keydown', e=>{e.stopPropagation();if(e.key==='Escape')hide();});
    }
    host.hidden = false; place();
    if(frameReady)return {ok:true};
    const ok=await new Promise<boolean>(resolve=>{const done=(ok:boolean)=>{clearTimeout(timer);readyCallbacks=readyCallbacks.filter(cb=>cb!==done);resolve(ok);};const timer=setTimeout(()=>done(false),8000);readyCallbacks.push(done);});
    return {ok};
  };
  browser.runtime.onMessage.addListener((m:unknown,sender,reply)=>{
    if(sender.id !== browser.runtime.id) return;
    const msg=m as {type?:string;view?:string};
    if(msg.type==='pd-panel-ready'){frameReady=true;for(const done of [...readyCallbacks])done(true);reply({ok:true});return;}
    if(msg.type==='pd-panel-status') {reply({ok:true,fullscreen:!!document.fullscreenElement,open:!!host&&!host.hidden});return;}
    if(msg.type==='pd-panel-hide') {hide();reply({ok:true});return;}
    if(msg.type==='pd-panel-show') {void show(msg.view).then(reply);return true;}
  });
  document.addEventListener('fullscreenchange',()=>{
    void browser.runtime.sendMessage({type:'panelFullscreen',fullscreen:!!document.fullscreenElement}).catch(()=>{});
    if(document.fullscreenElement) {normalOpen=!!host&&!host.hidden;hide();place();}
    else {place();if(normalOpen&&host)host.hidden=false;else hide();document.dispatchEvent(new Event('pd-panel-layout'));}
  });
  window.addEventListener('resize',place);
  window.addEventListener('pagehide',()=>{subtitlesResize.disconnect();host?.remove();});
  return {show,hide,isOpen:()=>!!host&&!host.hidden};
}
