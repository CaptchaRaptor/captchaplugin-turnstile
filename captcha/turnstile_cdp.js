/*
 * captcha/turnstile_cdp.js  —  background (service-worker) CDP engine for Turnstile.
 *
 * Ported from the NopeCHA background worker (debugger::enable / locateFrame /
 * clickAbs) into B23. It drives chrome.debugger (Chrome DevTools Protocol) to:
 *   1. attach to the tab and track every frame's execution context,
 *   2. find the cross-origin Cloudflare challenge frame by a marker attribute,
 *   3. compose that frame's absolute viewport rectangle (walking the frame tree,
 *      OOPIF-aware), and
 *   4. perform a *trusted* (isTrusted=true) humanized mouse move + click on it.
 *
 * It registers its own runtime.onMessage listener that answers only the
 * "debugger::*" RPC methods, using B23's wire format [id, method, ...args] ->
 * [id, result]. Unknown methods are ignored so background.js keeps handling them.
 *
 * Loaded via: importScripts('captcha/turnstile_cdp.js') from background.js.
 */
(() => {
  if (!chrome.debugger) return;

  const PROTOCOL = "1.3";
  // Diagnostics: set to true to log scale factor + dispatched click coords to the
  // service-worker console (chrome://extensions -> service worker -> inspect).
  const DIAG = true;
  const log = (...a) => { if (DIAG) try { console.log("[ts-cdp]", ...a); } catch (e) {} };
  // Shared with captcha/turnstile.js — must match on both sides.
  const MARKER_ATTR = "data-b23-ts";
  const BUTTONS = { left: 1, right: 2, middle: 4, back: 8, forward: 16, none: 0 };

  const attached = new Set();        // tabIds we hold a debugger session on
  const enabled = new Set();         // tabIds with Page/Runtime/autoAttach enabled
  const contexts = new Map();        // tabId -> Map(sessionId|"root" -> [{contextId, frameId}])
  const targetSessions = new Map();  // frameId(targetId) -> sessionId  (OOPIF children)
  const lastPos = new Map();         // tabId -> {x, y}  (last virtual cursor position)

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  function rand(a, b) { return a + Math.random() * (b - a); }

  // ---- attach / enable -----------------------------------------------------

  async function attach(tabId) {
    if (tabId == null) return false;
    if (attached.has(tabId)) return true;
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL);
      attached.add(tabId);
      if (!contexts.has(tabId)) contexts.set(tabId, new Map());
      return true;
    } catch (e) {
      if (e && /already attached/i.test(e.message || "")) { attached.add(tabId); return true; }
      return false;
    }
  }

  async function send(tabId, method, params = {}, sessionId) {
    if (tabId == null) return null;
    if (!attached.has(tabId) && !(await attach(tabId))) return null;
    try {
      return await chrome.debugger.sendCommand({ tabId, sessionId }, method, params);
    } catch (e) {
      return null;
    }
  }

  async function enable(tabId) {
    if (!(await attach(tabId))) return false;
    if (!contexts.has(tabId)) contexts.set(tabId, new Map());
    const cmap = contexts.get(tabId);
    if (!cmap.has("root")) cmap.set("root", []);
    if (!enabled.has(tabId)) {
      await send(tabId, "Page.enable");
      await send(tabId, "Runtime.enable");
      // flatten + autoAttach reaches the cross-origin (out-of-process) Cloudflare frame.
      await send(tabId, "Target.setAutoAttach", {
        autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
      });
      enabled.add(tabId);
    }
    return true;
  }

  async function detach(tabId) {
    if (tabId == null) return false;
    try { await chrome.debugger.detach({ tabId }); } catch (e) {}
    attached.delete(tabId); enabled.delete(tabId); contexts.delete(tabId);
    return true;
  }

  // ---- execution-context tracking -----------------------------------------

  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    const tabId = source.tabId;
    if (tabId == null || !attached.has(tabId)) return;
    const sid = source.sessionId ?? "root";
    if (!contexts.has(tabId)) contexts.set(tabId, new Map());
    const cmap = contexts.get(tabId);

    if (method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = params;
      if (targetInfo && targetInfo.targetId) targetSessions.set(targetInfo.targetId, sessionId);
      if (!cmap.has(sessionId)) cmap.set(sessionId, []);
      try { await chrome.debugger.sendCommand({ tabId, sessionId }, "Runtime.enable"); } catch (e) {}
    } else if (method === "Target.detachedFromTarget") {
      const { sessionId, targetId } = params;
      if (targetId) targetSessions.delete(targetId);
      if (sessionId) cmap.delete(sessionId);
    } else if (method === "Runtime.executionContextCreated") {
      const ctx = params.context;
      const aux = ctx && ctx.auxData;
      if (aux && aux.isDefault) {
        const arr = cmap.get(sid) || [];
        arr.push({ contextId: ctx.id, frameId: aux.frameId });
        cmap.set(sid, arr);
      }
    } else if (method === "Runtime.executionContextDestroyed") {
      const arr = cmap.get(sid);
      if (arr) cmap.set(sid, arr.filter(c => c.contextId !== params.executionContextId));
    }
  });

  chrome.debugger.onDetach.addListener((source) => {
    const t = source.tabId;
    if (t == null) return;
    attached.delete(t); enabled.delete(t); contexts.delete(t);
  });

  // ---- frame discovery -----------------------------------------------------

  // Evaluate the marker test in every tracked context until one matches.
  async function findFrame(tabId, marker, retries = 5) {
    const cmap = contexts.get(tabId);
    if (!cmap) return null;
    const expr = `document.documentElement.getAttribute(${JSON.stringify(MARKER_ATTR)})===${JSON.stringify(marker)}`;
    for (let r = 0; r < retries; r++) {
      for (const [sid, arr] of cmap.entries()) {
        const target = sid === "root" ? { tabId } : { tabId, sessionId: sid };
        for (let i = arr.length - 1; i >= 0; i--) {
          const ctx = arr[i];
          try {
            const res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
              expression: expr, contextId: ctx.contextId, returnByValue: true,
            });
            if (res && res.result && res.result.value === true) {
              return { sessionId: sid === "root" ? undefined : sid, frameId: ctx.frameId };
            }
          } catch (e) {
            if (e && /Cannot find context/i.test(e.message || "")) arr.splice(i, 1);
          }
        }
      }
      await delay(50);
    }
    return null;
  }

  function findFrameNode(node, frameId) {
    if (node.frame.id === frameId) return { ...node.frame };
    if (node.childFrames) {
      for (const child of node.childFrames) {
        const f = findFrameNode(child, frameId);
        if (f) return f;
      }
    }
    return null;
  }

  async function layoutSize(tabId, sessionId) {
    const m = await send(tabId, "Page.getLayoutMetrics", {}, sessionId);
    if (m && m.cssContentSize) return { w: m.cssContentSize.width, h: m.cssContentSize.height };
    return null;
  }

  // Compose the absolute (top-page viewport) rectangle of a frame by walking up
  // the frame tree, adding each owner-iframe's offset. OOPIF-aware via targetSessions.
  async function frameBox(tabId, frameId, sessionId) {
    let guard = 0, curFrame = frameId, curSession = sessionId, x = 0, y = 0;
    let fx = null, fy = null, fw = null, fh = null, topW = 0, topH = 0;

    while (guard++ < 50) {
      const tree = await send(tabId, "Page.getFrameTree", {}, curSession);
      const node = tree ? findFrameNode(tree.frameTree, curFrame) : null;
      if (!node) return null;

      if (!node.parentId) {
        const ls = await layoutSize(tabId);
        if (ls) { topW = ls.w; topH = ls.h; }
        return { x, y, w: fw ?? topW, h: fh ?? topH };
      }

      const parentId = node.parentId;
      let parentSession = targetSessions.get(parentId);
      if (parentSession === undefined && curSession !== undefined &&
          findFrameNode(tree.frameTree, parentId)) {
        parentSession = curSession;
      }

      const owner = await send(tabId, "DOM.getFrameOwner", { frameId: curFrame }, parentSession);
      if (!owner || !owner.backendNodeId) return null;

      let bx = 0, by = 0, bw = 0, bh = 0, ok = false;
      const box = await send(tabId, "DOM.getBoxModel", { backendNodeId: owner.backendNodeId }, parentSession);
      if (box && box.model && box.model.content) {
        bx = box.model.content[0]; by = box.model.content[1];
        bw = box.model.width; bh = box.model.height; ok = true;
      }
      if (!ok) {
        const resolved = await send(tabId, "DOM.resolveNode", { backendNodeId: owner.backendNodeId }, parentSession);
        if (resolved && resolved.object) {
          const r = await send(tabId, "Runtime.callFunctionOn", {
            objectId: resolved.object.objectId, returnByValue: true,
            functionDeclaration: "function(){const r=this.getBoundingClientRect();const s=getComputedStyle(this);return{x:r.left+this.clientLeft+(parseFloat(s.paddingLeft)||0),y:r.top+this.clientTop+(parseFloat(s.paddingTop)||0),w:r.width-(parseFloat(s.paddingLeft)||0)-(parseFloat(s.paddingRight)||0),h:r.height-(parseFloat(s.paddingTop)||0)-(parseFloat(s.paddingBottom)||0)}}",
          }, parentSession);
          if (r && r.result && r.result.value && typeof r.result.value === "object") {
            const v = r.result.value;
            bx = v.x; by = v.y; bw = v.w; bh = v.h; ok = true;
          }
        }
      }
      if (ok && fx === null) { fx = bx; fy = by; fw = bw; fh = bh; }
      x += bx; y += by;
      curFrame = parentId; curSession = parentSession;
    }
    return { x, y, w: fw ?? 0, h: fh ?? 0 };
  }

  // ---- humanized trusted click --------------------------------------------

  function dispatch(tabId, type, x, y, button, clickCount) {
    return send(tabId, "Input.dispatchMouseEvent", {
      type, x, y,
      button: button || "none",
      buttons: BUTTONS[button || "none"] || 0,
      clickCount: clickCount || 0,
    });
  }

  // Quadratic-bezier path with a perpendicular arc and per-step jitter/delay.
  async function humanMove(tabId, fromX, fromY, toX, toY) {
    const dist = Math.hypot(toX - fromX, toY - fromY);
    const steps = Math.max(8, Math.round(dist / 12));
    const mx = (fromX + toX) / 2, my = (fromY + toY) / 2;
    let nx = -(toY - fromY), ny = (toX - fromX);
    const nl = Math.hypot(nx, ny) || 1;
    const arc = rand(-1, 1) * Math.min(40, dist * 0.18);
    const cx = mx + (nx / nl) * arc, cy = my + (ny / nl) * arc;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const jx = i < steps ? rand(-0.6, 0.6) : 0;
      const jy = i < steps ? rand(-0.6, 0.6) : 0;
      const bx = (1 - t) * (1 - t) * fromX + 2 * (1 - t) * t * cx + t * t * toX + jx;
      const by = (1 - t) * (1 - t) * fromY + 2 * (1 - t) * t * cy + t * t * toY + jy;
      await dispatch(tabId, "mouseMoved", bx, by, "none", 0);
      await delay(rand(6, 18));
    }
  }

  async function clickAbs(tabId, x, y, button, movementBounds, targetBounds) {
    if (tabId == null || !(await enable(tabId))) return false;
    button = button || "left";

    // Aim a little off dead-center inside the checkbox, like a human.
    let tx = x, ty = y;
    if (targetBounds && targetBounds.width && targetBounds.height) {
      tx += rand(-1, 1) * Math.max(0, targetBounds.width / 2 - 4) * 0.4;
      ty += rand(-1, 1) * Math.max(0, targetBounds.height / 2 - 4) * 0.4;
    }

    const prev = lastPos.get(tabId) || { x: tx - rand(40, 120), y: ty - rand(30, 90) };
    await humanMove(tabId, prev.x, prev.y, tx, ty);
    lastPos.set(tabId, { x: tx, y: ty });

    log("clickAbs dispatch at", { x: tx, y: ty }, "from request", { x, y });
    await delay(rand(40, 110));                       // settle before press
    await dispatch(tabId, "mousePressed", tx, ty, button, 1);
    await delay(rand(45, 120));                       // hold
    await dispatch(tabId, "mouseReleased", tx, ty, button, 1);
    return true;
  }

  // ---- RPC -----------------------------------------------------------------

  const handlers = {
    "debugger::enable": (args, sender) => enable(sender?.tab?.id),
    "debugger::detach": (args, sender) => detach(sender?.tab?.id),
    "debugger::locateFrame": async ([marker], sender) => {
      const tabId = sender?.tab?.id;
      if (tabId == null) return null;
      await enable(tabId);
      const found = await findFrame(tabId, marker);
      if (!found) return null;
      const box = await frameBox(tabId, found.frameId, found.sessionId);
      if (DIAG) {
        // Compare host DSF vs CSS layout to spot fractional-scaling mismatches.
        const lm = await send(tabId, "Page.getLayoutMetrics");
        const dpr = await send(tabId, "Runtime.evaluate", {
          expression: "window.devicePixelRatio", returnByValue: true,
        });
        log("locateFrame box=", box,
            "devicePixelRatio=", dpr?.result?.value,
            "cssLayoutViewport=", lm?.cssLayoutViewport,
            "layoutViewport=", lm?.layoutViewport);
      }
      return box;
    },
    "debugger::clickAbs": ([x, y, button, movementBounds, targetBounds], sender) =>
      clickAbs(sender?.tab?.id, x, y, button, movementBounds, targetBounds),
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!Array.isArray(msg)) return;            // not our wire format
    const [id, method, ...args] = msg;
    const h = handlers[method];
    if (typeof h !== "function") return;        // not a debugger:: method -> let background.js handle it
    Promise.resolve(h(args, sender)).then(
      v => { try { sendResponse([id, v]); } catch (e) {} void chrome.runtime.lastError; },
      e => { try { sendResponse([id, "" + e]); } catch (e2) {} void chrome.runtime.lastError; }
    );
    return true;                                // keep the channel open for the async response
  });
})();
