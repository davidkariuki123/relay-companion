// Real renderer, mocked IPC: no live messages or installed Companion changes.
// Run with RELAY_TEST_OVERLAY to reproduce against a published package.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const { shouldIgnoreOverlayMouse } = require('../overlay/window-fit.cjs');
const overlay = process.env.RELAY_TEST_OVERLAY || fileURLToPath(new URL('../overlay', import.meta.url));
const browser = await chromium.launch({ headless:true, ...(process.env.RELAY_TEST_BROWSER_CHANNEL ? { channel:process.env.RELAY_TEST_BROWSER_CHANNEL } : {}) });
try {
  // A 720px compositor contains the narrow 344px card on its right, as on Mac.
  const page = await browser.newPage({ viewport:{ width:720, height:800 }, reducedMotion:'reduce' });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
    const sent = [
      { relayId:'sent-one', threadId:'room', kind:'message', title:'', forHuman:'My earlier message', forAgent:'',
        recipient:{ name:'Test Person', email:'test@example.com' }, createdAt:ago(2), state:'delivered' },
      { relayId:'sent-two', threadId:'room', kind:'message', title:'', forHuman:'My latest message', forAgent:'',
        inReplyToRelayId:'sent-one', recipient:{ name:'Test Person', email:'test@example.com' }, createdAt:ago(1), state:'delivered' },
    ];
    const payload = {
      account:{ paired:true, userId:'self', name:'Test User', email:'self@example.com', hasSentRelay:true },
      ui:{ canDismiss:true, onboardingRequired:false, completedOnboardingVersion:1 },
      features:{ messageMutations:true }, relays:[], sent, requests:[], chats:[], slackChats:[],
    };
    const api = {
      isTestOverlay:true, refresh:async () => payload, refreshSent:async () => ({ items:sent }),
      contacts:async () => [], groups:async () => ({ ok:true, result:[] }),
      accountInfo:async () => payload.account, agentSurfaces:async () => ({}),
    };
    window.relay = new Proxy(api, { get:(target, key) => key in target ? target[key]
      : String(key).startsWith('on') ? () => () => {} : async () => ({ ok:true }) });
  });
  await page.goto(pathToFileURL(path.join(overlay, 'inbox.html')).href);
  await page.locator('#relaysList .relay-arrival').first().click();
  const field = page.locator('#thQrInput');
  const composer = page.locator('.qr.th-qr');
  await field.fill('Keep this draft');

  for (const id of ['sent-two', 'sent-one', 'sent-two']) {
    const trigger = page.locator(`[data-msg="${id}"] [data-message-more]`);
    await trigger.evaluate(element => element.scrollIntoView({ block:'center' }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await trigger.click();
    const geometry = await page.evaluate(() => {
      const card = document.getElementById('card').getBoundingClientRect();
      const menu = document.querySelector('.th-message-menu:popover-open');
      return {
        card:{ x:card.x, y:card.y, w:card.width, h:card.height }, menu:menu.getBoundingClientRect().toJSON(),
        buttons:[...menu.querySelectorAll('button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { label:button.textContent, point:{ x:rect.x + 20, y:rect.y + rect.height / 2 } };
        }),
      };
    });
    for (const button of geometry.buttons) {
      assert.equal(shouldIgnoreOverlayMouse(button.point, geometry.card, 12), false,
        `${button.label.trim()} must accept native pointer clicks, including its left-hand label`);
    }
    assert.ok(geometry.menu.left >= geometry.card.x + 8, 'menu stays inside the card on the left');
    assert.ok(geometry.menu.right <= geometry.card.x + geometry.card.w - 8, 'menu stays inside the card on the right');
    assert.ok(geometry.menu.top >= geometry.card.y + 8, 'menu stays inside the card at the top');
    assert.ok(geometry.menu.bottom <= geometry.card.y + geometry.card.h - 8, 'menu stays inside the card at the bottom');
    // Click the label that used to overhang the native hit region, not the
    // menu's right edge (which could still overlap the card and appear to work).
    await page.locator(`[data-reply-to="${id}"]`).click({ position:{ x:20, y:15 } });
    await composer.locator('.th-reply-target').waitFor();
    assert.equal(await composer.getAttribute('data-reply-target'), id);
    assert.equal(await composer.locator('.th-reply-target-who').innerText(), 'Replying to You');
    assert.equal(await field.evaluate(element => document.activeElement === element), true);
    assert.equal(await field.evaluate(element => element.value), 'Keep this draft');
    await composer.locator('[data-reply-cancel]').click();
    await composer.locator('.th-reply-target').waitFor({ state:'detached' });
    assert.equal(await field.evaluate(element => element.value), 'Keep this draft');
  }
  assert.deepEqual(errors, []);
  console.log('PASS: sent-message menus stay clickable; Reply selects the exact message, focuses the composer and preserves the draft.');
} finally {
  await browser.close();
}
