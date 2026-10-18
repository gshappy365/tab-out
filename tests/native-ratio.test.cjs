const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeRatio } = require('../extension/native-ratio.js');
const { createChromeFixture, dashboardUrl } = require('./chrome-fixture.cjs');
const { createRemoteController } = require('../extension/remote-background.js');
const token = '0123456789abcdef0123456789abcdef';

function fakePort(handler) {
  const messages = new Set(), disconnections = new Set();
  let closed = false;
  const emit = value => { if (!closed) for (const listener of messages) listener(value); };
  const disconnect = () => { if (!closed) { closed = true; for (const listener of disconnections) listener(); } };
  return {
    onMessage: { addListener: fn => messages.add(fn), removeListener: fn => messages.delete(fn) },
    onDisconnect: { addListener: fn => disconnections.add(fn), removeListener: fn => disconnections.delete(fn) },
    postMessage: request => {
      if (closed) throw new Error('disconnected');
      queueMicrotask(() => { if (!closed) handler(request, emit, disconnect); });
    },
    disconnect,
  };
}

function fixture() {
  const state = { enabled: true, os: 'mac', split: 8, width: 500, focused: true, active: 2,
    calls: [], commits: [], updates: [], windowUpdates: [], aborted: false, nativePairCurrent: true };
  const api = {
    storage: { local: { get: async () => ({ 'splitRatio.enabled': state.enabled }) } },
    runtime: { getPlatformInfo: async () => ({ os: state.os }), connectNative: name => {
      if (state.unavailable) throw new Error('host missing');
      return fakePort((request, emit, disconnect) => {
        if (request.operation === 'set-split-ratio') {
          state.calls.push({ name, request });
          if (state.prepare) state.prepare(request, emit, disconnect);
          else emit({ version: 2, requestId: request.requestId, status: 'prepared', token });
        } else if (request.operation === 'commit-split-ratio') {
          state.commits.push(request);
          assert.equal(request.token, token);
          if (state.commit) return state.commit(request, emit, disconnect);
          if (!state.nativePairCurrent) return emit({ version: 2, requestId: request.requestId, status: 'refused', reason: 'split-changed' });
          state.width = 300;
          state.active = 1;
          emit({ version: 2, requestId: request.requestId, status: 'adjusted' });
        } else if (request.operation === 'abort-split-ratio') state.aborted = true;
      });
    } },
    windows: {
      get: async () => ({ id: 4, type: 'normal', focused: state.focused, left: 0, top: 25, width: 1024, height: 800 }),
      getLastFocused: async () => ({ id: 4, focused: state.focused }),
      update: async (id, props) => { state.windowUpdates.push({ id, props }); return { id, ...props }; },
    },
    tabs: {
      get: async id => ({ id, windowId: 4, splitViewId: state.split, index: state.right ? 2 - id : id - 1,
        width: id === 1 ? state.width : 1000 - state.width, active: id === state.active }),
      query: async () => Promise.all([api.tabs.get(1), api.tabs.get(2)]),
      update: async id => { state.updates.push(id); state.active = id; },
    },
  };
  return { state, api, apply: ratio => createNativeRatio(api, { wait: async () => {}, timeoutMs: 20 }).apply(1, 2, ratio) };
}

test('prepared handshake revalidates before authorizing the target-ratio drag, then verifies widths and restores target', async () => {
  const { state, apply } = fixture();
  assert.equal((await apply(0.3)).status, 'adjusted');
  assert.equal(state.active, 2);
  assert.equal(state.calls.length, 1);
  assert.equal(state.commits.length, 1);
  assert.deepEqual(state.windowUpdates, [{ id: 4, props: { focused: true } }]);
  const { name, request } = state.calls[0];
  assert.equal(name, 'com.tab_out_remote.split_ratio');
  assert.equal(request.version, 2);
  assert.deepEqual(Object.keys(request).sort(), ['version','requestId','operation','expiresAt','overviewSide','viewportWidths','windowBounds','targetRatio'].sort());
  assert.equal(request.targetRatio, 0.3);
  assert.equal(request.overviewSide, 'left');
  assert.deepEqual(request.viewportWidths, { left: 500, right: 500 });
  assert.equal(state.width, 300);
});

