// Transitional install status uses the same card, fonts and controls as Relay.
// Loaded with ?open, Relay is already set up on this computer and the main process is bringing
// the pill up: the window then only ever says Relay is opening, or that it did not open, and never
// offers to install it (Shane, 2026-10-16: a slow pill put "Install Relay" and a raw error on screen).
const body=document.querySelector('main');
const opening=typeof location!=='undefined'&&/[?&]open(&|$)/.test(location.search||'');
let busy=false;
function appearance(value){document.documentElement.dataset.theme=value;try{localStorage.setItem('relay-native-appearance',value)}catch{}}
let theme='dark';try{theme=localStorage.getItem('relay-native-appearance')||theme}catch{}appearance(theme);
document.querySelector('#themeToggle').onclick=()=>appearance(document.documentElement.dataset.theme==='dark'?'light':'dark');
document.querySelector('#closeX').onclick=()=>window.close();
body.innerHTML='<p class="su-step" id="prepareStep">Install Relay</p><h1 class="su-title" id="prepareTitle">Preparing Relay.</h1><p class="su-copy" id="prepareStatus" role="status">Checking the installation…</p><progress id="prepareProgress" aria-label="Installation progress" style="width:100%;margin-top:24px;accent-color:var(--accent)"></progress><div class="install-actions"><p class="notice" hidden></p><button class="su-primary" id="prepareAction" hidden>Try again</button></div>';
const step=document.querySelector('#prepareStep'),title=document.querySelector('#prepareTitle'),status=document.querySelector('#prepareStatus'),bar=document.querySelector('#prepareProgress'),action=document.querySelector('#prepareAction');
window.migration.onProgress(p=>{const labels={verifying:'Checking the installation…',downloading:'Downloading Relay’s files…',extracting:'Unpacking Relay…',recovering:'Updating Relay…',waiting:'Updating Relay…',installing:'Finishing installation…',ready:'Opening Relay…',stopped:'Installation stopped.'};status.textContent=labels[p.phase]||'Preparing Relay…';if(p.totalBytes>0){bar.max=p.totalBytes;bar.value=p.receivedBytes}else bar.removeAttribute('value')});
function showOpening(){document.title='Relay';step.textContent='Relay';title.textContent='Opening Relay.';status.textContent='Opening Relay…';bar.hidden=false;bar.removeAttribute('value');action.hidden=true}
function showNotOpened(){document.title='Relay';step.textContent='Relay';title.textContent='Relay didn’t open.';status.textContent='Relay is installed but took too long to appear. Try opening it again.';bar.hidden=true;action.textContent='Open Relay';action.hidden=false;action.onclick=reopen}
// Open again on a computer that is set up. Only a background service that is not running sends
// this through the install step, which puts it back without clearing anything.
async function reopen(){showOpening();let info=null;try{info=await window.migration.inspect()}catch{}if(info&&info.installation?.serviceHeartbeat!=='fresh')return install();await open()}
async function open(){let result=null;try{result=await window.migration.handoff()}catch{}if(result?.opened)return;if(opening)return showNotOpened();status.textContent='Relay is installed. Open it to continue.';bar.hidden=true;action.hidden=false;action.textContent='Open Relay';action.onclick=()=>window.migration.open()}
async function install(){if(busy)return;busy=true;action.hidden=true;document.querySelector('.notice').hidden=true;try{await window.migration.install();await open()}catch(error){status.textContent='Installation needs attention.';bar.hidden=true;const note=document.querySelector('.notice');note.textContent=error.message;note.hidden=false;action.textContent='Try again';action.hidden=false;action.onclick=install}finally{busy=false}}
if(opening){
  // The main process opens Relay and says when it could not.
  showOpening();
  window.migration.onLaunch?.(launch=>{if(launch?.failed)showNotOpened()});
  window.migration.inspect().then(info=>{if(info.launch?.quietLaunchFailed)showNotOpened()}).catch(()=>{});
}else{
// Setup is the only thing this window does, so it starts on its own. Bringing an old or broken
// Relay up to date happens inside it without a word. The one exception is a computer already
// set up whose Relay did not open in time: a slow start must never clear its settings unasked.
window.migration.inspect().then(info=>{if(info.plan.route==='fresh-install')return install();if(!info.launch?.quietLaunchFailed&&info.installation.pointer==='active'&&info.installation.applicationOwner!=='absent'&&!info.installation.recoveryPending&&info.installation.installedVersion.localeCompare(info.candidate.version,undefined,{numeric:true})>=0&&info.installation.serviceHeartbeat==='fresh')return open();if(!info.launch?.quietLaunchFailed)return install();status.textContent='Relay didn’t open.';bar.hidden=true;action.textContent='Try again';action.hidden=false;action.onclick=install}).catch(error=>{status.textContent=error.message;bar.hidden=true});
}
