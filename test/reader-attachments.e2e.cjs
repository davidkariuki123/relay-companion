// Isolated Chromium renderer test: no Companion installation, account or API.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-reader-panel-'));
app.setPath('userData',path.join(temp,'profile'));
const html=fs.readFileSync(path.join(__dirname,'../overlay/inbox.html'),'utf8');
const css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
const source=html.slice(html.indexOf('  // ---- compact reader attachments'),html.indexOf('  // ---- end compact reader attachments'));
const fixture=`<!doctype html><html><head><style>${css}body{overflow:auto;background:var(--bg)}#reader{height:1200px;padding-top:400px}</style></head><body><div id="reader"><div class="rd-details" id="entry"></div><textarea>Unsent reply</textarea></div><script>
const readerBodyEl=document.getElementById('reader');let activeView='reader',readerId='r';
const esc=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const fmtBytes=v=>String(v||0)+' B';const fileIconSvg=()=>'<svg></svg>';const fileFamilyOf=()=> 'file';
window.calls=[];window.fail=false;window.relay={openAttachment:async(...args)=>{calls.push(args);if(fail)throw Error('Download failed');return {ok:true}}};
${source}
window.install=(count)=>{window.row={id:'r',attachments:Array.from({length:count},(_,i)=>({id:'file-'+i,name:i===99?'long-'.repeat(50)+'.md':'file-'+i+'.md',bytes:55}))};entry.innerHTML=relaySharedShelf(row);wireReaderAttachments(readerBodyEl,row)};
install(100);
</script></body></html>`;
fs.writeFileSync(path.join(temp,'fixture.html'),fixture);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:720,height:760,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 const js=async s=>{try{return await win.webContents.executeJavaScript(s,true)}catch(error){console.error("Renderer test step:",s);throw error}};
 const closed=async()=>{for(let i=0;i<100;i++){if(await js(`document.querySelector('dialog')===null`))return;await new Promise(r=>setTimeout(r,20));}throw Error('Dialog did not close')};
 try {
 await win.loadFile(path.join(temp,'fixture.html'));
 for(const width of [720,360]) {
  win.setSize(width,760);
  await js(`install(100);window.scrollTo(0,300);window.before={height:readerBodyEl.scrollHeight,scroll:window.scrollY};document.querySelector('[data-reader-attachments]').click()`);
  const m=await js(`({count:document.querySelectorAll('[data-reader-file]').length,height:readerBodyEl.scrollHeight,before,dialog:document.querySelector('dialog').getBoundingClientRect().height,overflow:document.querySelector('.rd-attachments-files').scrollHeight>document.querySelector('.rd-attachments-files').clientHeight,focus:document.activeElement.className,width:document.querySelector('dialog').getBoundingClientRect().width,viewport:innerWidth})`);
  assert.equal(m.count,100);assert.equal(m.height,m.before.height);assert.equal(m.dialog,340);assert.equal(m.overflow,true);assert.equal(m.focus,'rd-attachments-close');assert.ok(m.width<=m.viewport-30);
  await js(`document.querySelector('.rd-attachments-files').scrollTop=9999;document.querySelector('[data-reader-file="file-99"]').click()`);
  assert.deepEqual(await js('calls.at(-1)'),['r','file-99']);
  await js(`fail=true;document.querySelector('[data-reader-file="file-98"]').click()`);
  assert.equal(await js(`document.querySelector('.rd-attachments-error').textContent`),'Download failed');
  await js(`fail=false;install(100)`); // Poll refresh replaces the trigger without closing the dialog.
  assert.equal(await js(`document.querySelector('dialog').open`),true);
  await js(`document.querySelector('.rd-attachments-close').click()`);
  await closed();
  assert.equal(await js(`document.querySelector('dialog')===null`),true);
  assert.equal(await js(`document.activeElement.hasAttribute('data-reader-attachments')`),true);
  assert.equal(await js(`window.scrollY`),m.before.scroll);
  await js(`document.querySelector('[data-reader-attachments]').click()`);
  await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await closed();
  assert.equal(await js(`document.querySelector('dialog')===null`),true);
  await js(`document.querySelector('[data-reader-attachments]').click();{const d=document.querySelector('dialog');d.dispatchEvent(new PointerEvent('pointerdown',{clientX:0,clientY:0,bubbles:true}));d.dispatchEvent(new MouseEvent('click',{clientX:0,clientY:0,bubbles:true}));}`);
  await closed();
  assert.equal(await js(`document.querySelector('dialog')===null`),true);
  for (const count of [1,12]) {
   await js(`install(${count});document.querySelector('[data-reader-attachments]').click()`);
   assert.equal(await js(`document.querySelectorAll('[data-reader-file]').length`),count);
   assert.equal(await js(`document.querySelector('dialog').getBoundingClientRect().height`),340);
   await js('closeReaderAttachments()');await closed();
  }
 }
 console.log('PASS: 1/12/100 files, 720/360 widths, fixed height, scroll/focus restoration, polling, Escape/backdrop/close, exact open ids and errors.');
 win.destroy();app.exit(0);
 }catch(e){console.error(e);win.destroy();app.exit(1)}
});
