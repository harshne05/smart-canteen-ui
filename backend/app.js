/* Shared helpers for every Q-Skip page */
const Q = {
  user() { try { return JSON.parse(localStorage.getItem('qskip_user')); } catch { return null; } },
  requireLogin() {
    const u = Q.user();
    if (!u || !u.token) { location.replace('/login.html'); return null; }
    return u;
  },
  logout() { localStorage.removeItem('qskip_user'); location.href = '/login.html'; },
  esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  },
  async api(url, opts = {}) {
    const { staff, noRedirect, ...fetchOpts } = opts;
    const u = Q.user();
    const headers = { 'Content-Type': 'application/json', ...(fetchOpts.headers || {}) };
    if (u && u.token) headers.Authorization = 'Bearer ' + u.token;
    const res = await fetch(url, { ...fetchOpts, headers });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON response */ }
    if (res.status === 401 && !staff && !noRedirect) { localStorage.removeItem('qskip_user'); location.replace('/login.html'); }
    if (!res.ok || data.success === false) {
      const e = new Error(data.message || `Something went wrong (${res.status}). Please try again.`);
      e.status = res.status;
      throw e;
    }
    return data;
  },
  notice(msg, type = 'error') {
    let el = document.getElementById('notice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'notice';
      el.setAttribute('role', 'alert');
      document.body.appendChild(el);
    }
    el.className = 'notice ' + type;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(Q._t);
    Q._t = setTimeout(() => { el.hidden = true; }, 5001);
  }
};