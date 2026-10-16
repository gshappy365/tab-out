(function (root) {
  'use strict';

  const origin = 'https://muse.ai/*';

  async function focusComposer() {
    if (location.origin !== 'https://muse.ai') return { status: 'unsupported' };
    const editable = element => element instanceof HTMLElement &&
      (element.matches('textarea, input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="password"])') || element.isContentEditable) &&
      !element.disabled && !element.readOnly && !element.closest('[inert], [aria-disabled="true"]');
    const visible = element => element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === 'visible' && getComputedStyle(element).display !== 'none';
    const current = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return { status: 'inactive' };
      if (editable(document.activeElement) && visible(document.activeElement)) return { status: 'preserved' };
      const candidates = Array.from(document.querySelectorAll(
        'textarea[aria-label="消息"], textarea[aria-label="Message"], textarea[aria-label="Message input"]'
      )).filter(element => editable(element) && visible(element));
      if (candidates.length > 1) return { status: 'ambiguous' };
      if (!candidates.length) return null;
      candidates[0].focus({ preventScroll: true });
      return { status: document.activeElement === candidates[0] ? 'focused' : 'unavailable' };
    };
    for (let attempt = 0; attempt < 9; attempt++) {
      const result = current();
      if (result) return result;
      if (attempt < 8) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { status: 'missing' };
  }

  function createMuseFocus(api) {
    async function restore(tabId) {
      const tab = await api.tabs.get(tabId);
      let url;
      try { url = new URL(tab.url); } catch { return { status: 'unsupported' }; }
      if (url.origin !== 'https://muse.ai' || !tab.active) return { status: 'unsupported' };
      if (!api.permissions || !api.scripting || !(await api.permissions.contains({ origins: [origin] }))) {
        return { status: 'not-granted' };
      }
      try {
        const results = await api.scripting.executeScript({ target: { tabId }, func: focusComposer });
        return results.find(result => result.frameId === 0)?.result || { status: 'unavailable' };
      } catch { return { status: 'unavailable' }; }
    }
    return { restore };
  }

  const exported = { origin, focusComposer, createMuseFocus };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.TabOutMuseFocus = exported;
})(globalThis);
