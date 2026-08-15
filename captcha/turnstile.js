/*
 * captcha/turnstile.js  —  content script for Cloudflare Turnstile.
 *
 * Runs inside the Cloudflare challenge frame (challenges.cloudflare.com/
 * cdn-cgi/challenge-platform/*). Turnstile has no image to classify, so there
 * is no local model here. "Solving" means:
 *   1. mark this frame's <html> with a unique attribute,
 *   2. ask the background (which holds chrome.debugger) to locate this frame's
 *      on-screen rectangle and to perform a trusted, human-like click on the
 *      Turnstile checkbox.
 *
 * Logic mirrors the NopeCHA Turnstile content script (detect -> locate ->
 * trusted click), adapted to B23's [id, method, ...args] RPC convention.
 */
(() => {
  const b = chrome;
  // Shared with captcha/turnstile_cdp.js — must match on both sides.
  const MARKER_ATTR = "data-b23-ts";

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // B23 wire format: send [id, method, ...args], receive [id, result].
  // The background's debugger:: handlers echo the same id back; B23's own
  // handlers (settings::get) reply [transform(id), value]. Routing guarantees a
  // single responder per method, so we just take result = resp[1].
  function rpc(method, args = []) {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${Math.random()}`;
      try {
        b.runtime.sendMessage([id, method, ...args], (resp) => {
          if (b.runtime.lastError) { resolve(undefined); return; }
          resolve(Array.isArray(resp) ? resp[1] : undefined);
        });
      } catch (e) { resolve(undefined); }
    });
  }

  let settings = null;
  async function getSettings() {
    if (!settings) settings = await rpc("settings::get", []);
    return settings || {};
  }

  // Ask the background for this frame's absolute viewport rectangle.
  async function locate() {
    const marker = Math.random().toString(36).slice(2);
    const root = document.documentElement;
    root.setAttribute(MARKER_ATTR, marker);
    try {
      const box = await rpc("debugger::locateFrame", [marker]);
      if (box && [box.x, box.y, box.w, box.h].every(Number.isFinite)) return box;
      return null;
    } finally {
      root.removeAttribute(MARKER_ATTR);
    }
  }

  // Best-effort success detection from inside the challenge frame.
  function solved() {
    // Interactive widget flips to a success/checkmark state.
    if (document.querySelector('#success, [id*="success"], .cb-lb-t.cb-lb-t-active')) return true;
    const cb = document.querySelector('input[type="checkbox"]');
    if (cb && cb.checked) return true;
    return false;
  }

  let running = false;
  async function solve() {
    if (running) return;
    running = true;
    try {
      const s = await getSettings();
      if (s.enabled === false || s.turnstile_auto_solve === false) return;
      if (Array.isArray(s.disabled_hosts) && s.disabled_hosts.includes(location.hostname)) return;

      await delay(800);
      if (s.turnstile_solve_delay && s.turnstile_solve_delay_time > 0) {
        await delay(s.turnstile_solve_delay_time);
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        await rpc("debugger::enable", []);
        await delay(1500);

        const box = await locate();
        if (!box) { await delay(2000); continue; }

        const { x, y, w, h } = box;
        // The Turnstile checkbox sits near the left edge of the widget.
        const point = { x: x + 16 + 15, y: y + Math.floor(h / 2) };
        const movementBounds = { left: x, top: y, width: w, height: h, padding: 1 };
        const targetBounds = {
          left: x + 16,
          top: y + Math.max(0, Math.floor((h - 30) / 2)),
          width: 30, height: 30, padding: 4,
        };

        await rpc("debugger::clickAbs", [point.x, point.y, "left", movementBounds, targetBounds]);

        // Give Cloudflare time to validate; bail early on success.
        for (let t = 0; t < 20; t++) {
          if (solved()) return;
          await delay(500);
        }
      }
    } finally {
      running = false;
    }
  }

  function boot() {
    // Re-check periodically: the widget can render late or re-arm after a retry.
    let ticks = 0;
    const iv = setInterval(() => {
      if (solved()) { clearInterval(iv); return; }
      if (++ticks > 40) { clearInterval(iv); return; }
      solve();
    }, 1500);
    solve();
  }

  if (document.readyState !== "loading") boot();
  else addEventListener("DOMContentLoaded", boot, { once: true });
})();
