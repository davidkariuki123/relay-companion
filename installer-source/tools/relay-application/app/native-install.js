// Relay opened from its disk image installs itself. Double-clicking Relay in
// the "Install Relay" window is the whole install: no drag, no button. This
// window says what is happening while Relay moves itself into Applications;
// the copy there then reopens, ejects the disk image and continues into
// "Preparing Relay" (native-bootstrap.js). Founder on 0.1.624, 2026-10-10:
// the old window asked for a drag, the drag only copied the app, and nothing
// opened.
const body=document.querySelector('main');
const reduced=matchMedia('(prefers-reduced-motion:reduce)').matches;
// Long enough to read the title before the move starts. The move holds the
// application's main process, so the bar is filled ahead of it.
const MIN_VISIBLE_MS=reduced?600:1400;
let busy=false,timer;
function appearance(value){document.documentElement.dataset.theme=value;try{localStorage.setItem('relay-native-appearance',value)}catch{}}
let theme='dark';try{theme=localStorage.getItem('relay-native-appearance')||theme}catch{}appearance(theme);
document.querySelector('#themeToggle').onclick=()=>appearance(document.documentElement.dataset.theme==='dark'?'light':'dark');
document.querySelector('#closeX').onclick=()=>window.close();
body.innerHTML='<p class="su-step">Install Relay</p><h1 class="su-title" id="installTitle">Installing Relay…</h1><p class="su-copy" id="installStatus" role="status">Moving Relay into your Applications folder.</p><progress id="installProgress" aria-label="Installation progress" max="100" value="0" style="width:100%;margin-top:24px;accent-color:var(--accent)"></progress><div class="install-icon"><img src="relayAppIcon.svg" alt="Relay"></div><div class="install-actions"><p class="notice" hidden></p><button class="su-primary" id="install" hidden>Try again</button></div>';
const title=document.querySelector('#installTitle'),status=document.querySelector('#installStatus'),bar=document.querySelector('#installProgress'),action=document.querySelector('#install'),notice=document.querySelector('.notice');
// Eases toward a ceiling it never reaches on its own; only success fills it.
function creep(ceiling,step){clearInterval(timer);timer=setInterval(()=>{bar.value=Math.min(ceiling,bar.value+Math.max(.4,(ceiling-bar.value)*step))},reduced?400:90)}
async function install(){
  if(busy)return;busy=true;
  action.hidden=true;notice.hidden=true;bar.hidden=false;bar.value=0;
  title.textContent='Installing Relay…';status.textContent='Moving Relay into your Applications folder.';
  creep(60,.08);
  await new Promise(resolve=>setTimeout(resolve,MIN_VISIBLE_MS));
  creep(92,.04);
  const result=await window.migration.relocate().catch(error=>({ok:false,error:error.message}));
  clearInterval(timer);
  if(result?.ok){bar.value=100;status.textContent='Opening Relay…';return}
  busy=false;bar.hidden=true;
  title.textContent='Relay isn’t installed yet.';status.textContent='Fix what’s below, then try again.';
  notice.textContent=result?.error||'Relay could not move to Applications.';notice.hidden=false;
  action.hidden=false;action.onclick=install;
}
install();