test('overview on right requests right-side overview and preserves real target identity', async () => {
  const { state, apply } = fixture(); state.right = true;
  assert.equal((await apply(0.3)).status, 'adjusted');
  assert.equal(state.calls[0].request.overviewSide, 'right');
  assert.equal(state.active, 2);
});


test('preserves the measured ratio instead of forcing 3:7', async () => {
  const { state, apply } = fixture();
  state.commit = (r, emit) => { state.width = 420; emit({ version: 2, requestId: r.requestId, status: 'adjusted' }); };
  assert.equal((await apply(0.42)).status, 'adjusted');
  assert.equal(state.calls[0].request.targetRatio, 0.42);
  assert.equal(state.width, 420);
});

test('target ratio is bounded to 20-60 percent before it reaches the host', async () => {
  for (const [requested, expected] of [[0.1, 0.2], [0.9, 0.6], [-1, 0.2], [2, 0.6]]) {
    const { state, api } = fixture();
    state.commit = (r, emit) => { state.width = expected * 1000; emit({ version: 2, requestId: r.requestId, status: 'adjusted' }); };
    assert.equal((await createNativeRatio(api, { wait: async () => {}, timeoutMs: 20 }).apply(1, 2, requested)).status, 'adjusted');
    assert.equal(state.calls[0].request.targetRatio, expected);
  }
});

test('already-correct means already at the requested ratio, not always 3:7', async () => {
  const { state, apply } = fixture(); state.width = 420;
  assert.equal((await apply(0.42)).status, 'already-correct');
  assert.equal(state.calls.length, 0);
  assert.equal(state.updates.length, 1);
});

test('adjusted claim at the wrong ratio is rejected for the requested ratio too', async () => {
  const { state, apply } = fixture();
  state.commit = (r, emit) => { state.width = 300; emit({ version: 2, requestId: r.requestId, status: 'adjusted' }); };
  assert.deepEqual(await apply(0.42), { status: 'error', reason: 'ratio-not-confirmed' });
});

test('overview on right preserves the same overview fraction', async () => {
  const { state, apply } = fixture();
  state.right = true; state.width = 360; state.active = 2;
  state.commit = (r, emit) => { state.width = 420; emit({ version: 2, requestId: r.requestId, status: 'adjusted' }); };
  assert.equal((await apply(0.42)).status, 'adjusted');
  assert.equal(state.calls[0].request.overviewSide, 'right');
  assert.equal(state.calls[0].request.targetRatio, 0.42);
});

test('no measured ratio skips the host and leaves Chrome\'s layout untouched', async () => {
  for (const ratio of [undefined, null, NaN]) {
    const { state, apply } = fixture();
    assert.deepEqual(await apply(ratio), { status: 'skipped' });
    assert.equal(state.calls.length, 0);
    assert.equal(state.updates.length, 0);
    assert.equal(state.windowUpdates.length, 0);
  }
});

test('already-correct at the requested ratio restores both tab and window focus', async () => {
  const { state, apply } = fixture(); state.width = 420;
  assert.equal((await apply(0.42)).status, 'already-correct');
  assert.deepEqual(state.updates, [2]);
  assert.deepEqual(state.windowUpdates, [{ id: 4, props: { focused: true } }]);
});

test('disabled, nonmac, nonsplit, inactive windows never invoke host', async () => {
  for (const patch of [{ enabled: false }, { os: 'win' }, { split: -1 }, { focused: false }]) {
    const { state, apply } = fixture(); Object.assign(state, patch);
    await apply(0.3); assert.equal(state.calls.length, 0);
  }
});

test('already correct widths skip native but explicitly return keyboard focus to active target', async () => {
  const { state, apply } = fixture(); state.width = 300;
  assert.equal((await apply(0.3)).status, 'already-correct'); assert.equal(state.calls.length, 0);
  assert.deepEqual(state.updates, [2]);
});

test('native UI may own focus while target.active stays true: always reactivate safe target after drag', async () => {
  const { state, apply } = fixture();
  state.commit = (r, emit) => { state.width = 300; emit({ version: 2, requestId: r.requestId, status: 'adjusted' }); };
  assert.equal((await apply(0.3)).status, 'adjusted');
  assert.deepEqual(state.updates, [2]);
});

