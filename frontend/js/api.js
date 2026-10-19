const API = {
  base: '',
  async get(path) {
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error(await r.text().catch(() => r.statusText));
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(this.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) {
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = { error: t } }
      throw new Error(j.error || t);
    }
    return r.json();
  },
  async del(path) {
    const r = await fetch(this.base + path, { method: 'DELETE' });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async put(path, body) {
    const r = await fetch(this.base + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
};
