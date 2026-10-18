// Manual investigation for #1. Uses a disposable Chrome profile and local pages.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const { chromium } = require(process.env.TAB_OUT_PLAYWRIGHT_PATH || 'playwright');

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-out-ratio-'));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const label = { '/A': 'A', '/B': 'B' }[req.url];
    if (!label) { res.writeHead(404); res.end(); return; }
    res.end(`<title>Ratio ${label}</title><h1>Ratio ${label}</h1><p>Local disposable ratio probe</p><textarea aria-label="Draft"></textarea>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    const extension = path.resolve(__dirname, '../extension');
    context = await chromium.launchPersistentContext(profile, {
      ...(process.env.TAB_OUT_CHROME_PATH ? { executablePath: process.env.TAB_OUT_CHROME_PATH } : { channel: 'chromium' }),
      headless: false, viewport: null,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1400,900', '--window-position=0,0'],
    });
    await context.route('https://**/*', route => route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const dashboard = await context.newPage();
    await dashboard.goto(`chrome-extension://${new URL(worker.url()).hostname}/index.html`);
    const base = `http://127.0.0.1:${server.address().port}`;
    const a = await context.newPage(); await a.goto(`${base}/A`);
    const b = await context.newPage(); await b.goto(`${base}/B`);
    for (const page of context.pages()) if (![dashboard, a, b].includes(page)) await page.close();
    const ids = await worker.evaluate(async ({ url, base }) => {
      const tabs = await chrome.tabs.query({});
      const d = tabs.find(t => t.url === url), a = tabs.find(t => t.url === `${base}/A`), b = tabs.find(t => t.url === `${base}/B`);
      await chrome.tabs.move(a.id, { index: d.index + 1 });
      await chrome.tabs.createSplit([d.id, a.id]);
      await chrome.tabs.update(d.id, { active: true });
      return { dashboard: d.id, a: a.id, b: b.id };
    }, { url: dashboard.url(), base });
    const measure = async () => {
      const tabs = await worker.evaluate(async ids => Promise.all(Object.values(ids).map(id => chrome.tabs.get(id))), ids);
      const widths = await Promise.all([dashboard, a, b].map(page => page.evaluate(() => innerWidth)));
      const d = tabs[0], partnerIndex = tabs.findIndex((t, i) => i > 0 && t.splitViewId === d.splitViewId);
      const ratio = d.splitViewId >= 0 && partnerIndex > 0 ? widths[0] / (widths[0] + widths[partnerIndex]) : null;
      const result = { widths, dashboardFraction: ratio, tabs: tabs.map(t => ({ id: t.id, index: t.index, splitViewId: t.splitViewId, width: t.width })) };
      console.log(JSON.stringify(result));
      return result;
    };
    const select = async targetId => {
      await dashboard.locator(`.remote-target[data-tab-id="${targetId}"]`).click();
      await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'remote:get-state' }));
      // Browser layout can finish after the extension command resolves.
      const partner = targetId === ids.a ? a : b;
      await partner.waitForFunction(() => innerWidth < outerWidth - 100);
    };
    const preservePair = async () => {
      // A test-only alternative: keep D/A intact and give B its own overview.
      // Creates no duplicate browsing page, and does not change production routing.
      await worker.evaluate(async ids => {
        const d = await chrome.tabs.get(ids.dashboard);
        const second = await chrome.tabs.create({ windowId: d.windowId, url: d.url, active: false });
        await chrome.tabs.move(ids.b, { windowId: d.windowId, index: second.index + 1 });
        await chrome.tabs.createSplit([second.id, ids.b]);
        await chrome.tabs.update(ids.b, { active: true });
      }, ids);
      await b.waitForFunction(() => innerWidth < outerWidth - 100);
      await worker.evaluate(async ids => { await chrome.tabs.update(ids.a, { active: true }); }, ids);
      await a.waitForFunction(() => innerWidth < outerWidth - 100);
      return measure();
    };
    // All commands operate exclusively on the three tabs created in this profile.
    console.log('READY: drag the native separator, then enter measure; compare tests keeping a separate overview/B pair before the normal destructive roundtrip; roundtrip asserts A → B → A retains a non-default ratio; A/B select a real tab; return restores the initial partner; move-between probes tabs.move; api probes schema; quit cleans up.');
    for await (const input of readline.createInterface({ input: process.stdin })) {
      const command = input.trim();
      if (command === 'quit') break;
      if (['roundtrip', 'compare'].includes(command)) {
        const before = await measure();
        if (before.tabs[0].splitViewId < 0 || before.tabs[0].splitViewId !== before.tabs[1].splitViewId || Math.abs(before.dashboardFraction - 0.5) < 0.08) {
          console.log('PRECONDITION: pair the overview with A and manually resize clearly away from 50:50; no ratio verdict has been made.');
          continue;
        }
        if (command === 'compare') {
          const preserved = await preservePair();
          const sameSplit = preserved.tabs[0].splitViewId === before.tabs[0].splitViewId;
          console.log(JSON.stringify({ test: 'keep-original-pair', verdict: sameSplit && Math.abs(before.dashboardFraction - preserved.dashboardFraction) <= 0.02 ? 'PASS' : 'FAIL', sameSplit, before: before.dashboardFraction, returned: preserved.dashboardFraction }));
        }
        await select(ids.b);
        const switched = await measure();
        await select(ids.a);
        const returned = await measure();
        const difference = Math.abs(before.dashboardFraction - returned.dashboardFraction);
        console.log(JSON.stringify({ test: 'same-real-tab-ratio-roundtrip', verdict: difference <= 0.02 ? 'PASS' : 'FAIL', before: before.dashboardFraction, switched: switched.dashboardFraction, returned: returned.dashboardFraction, tolerance: 0.02 }));
        if (difference > 0.02) process.exitCode = 1;
        continue;
      }
      if (['A', 'B'].includes(command)) {
        await select(ids[command.toLowerCase()]);
      } else if (command === 'return') {
        await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'remote:execute', command: 'cancel-selection' }));
      } else if (command === 'move-between') {
        console.log(JSON.stringify(await worker.evaluate(async ids => {
          const d = await chrome.tabs.get(ids.dashboard), a = await chrome.tabs.get(ids.a);
          await chrome.tabs.move(ids.b, { index: Math.min(d.index, a.index) + 1 });
          return Promise.all([ids.dashboard, ids.a, ids.b].map(async id => {
            const tab = await chrome.tabs.get(id);
            return { id, index: tab.index, splitViewId: tab.splitViewId };
          }));
        }, ids)));
      } else if (command === 'api') {
        console.log(JSON.stringify(await worker.evaluate(async ids => {
          const errors = {};
          for (const [name, call] of [
            ['updateRatio', () => chrome.tabs.update(ids.dashboard, { splitViewRatio: 0.3 })],
            ['createRatio', () => chrome.tabs.createSplit([ids.dashboard, ids.b], { ratio: 0.3 })],
          ]) { try { await call(); errors[name] = 'unexpected success'; } catch (e) { errors[name] = e.message; } }
          return { updateSplit: typeof chrome.tabs.updateSplit, setSplitRatio: typeof chrome.tabs.setSplitRatio, errors };
        }, ids)));
      } else if (command !== 'measure') { console.log('Unknown command'); continue; }
      await measure();
    }
  } finally {
    process.stdin.pause();
    process.stdin.unref?.();
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
