import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const html = fs.readFileSync(new URL('../overlay/inbox.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('  // ---- compact reader attachments'), html.indexOf('  // ---- end compact reader attachments'));
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const {relaySharedShelf, readerAttachmentRows} = new Function('esc','fmtBytes','fileIconSvg','fileFamilyOf', `${source}; return {relaySharedShelf,readerAttachmentRows}`)(esc, n => `${n || 0} B`, () => '<svg></svg>', () => 'file');
test('one compact entry, independent of attachment count, and nothing for zero', () => {
  assert.equal(relaySharedShelf({attachments:[]}), '');
  assert.equal(relaySharedShelf({}), '');
  for (const count of [1, 12, 100]) {
    const result=relaySharedShelf({id:'r',attachments:Array.from({length:count},(_,i)=>({id:`a${i}`,name:`file${i}`}))});
    assert.equal((result.match(/<button/g)||[]).length,1);
    assert.ok(result.includes(`${count} ${count===1?'attachment':'attachments'}`));
    assert.doesNotMatch(result,/file99|rd-shelf-preview/);
  }
});
test('all files keep exact ids, escaped names, size aliases and missing-id disabled state', () => {
  const result=readerAttachmentRows({attachments:[{id:'a"<',filename:'<img src=x onerror=alert(1)>',sizeBytes:42},{id:'b',name:'notes.md',bytes:12},{name:'pending'}]});
  assert.equal((result.match(/class="rd-attachment-file"/g)||[]).length,3);
  assert.match(result,/data-reader-file="a&quot;&lt;"/);
  assert.doesNotMatch(result,/<img/);
  assert.match(result,/42 B/);assert.match(result,/12 B/);
  assert.match(result,/data-reader-file="" disabled/);
});