test('adjusted claim must be verified against actual widths', async () => {
  const { state, apply } = fixture();
  state.commit = (r, emit) => emit({ version: 2, requestId: r.requestId, status: 'adjusted' });
  assert.deepEqual(await apply(0.3), { status: 'error', reason: 'ratio-not-confirmed' });
});

test('bad prepared identity/token/schema, duplicate prepared and premature success never authorize', async () => {
  for (const response of [
    { version: 1, status: 'prepared', token }, { version: 2, status: 'prepared', token, requestId: 'wrong' },
    { version: 2, status: 'prepared', token: token + '\n' }, { version: 2, status: 'prepared', token, extra: true },
    { version: 2, status: 'adjusted' },
  ]) {
    const { state, apply } = fixture();
    state.prepare = (r, emit) => emit({ requestId: r.requestId, ...response });
    assert.equal((await apply(0.3)).reason, 'invalid-response');
    assert.equal(state.commits.length, 0);
  }
  const { state, apply } = fixture();
  state.prepare = (r, emit) => { const value = { version: 2, requestId: r.requestId, status: 'prepared', token }; emit(value); emit(value); };
  assert.equal((await apply(0.3)).reason, 'invalid-response'); assert.equal(state.commits.length, 0);
});

test('bad final response identity/schema is rejected after commit', async () => {
  for (const response of [{ version: 1, status: 'adjusted' }, { version: 2, requestId: 'wrong', status: 'adjusted' },
    { version: 2, status: 'bogus' }, { version: 2, status: 'error', reason: {} }]) {
    const { state, apply } = fixture();
    state.commit = (r, emit) => emit({ requestId: r.requestId, ...response });
    assert.equal((await apply(0.3)).reason, 'invalid-response');
  }
});

test('host missing, permission denied, timeout and disconnect leave layout intact', async () => {
  for (const mode of ['missing', 'permission-required', 'timeout', 'disconnect']) {
    const { state, apply } = fixture();
    state.unavailable = mode === 'missing';
    state.prepare = (r, emit, disconnect) => {
      if (mode === 'permission-required') emit({ version: 2, requestId: r.requestId, status: mode });
      if (mode === 'disconnect') disconnect();
    };
    assert.notEqual((await apply(0.3)).status, 'adjusted');
    assert.equal(state.commits.length, 0);
    assert.equal(state.split, 8); assert.equal(state.active, 2);
  }
});

test('disconnect or silence after commit reports failure without retrying or rebuilding', async () => {
  for (const mode of ['disconnect', 'timeout']) {
    const { state, apply } = fixture();
    state.commit = (_r, _emit, disconnect) => { if (mode === 'disconnect') disconnect(); };
    const result = await apply(0.3);
    assert.equal(result.reason, mode === 'disconnect' ? 'host-unavailable' : 'timeout');
    assert.equal(state.calls.length, 1);
    assert.equal(state.commits.length, 1);
    assert.equal(state.split, 8);
    assert.equal(state.width, 500);
  }
});

test('same-window switch before native capture cannot authorize a stale pair', async () => {
  for (const patch of [{ active: 99 }, { split: 19 }, { width: 600 }, { right: true }]) {
    const { state, apply } = fixture();
    state.prepare = (r, emit) => { Object.assign(state, patch); emit({ version: 2, requestId: r.requestId, status: 'prepared', token }); };
    assert.equal((await apply(0.3)).reason, 'layout-changed');
    assert.equal(state.commits.length, 0);
    assert.equal(state.width, patch.width ?? 500);
  }
});

test('returning to expected pair after host captured other pair still requires native identity rejection', async () => {
  const { state, apply } = fixture();
  state.prepare = (r, emit) => { state.nativePairCurrent = false; emit({ version: 2, requestId: r.requestId, status: 'prepared', token }); };
  assert.equal((await apply(0.3)).status, 'refused');
  assert.equal(state.commits.length, 1);
  assert.equal(state.width, 500);
});

