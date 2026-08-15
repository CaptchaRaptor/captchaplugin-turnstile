importScripts(chrome.runtime.getURL('captcha/turnstile_cdp.js'));
    var i = chrome;
    var y = {
        version: 19,
        key: "",
        keys: [],
        enabled: !0,
        disabled_hosts: [],
        turnstile_auto_solve: !0,
        turnstile_solve_delay_time: 2e3,
        turnstile_solve_delay: !0,
    };
    var v = i.action,
        R = !0;

    function P(e) {
        if (e === R) return;
        R = e;
        let t = e ? "" : "g",
            r = [new Promise(o => {
                v.setIcon({
                    path: Object.fromEntries([16, 32, 48, 128].map(n => [n, `/icon/${n}${t}.png`]))
                }, o)
            })];
        return w && r.push(new Promise(o => {
            v.setBadgeText({
                text: e ? w : ""
            }, o)
        })), Promise.all(r)
    }
    var w = "";

    var I = new Set;
    i.runtime.onConnect.addListener(e => {
        e.name === "stream" && (I.add(e), e.onDisconnect.addListener(() => {
            I.delete(e)
        }))
    });

    function O(e) {
        I.forEach(t => t.postMessage(e))
    }
    var L = new Promise(e => {
        i.storage.local.get("settings", t => {
            if (!t?.settings) return e(y);
            let {
                settings: r
            } = t;
            r.version !== y.version && (r = {
                ...y,
                key: r.key
            }), r.enabled || P(!1), e(r)
        })
    });

    function f() {
        return L
    }
    async function E(e) {
        let t = {
            ...await L,
            ...e
        };
        return P(t.enabled), new Promise(r => {
            i.storage.local.set({
                settings: t
            }, () => {
                L = Promise.resolve(t), O({
                    event: "settingsUpdate",
                    settings: e
                }), r(null)
            })
        })
    }

    function D(e) {
        let t = ("b5b38eb8f40354127a85285f82a51f8b" + e).split("").map(r => r.charCodeAt(0));
        return Z(t)
    }
    var Y = new Uint32Array(256);
    for (let e = 256; e--;) {
        let t = e;
        for (let r = 8; r--;) t = t & 1 ? 3988292384 ^ t >>> 1 : t >>> 1;
        Y[e] = t
    }

    function Z(e) {
        let t = -1;
        for (let r of e) t = t >>> 8 ^ Y[t & 255 ^ r];
        return (t ^ -1) >>> 0
    }


    var ue = {
        "settings::get": f,
        "settings::update": ([e]) => E(e)
    };
    i.runtime.onMessage.addListener((e, t, r) => {
        if (!Array.isArray(e)) return;
        let o = e[1],
            n = ue[o];
        if (typeof n !== 'function') return;
        return Promise.resolve(n(e.slice(2), t)).then(a => {
            r([D(e[0]), a]); void chrome.runtime.lastError;
        }).catch(a => {
            console.error(`[RPC Error] [${o}] errored!`, e.slice(2), a);
            r([D(e[0]), "" + a]); void chrome.runtime.lastError;
        }), !0
    });

