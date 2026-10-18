(function (root) {
  'use strict';
  const host = 'com.tab_out_remote.split_ratio';
  const setting = 'splitRatio.enabled';
  const statuses = new Set(['adjusted', 'already-correct', 'permission-required', 'refused', 'error']);

  function createNativeRatio(api, options = {}) {
    const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const now = options.now || Date.now;
    const timeoutMs = options.timeoutMs ?? 8000;
    async function snapshot(dashboardId, targetId, identity) {
      const [dashboard, target] = await Promise.all([api.tabs.get(dashboardId), api.tabs.get(targetId)]);
      if (dashboard.windowId !== target.windowId || !Number.isInteger(dashboard.splitViewId) ||
          dashboard.splitViewId < 0 || dashboard.splitViewId !== target.splitViewId) return null;
      const window = await api.windows.get(dashboard.windowId);
      const front = await api.windows.getLastFocused();
      if (!window.focused || !front.focused || front.id !== window.id || window.type !== 'normal') return null;
      const members = await api.tabs.query({ windowId: window.id, splitViewId: dashboard.splitViewId });
      if (members.length !== 2 || !members.some(t => t.id === dashboardId) || !members.some(t => t.id === targetId) ||
          !members.some(t => t.active)) return null;
      const side = dashboard.index < target.index ? 'left' : 'right';
      const key = `${window.id}:${dashboard.splitViewId}:${side}`;
      if (identity && identity !== key) return null;
      const bounds = { left: window.left, top: window.top, width: window.width, height: window.height };
      if (!Object.values(bounds).every(Number.isFinite) || bounds.width < 200 || bounds.height < 200) return null;
      if (![dashboard.width, target.width].every(n => Number.isFinite(n) && n > 0)) return null;
      return { key, dashboard, target, bounds, side,
        widths: side === 'left' ? { left: dashboard.width, right: target.width } : { left: target.width, right: dashboard.width },
        ratio: dashboard.width / (dashboard.width + target.width) };
    }
    async function stable(dashboardId, targetId, identity, expectedRatio) {
      let previous;
      for (let i = 0; i < 9; i++) {
        const current = await snapshot(dashboardId, targetId, identity);
        if (!current) return null;
        if (previous && current.key === previous.key && JSON.stringify(current.bounds) === JSON.stringify(previous.bounds) &&
            Math.abs(current.widths.left - previous.widths.left) <= 1 && Math.abs(current.widths.right - previous.widths.right) <= 1 &&
            (expectedRatio === undefined || Math.abs(current.ratio - expectedRatio) <= 0.02)) return current;
        previous = current;
        await wait(100);
      }
      return null;
    }
    function validFinal(response, requestId) {
      return response && response.version === 2 && response.requestId === requestId && statuses.has(response.status) &&
        Object.keys(response).every(key => ['version', 'requestId', 'status', 'reason'].includes(key)) &&
        (response.reason === undefined || (typeof response.reason === 'string' && response.reason.length <= 160));
    }
    async function send(request, before, dashboardId, targetId) {
      return new Promise((resolve, reject) => {
        let port, timer, phase = 'preparing', token, settled = false;
        function finish(error, response) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (port) {
            if (error && token && phase !== 'committed') {
              try { port.postMessage({ version: 2, requestId: request.requestId, operation: 'abort-split-ratio', token }); }
              catch {}
            }
            port.onMessage.removeListener(receive);
            port.onDisconnect.removeListener(disconnected);
            try { port.disconnect(); } catch {}
          }
          if (error) reject(error); else resolve(response);
        }
        function disconnected() {
          void api.runtime.lastError;
          finish(new Error('host-unavailable'));
        }
        function receive(response) {
          if (settled) return;
          if (response?.status === 'prepared') {
            if (phase !== 'preparing' || response.version !== 2 || response.requestId !== request.requestId ||
                (typeof response.token !== 'string' || response.token.length !== 32 || !/^[a-f0-9]{32}$/.test(response.token)) ||
                Object.keys(response).sort().join(',') !== 'requestId,status,token,version') {
              finish(new Error('invalid-response'));
              return;
            }
            token = response.token;
            phase = 'validating';
            stable(dashboardId, targetId, before.key).then(current => {
              if (settled || phase !== 'validating') return;
              if (!current || JSON.stringify(current.bounds) !== JSON.stringify(before.bounds) ||
                  Math.abs(current.widths.left - before.widths.left) > 1 ||
                  Math.abs(current.widths.right - before.widths.right) > 1) {
                finish(new Error('layout-changed'));
                return;
              }
              phase = 'committed';
              try { port.postMessage({ version: 2, requestId: request.requestId, operation: 'commit-split-ratio', token }); }
              catch { finish(new Error('host-unavailable')); }
            }).catch(() => finish(new Error('layout-changed')));
            return;
          }
          if (!validFinal(response, request.requestId) ||
              (['adjusted', 'already-correct'].includes(response.status) && phase !== 'committed')) {
            finish(new Error('invalid-response'));
            return;
          }
          finish(null, response);
        }
        try {
          port = api.runtime.connectNative(host);
          port.onMessage.addListener(receive);
          port.onDisconnect.addListener(disconnected);
          timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
          port.postMessage(request);
        } catch { finish(new Error('host-unavailable')); }
      });
    }
    const minimumRatio = 0.20;
    const maximumRatio = 0.60;
    function targetOf(requestedRatio) {
      if (typeof requestedRatio !== 'number' || !Number.isFinite(requestedRatio)) return null;
      return Math.min(maximumRatio, Math.max(minimumRatio, requestedRatio));
    }
    async function apply(dashboardId, targetId, requestedRatio) {
      let before;
      let result = { status: 'skipped' };
      const targetRatio = targetOf(requestedRatio);
      // No measured ratio means this split is not worth correcting: leave Chrome's default layout alone.
      if (targetRatio === null) return result;
      try {
        if (!api.storage.local || !(await api.storage.local.get(setting))[setting]) return result;
        if ((await api.runtime.getPlatformInfo()).os !== 'mac') return result;
        before = await stable(dashboardId, targetId);
        if (!before) return { status: 'refused', reason: 'layout-changed' };
        if (Math.abs(before.ratio - targetRatio) <= 0.02) return { status: 'already-correct' };
        const requestId = root.crypto?.randomUUID?.() || `${now()}-${Math.random().toString(36).slice(2)}`;
        const response = await send({ version: 2, requestId, operation: 'set-split-ratio',
          expiresAt: now() + 6000, overviewSide: before.side, viewportWidths: before.widths, windowBounds: before.bounds,
          targetRatio }, before, dashboardId, targetId);
        result = { status: response.status, ...(response.reason ? { reason: response.reason } : {}) };
        if (['adjusted', 'already-correct'].includes(result.status)) {
          const after = await stable(dashboardId, targetId, before.key, targetRatio);
          if (!after || JSON.stringify(after.bounds) !== JSON.stringify(before.bounds) || Math.abs(after.ratio - targetRatio) > 0.02) {
            result = { status: 'error', reason: 'ratio-not-confirmed' };
          }
        }
      } catch (error) {
        result = { status: 'error', reason: ['timeout', 'invalid-response', 'layout-changed'].includes(error.message) ? error.message : 'host-unavailable' };
      } finally {
        // A native drag may focus the overview. Never reclaim focus after the user leaves this split/window.
        if (before) {
          try {
            const current = await snapshot(dashboardId, targetId, before.key);
            if (current && JSON.stringify(current.bounds) === JSON.stringify(before.bounds)) {
              await api.tabs.update(targetId, { active: true });
              await api.windows.update(current.dashboard.windowId, { focused: true });
            }
          } catch {}
        }
      }
      return result;
    }
    return { apply };
  }
  const exported = { createNativeRatio, host, setting };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.TabOutNativeRatio = exported;
})(globalThis);
