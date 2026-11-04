'use strict';
/* Keeps the phone and the cloud in step. Sends what was made here, brings back what was made elsewhere.
   Safe to repeat: the cloud ignores anything it already has. */
(function () {
  const MAX_ROUNDS = 20; // a phone with a lot to catch up on takes a few rounds

  function create({ eng, getToken, deviceId, fetchFn = (...a) => fetch(...a), isOnline = () => navigator.onLine, onStatus = () => {}, onRevoked = () => {} }) {
    let running = false, again = false, state = 'idle', timers = [], debounce, current = null;

    const set = (s) => { state = s; onStatus({ state, pending: eng.pendingCount() }); };

    async function loop() {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (!isOnline()) return set('offline');
        let token;
        try { token = await getToken(); } catch { token = null; }
        if (!token) return set('offline');
        set('syncing');
        const { body, sent } = eng.pending();
        const t0 = Date.now();
        let res;
        try {
          res = await fetchFn('/api/sync', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, cursor: eng.session().cursor, push: body }) });
        } catch { return set('offline'); }
        const t1 = Date.now();
        if (res.status === 403) { const j = await res.json().catch(() => ({})); return j.code === 'revoked' ? onRevoked() : set('error'); }
        if (res.status === 401) return set('signin');
        if (!res.ok) return set('error');
        const j = await res.json();
        await eng.applySync(j, sent, Date.parse(j.serverTime) - (t0 + t1) / 2); // learn the server's clock
        if (!j.more && eng.pendingCount() === 0) return set('synced');
      }
      set('error');
    }

    /** Run a sync now. Calls made while one is running are folded into one more run afterwards. */
    function run() {
      if (running) { again = true; return current; } // the one in progress will go round once more
      running = true;
      current = (async () => {
        try { do { again = false; await loop(); } while (again); }
        catch (e) { console.error(e); set('error'); }
        finally { running = false; }
      })();
      return current;
    }

    /** Browser triggers: coming online, coming back to the tab, every little while, and after each change. */
    function start(everyMs) {
      const on = (target, name, fn) => { target.addEventListener(name, fn); timers.push(() => target.removeEventListener(name, fn)); };
      on(window, 'online', run);
      on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') run(); });
      const t = setInterval(run, everyMs); timers.push(() => clearInterval(t));
      eng.on('local', () => { clearTimeout(debounce); debounce = setTimeout(run, 400); });
    }
    const stop = () => { timers.forEach((f) => f()); timers = []; clearTimeout(debounce); };

    return { run, start, stop, state: () => state };
  }

  globalThis.Sync = { create };
})();