test('timeout during asynchronous authorization never commits after caller stops waiting', async () => {
  const { state, api } = fixture();
  let block = false, release;
  state.prepare = (r, emit) => { block = true; emit({ version: 2, requestId: r.requestId, status: 'prepared', token }); };
  const get = api.tabs.get;
  api.tabs.get = async id => {
    if (block) { block = false; await new Promise(resolve => { release = resolve; }); }
    return get(id);
  };
  const result = await createNativeRatio(api, { wait: async () => {}, timeoutMs: 5 }).apply(1, 2, 0.3);
  assert.equal(result.reason, 'timeout');
  if (release) release();
  assert.equal(state.commits.length, 0);
});

test('user app switch or manual split change during host never steals focus', async () => {
  for (const patch of [{ focused: false }, { split: 19 }, { active: 99 }]) {
    const { state, apply } = fixture();
    state.commit = (r, emit) => { Object.assign(state, patch); emit({ version: 2, requestId: r.requestId, status: 'adjusted' }); };
    assert.equal((await apply(0.3)).reason, 'ratio-not-confirmed');
    assert.equal(state.updates.length, 0);
  }
});

test('selection AND return commit split before native, run Muse afterward even on native failure', async () => {
  const browser = createChromeFixture([
    { id: 1, windowId: 1, index: 0, url: dashboardUrl, active: false, splitViewId: 9 },
    { id: 2, windowId: 1, index: 1, url: 'https://muse.ai/a', active: true, splitViewId: 9 },
    { id: 3, windowId: 1, index: 2, url: 'https://muse.ai/b', active: false },
  ]);
  const api = browser.api;
  api.storage.local = { get: async () => ({ 'splitRatio.enabled': true }) };
  api.runtime.getPlatformInfo = async () => ({ os: 'mac' });
  const get = api.tabs.get;
  const widths = { 1: 400, 2: 600, 3: 700 };
  api.tabs.get = async id => ({ ...(await get(id)), width: widths[id] ?? 500 });
  api.windows.get = async () => ({ id: 1, type: 'normal', focused: true, left: 0, top: 25, width: 1024, height: 800 });
  api.windows.getLastFocused = api.windows.get;
  const order = [];
  const requests = [];
  api.runtime.connectNative = () => {
    const tabs = browser.allTabs();
    const d = tabs.find(t => t.id === 1); const target = tabs.find(t => t.active);
    assert.ok(d.splitViewId >= 1000); assert.equal(target.splitViewId, d.splitViewId);
    const activeId = target.id;
    order.push(`native:${activeId}`);
    let listener = null;
    const emit = value => listener?.(value);
    return {
      onMessage: { addListener: fn => { listener = fn; }, removeListener: () => {} },
      onDisconnect: { addListener: () => {}, removeListener: () => {} },
      postMessage: request => {
        if (request.operation === 'set-split-ratio') {
          requests.push(request);
          queueMicrotask(() => emit({ version: 2, requestId: request.requestId, status: 'prepared', token }));
        } else if (request.operation === 'commit-split-ratio') {
          queueMicrotask(() => emit({ version: 2, requestId: request.requestId, status: 'refused', reason: 'split-changed' }));
        }
      },
      disconnect() {},
    };
  };
  api.permissions = { contains: async () => true };
  api.scripting = { executeScript: async ({ target }) => { order.push(`muse:${target.tabId}`); return [{ frameId: 0, result: { status: 'focused' } }]; } };
  const controller = createRemoteController(api);
  const d = await api.tabs.get(1); const sender = { id: api.runtime.id, tab: d, url: dashboardUrl };
  await controller.handleMessage({ type: 'remote:activate', tabId: 3 }, sender);
  assert.equal(browser.active(1), 3);
  await controller.handleCommand('cancel-selection');
  assert.equal(browser.active(1), 2);
  assert.deepEqual(order, ['native:3', 'muse:3', 'native:2', 'muse:2']);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].targetRatio, 0.4);
  assert.ok(Math.abs(requests[1].targetRatio - 400 / 1100) < 1e-9);
  assert.equal(browser.allTabs().filter(t => t.url === dashboardUrl).length, 1);
});
