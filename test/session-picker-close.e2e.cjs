// Real Chromium layout, using the shipped disclosure CSS and lifecycle functions.
// No Companion installation, account, native session or network access.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-picker-close-'));
app.setPath('userData',path.join(temp,'profile'));
const html=fs.readFileSync(path.join(__dirname,'../overlay/inbox.html'),'utf8');
const extract=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const fixture=`<!doctype html><style>${html.match(/<style>([\s\S]*?)<\/style>/)[1]}
#fixture{position:absolute;top:0;width:600px}button{height:50px;width:100%}</style>
<div id="fixture"></div><script>
let sessionPickerState=null,sessionPickerViewportRaf=0,REDUCED=false;
function renderSessionPickerSurface(){document.querySelector('[data-sp-reveal]')?.remove()}
function followSessionPickerIntoView(){}
function wireSessionPickerRows(){}
function sessionPickerBodyHtml(){return '<div style="height:300px;flex-shrink:0">Destinations</div>'}
${extract('  function closeSessionPicker(', '  function armSessionPickerReveal(')}
${extract('  function paintSessionPickerResult(', '  async function deliverSessionSelection(')}
window.run=async(interrupt,reduced=false)=>{
 REDUCED=reduced;
 fixture.innerHTML='<button class="pressed">Open in Codex</button><div class="sp-list open" data-sp-reveal="r" data-sp-provider="codex"><div class="sp-list-inner"><div style="height:40px">Loading</div></div></div><button id="footer">Open in Claude Code</button>';
 sessionPickerState={id:'r',provider:'codex'};
 paintSessionPickerResult(sessionPickerState);
 await new Promise(r=>setTimeout(r,interrupt?100:500));
 const list=sessionPickerReveal();
 const start=list.getBoundingClientRect().height;
 closeSessionPicker();
 const heights=[],footer=[];
 while(list.isConnected && heights.length<100){
  heights.push(list.getBoundingClientRect().height);
  footer.push(document.getElementById('footer').getBoundingClientRect().top);
  await new Promise(requestAnimationFrame);
 }
 return {start,heights,footer,removed:!list.isConnected,final:document.getElementById('footer').getBoundingClientRect().top};
};</script>`;
fs.writeFileSync(path.join(temp,'fixture.html'),fixture);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 try{
  await win.loadFile(path.join(temp,'fixture.html'));
  for(const interrupt of [false,true]){
   const result=await win.webContents.executeJavaScript(`run(${interrupt})`);
   assert.ok(result.removed);
   assert.ok(result.start>20);
   assert.ok(result.heights.filter(h=>h>1&&h<result.start*.9).length>=4,JSON.stringify(result));
   for(let i=1;i<result.heights.length;i++)assert.ok(result.heights[i]<=result.heights[i-1]+1,JSON.stringify(result));
   assert.ok(result.heights.at(-1)<2,JSON.stringify(result));
   assert.ok(Math.abs(result.footer.at(-1)-result.final)<2,JSON.stringify(result));
   console.log(`PASS ${interrupt?'interrupted':'settled'} close: ${result.heights.length} frames, ${result.start.toFixed(1)}px to zero; footer continuous`);
  }
  const reduced=await win.webContents.executeJavaScript('run(false,true)');
  assert.ok(reduced.removed);assert.equal(reduced.heights.length,0);
  console.log('PASS reduced motion: immediate close');
  win.destroy();app.exit(0);
 }catch(error){console.error(error);win.destroy();app.exit(1)}
});
