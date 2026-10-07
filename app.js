/* Streamradar – konsolidierte Ansicht der Streaming-Anbieter mit Jellyfin-Abgleich
 * Datenquelle: TMDB (Verfügbarkeitsdaten von JustWatch), Abgleich: Jellyfin, Requests: Jellyseerr/Overseerr
 */
'use strict';
(() => {
  const VERSION = '1.1.0';
  const API = 'https://api.themoviedb.org/3';
  const IMG = 'https://image.tmdb.org/t/p/';
  const LANG = 'de-DE';

  /* ================= Storage ================= */
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem('sr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('sr.' + k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem('sr.' + k); } catch { /* ignore */ } },
  };

  const DEFAULT_SETTINGS = { tmdbKey: '', region: 'CH', providers: null, providersRegion: null, seerrUrl: '', size: 'm', theme: 'system', view: 'grid', showAllProviders: false };
  const S = Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {}));
  const saveSettings = () => store.set('settings', S);

  const DEFAULT_FILTERS = { providers: [], type: 'all', sort: 'popularity', since: 0, genres: [], minRating: 0 };
  const F = Object.assign({}, DEFAULT_FILTERS, store.get('filters', {}));
  const saveFilters = () => store.set('filters', F);

  const G = Object.assign({ status: 'all', trendWin: 'week', trendType: 'all', trendMine: true, upMode: 'tv', query: '' }, store.get('ui', {}));
  const saveUI = () => store.set('ui', { status: G.status, trendWin: G.trendWin, trendType: G.trendType, trendMine: G.trendMine, upMode: G.upMode });

  /* ================= Helpers ================= */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uniq = (a) => [...new Set(a)];
  const isoDate = (offsetDays = 0) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const year = (d) => (d || '').slice(0, 4);
  const dfShort = new Intl.DateTimeFormat('de-CH', { day: 'numeric', month: 'short' });
  const dfLong = new Intl.DateTimeFormat('de-CH', { day: 'numeric', month: 'long', year: 'numeric' });
  const parseD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtRel = (s) => { if (!s) return ''; if (s === isoDate(0)) return 'Heute'; if (s === isoDate(1)) return 'Morgen'; return dfShort.format(parseD(s)); };
  const fmtLong = (s) => (s ? dfLong.format(parseD(s)) : '');
  const fmtNum = (n) => Number(n || 0).toLocaleString('de-CH');
  const normUrl = (u) => { u = (u || '').trim(); if (!u) return ''; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; return u.replace(/\/+$/, ''); };
  const key = (it) => it.type + ':' + it.id;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function toast(msg, ms = 2800) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }

  function limiter(n) {
    let active = 0; const q = [];
    const next = () => {
      if (active >= n || !q.length) return;
      active++;
      const { fn, res, rej } = q.shift();
      Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); });
    };
    return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
  }
  const netLimit = limiter(6);

  /* ================= TMDB ================= */
  const mem = new Map();
  class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

  function tmdb(path, params = {}, { ttl = 6 * 3600e3 } = {}) {
    const k = (S.tmdbKey || '').trim();
    if (!k) return Promise.reject(new ApiError('Kein TMDB-Key hinterlegt.', 0));
    const bearer = k.length > 60;
    const url = new URL(API + path);
    for (const [p, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(p, v);
    const cacheKey = url.toString();
    const hit = mem.get(cacheKey);
    if (hit && Date.now() - hit.t < ttl) return hit.p;
    if (!bearer) url.searchParams.set('api_key', k);
    const headers = { accept: 'application/json' };
    if (bearer) headers.Authorization = 'Bearer ' + k;
    const run = async (attempt = 0) => {
      let r;
      try { r = await fetch(url, { headers }); } catch { throw new ApiError('Keine Verbindung zu TMDB.', 0); }
      if (r.status === 429 && attempt < 2) { await new Promise((ok) => setTimeout(ok, 1200 * (attempt + 1))); return run(attempt + 1); }
      if (r.status === 401) throw new ApiError('TMDB-Key ungültig. Bitte in den Einstellungen prüfen.', 401);
      if (!r.ok) throw new ApiError('TMDB-Fehler (' + r.status + ')', r.status);
      return r.json();
    };
    const p = netLimit(() => run());
    mem.set(cacheKey, { t: Date.now(), p });
    p.catch(() => mem.delete(cacheKey));
    return p;
  }

  /* ================= Anbieter & Genres ================= */
  let PROVIDERS = [];
  const PMAP = new Map();
  const SHORT = { 'Amazon Prime Video': 'Prime Video', 'Disney Plus': 'Disney+', 'Apple TV Plus': 'Apple TV+', 'Paramount Plus': 'Paramount+', 'Paramount Plus Premium': 'Paramount+ Premium', 'Netflix Standard with Ads': 'Netflix (Werbung)' };
  const HIDE_IDS = new Set([2, 3, 10, 35, 68, 130, 192]);
  const HIDE_RE = /(amazon channel|apple tv channel|roku premium|with ads|store|google play|rakuten|videobuster|chili|microsoft|kividoo|amazon video)/i;
  const DEFAULT_IDS = new Set([8, 337, 119, 9, 350, 1899, 384, 531]);
  const DEFAULT_RE = /^(netflix|disney plus|amazon prime video|apple tv plus|hbo max|max|sky|sky show|sky x|paramount plus|paramount\+|play suisse)$/i;

  const shortName = (n) => SHORT[n] || n;
  const prio = (id) => (PMAP.get(id) || {}).prio ?? 9999;
  const isMain = (p) => !HIDE_IDS.has(p.id) && !HIDE_RE.test(p.name);

  function setProviders(arr) {
    PROVIDERS = arr;
    for (const p of arr) PMAP.set(p.id, p);
  }
  function rememberProvider(p) {
    if (!PMAP.has(p.provider_id)) PMAP.set(p.provider_id, { id: p.provider_id, name: p.provider_name, short: shortName(p.provider_name), logo: p.logo_path, prio: 9000 + (p.display_priority || 0) });
  }
  function defaultProviderIds() {
    return PROVIDERS.filter((p) => !HIDE_IDS.has(p.id) && (DEFAULT_IDS.has(p.id) || DEFAULT_RE.test(p.name))).map((p) => p.id);
  }
  const myIds = () => (S.providers || []).filter((id) => PMAP.has(id)).sort((a, b) => prio(a) - prio(b));
  const myProviders = () => myIds().map((id) => PMAP.get(id));

  async function loadProviders(force = false) {
    const ck = 'prov.' + S.region;
    const c = store.get(ck);
    if (!force && c && Date.now() - c.t < 7 * 864e5 && c.v.length) {
      setProviders(c.v);
    } else {
      const [m, t] = await Promise.all([
        tmdb('/watch/providers/movie', { watch_region: S.region, language: LANG }),
        tmdb('/watch/providers/tv', { watch_region: S.region, language: LANG }),
      ]);
      const byId = new Map();
      for (const p of [...(m.results || []), ...(t.results || [])]) {
        if (byId.has(p.provider_id)) continue;
        byId.set(p.provider_id, {
          id: p.provider_id, name: p.provider_name, short: shortName(p.provider_name), logo: p.logo_path,
          prio: (p.display_priorities && p.display_priorities[S.region]) ?? p.display_priority ?? 999,
        });
      }
      const arr = [...byId.values()].sort((a, b) => a.prio - b.prio);
      store.set(ck, { t: Date.now(), v: arr });
      setProviders(arr);
    }
    if (S.providers == null || S.providersRegion !== S.region) {
      S.providers = defaultProviderIds();
      S.providersRegion = S.region;
      saveSettings();
    }
  }

  let GENRES = [];
  const MOVIE_TO_TV = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 };
  async function loadGenres() {
    const c = store.get('genres');
    if (c && Date.now() - c.t < 30 * 864e5) { GENRES = c.v; return; }
    const [m, t] = await Promise.all([tmdb('/genre/movie/list', { language: LANG }), tmdb('/genre/tv/list', { language: LANG })]);
    const tvIds = new Set(t.genres.map((g) => g.id));
    const mapped = new Set(Object.values(MOVIE_TO_TV));
    const movieIds = new Set(m.genres.map((g) => g.id));
    const list = m.genres.filter((g) => g.id !== 10770).map((g) => ({ key: 'm' + g.id, name: g.name, movie: g.id, tv: tvIds.has(g.id) ? g.id : (MOVIE_TO_TV[g.id] ?? null) }));
    for (const g of t.genres) if (!movieIds.has(g.id) && !mapped.has(g.id)) list.push({ key: 't' + g.id, name: g.name, movie: null, tv: g.id });
    list.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    GENRES = list;
    store.set('genres', { t: Date.now(), v: list });
  }

  let metaPromise = null;
  function ensureMeta() {
    if (!metaPromise) metaPromise = Promise.all([loadProviders(), loadGenres()]).catch((e) => { metaPromise = null; throw e; });
    return metaPromise;
  }

  function jwUrl(p) {
    const r = S.region.toLowerCase();
    const de = ['ch', 'de', 'at'].includes(r);
    const o = { 350: 'apple-tv-plus', 1899: 'hbo-max', 384: 'hbo-max', 337: 'disney-plus', 119: 'amazon-prime-video', 9: 'amazon-prime-video', 531: 'paramount-plus' };
    const slug = o[p.id] || p.name.toLowerCase().replace(/\+/g, '-plus').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `https://www.justwatch.com/${r}/${de ? 'Anbieter' : 'provider'}/${slug}/${de ? 'Neu' : 'new'}`;
  }

  /* ================= Anreicherung (Anbieter pro Titel, nächste Episode) ================= */
  const ENR_TTL = 20 * 3600e3;
  const ENR = (() => {
    const raw = store.get('enr', {});
    const now = Date.now();
    const entries = Object.entries(raw).filter(([, v]) => Array.isArray(v) && now - v[0] < 3 * 864e5).sort((a, b) => b[1][0] - a[1][0]).slice(0, 4000);
    return Object.fromEntries(entries);
  })();
  const saveEnr = debounce(() => { if (!store.set('enr', ENR)) { /* voll: älteste Hälfte verwerfen */ const ks = Object.keys(ENR).sort((a, b) => ENR[a][0] - ENR[b][0]); ks.slice(0, ks.length / 2).forEach((k) => delete ENR[k]); store.set('enr', ENR); } }, 1500);
  const enrPending = new Map();
  const enrFresh = (k) => ENR[k] && Date.now() - ENR[k][0] < ENR_TTL;

  function provListFrom(wp) {
    const all = [...(wp.flatrate || []), ...(wp.free || []), ...(wp.ads || [])];
    all.forEach(rememberProvider);
    return uniq(all.map((p) => p.provider_id));
  }

  function enrich(type, id) {
    const k = type + ':' + id;
    if (enrFresh(k)) return Promise.resolve(ENR[k]);
    if (enrPending.has(k)) return enrPending.get(k);
    const p = tmdb(`/${type}/${id}`, { language: LANG, append_to_response: 'watch/providers' }, { ttl: 3600e3 })
      .then((d) => {
        const wp = (d['watch/providers'] && d['watch/providers'].results && d['watch/providers'].results[S.region]) || {};
        const ne = d.next_episode_to_air;
        const rec = [Date.now(), provListFrom(wp), ne ? ne.air_date : null, ne ? `S${ne.season_number} E${ne.episode_number}` : null];
        ENR[k] = rec; saveEnr();
        return rec;
      })
      .finally(() => enrPending.delete(k));
    enrPending.set(k, p);
    return p;
  }

  /* ================= Jellyfin ================= */
  const deviceId = store.get('deviceId') || (() => { const id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()); store.set('deviceId', id); return id; })();
  const JF = {
    conn: store.get('jf', null),
    lib: store.get('jflib', null),
    syncing: null,
    get ready() { return !!(this.conn && this.lib); },
    has(type, id) { return !!(this.lib && this.lib[type === 'movie' ? 'm' : 's'][id]); },
    itemUrl(type, id) {
      const iid = this.lib && this.lib[type === 'movie' ? 'm' : 's'][id];
      return iid && this.conn ? `${this.conn.url}/web/#/details?id=${iid}${this.conn.serverId ? '&serverId=' + this.conn.serverId : ''}` : null;
    },
    auth(token) {
      const dev = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Mobil' : 'Browser';
      return `MediaBrowser Client="Streamradar", Device="${dev}", DeviceId="${deviceId}", Version="${VERSION}"` + (token ? `, Token="${token}"` : '');
    },
    netErr(url) {
      const mixed = location.protocol === 'https:' && url.startsWith('http:');
      return new Error(mixed
        ? 'Der Server ist nur über http:// erreichbar – das blockiert der Browser in einer https-App. Bitte die https-Adresse verwenden.'
        : 'Server nicht erreichbar. Mögliche Gründe: falsche Adresse oder der Server erlaubt keine Zugriffe von dieser Web-App (CORS).');
    },
    async connect(url, user, pw) {
      url = normUrl(url);
      let r;
      try {
        r = await fetch(url + '/Users/AuthenticateByName', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: this.auth() },
          body: JSON.stringify({ Username: user, Pw: pw }),
        });
      } catch { throw this.netErr(url); }
      if (r.status === 401 || r.status === 403) throw new Error('Benutzername oder Passwort falsch.');
      if (!r.ok) throw new Error('Anmeldung fehlgeschlagen (' + r.status + ').');
      const j = await r.json();
      this.conn = { url, token: j.AccessToken, userId: j.User && j.User.Id, userName: (j.User && j.User.Name) || user, serverId: j.ServerId || (j.User && j.User.ServerId) || '' };
      store.set('jf', this.conn);
      await this.sync();
    },
    sync() {
      if (this.syncing) return this.syncing;
      this.syncing = (async () => {
        const { url, token, userId } = this.conn;
        const headers = { Authorization: this.auth(token) };
        const m = {}; const s = {}; let noId = 0;
        let start = 0; let total = Infinity; const LIMIT = 1000; let legacy = false;
        while (start < total) {
          const qs = `Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds&EnableImages=false&EnableUserData=false&EnableTotalRecordCount=true&StartIndex=${start}&Limit=${LIMIT}`;
          const u = legacy ? `${url}/Users/${userId}/Items?${qs}` : `${url}/Items?userId=${userId}&${qs}`;
          let r;
          try { r = await fetch(u, { headers }); } catch { throw this.netErr(url); }
          if (!legacy && (r.status === 404 || r.status === 400)) { legacy = true; continue; }
          if (r.status === 401) { throw new Error('Jellyfin-Anmeldung abgelaufen. Bitte neu verbinden.'); }
          if (!r.ok) throw new Error('Jellyfin-Fehler (' + r.status + ').');
          const j = await r.json();
          const items = j.Items || [];
          total = j.TotalRecordCount ?? (items.length < LIMIT ? start + items.length : Infinity);
          for (const it of items) {
            const pid = it.ProviderIds || {};
            const tm = pid.Tmdb || pid.tmdb || pid.TMDb;
            if (!tm) { noId++; continue; }
            (it.Type === 'Movie' ? m : s)[tm] = it.Id;
          }
          if (!items.length) break;
          start += items.length;
        }
        this.lib = { ts: Date.now(), m, s, nm: Object.keys(m).length, ns: Object.keys(s).length, noId };
        if (!store.set('jflib', this.lib)) toast('Bibliothek zu gross zum Zwischenspeichern – Abgleich gilt nur bis zum Neuladen.');
        updateJfDot();
      })().finally(() => { this.syncing = null; });
      return this.syncing;
    },
    /* Favoriten: neue API (10.9+) mit Rückfall auf die ältere Route */
    async req(method, paths) {
      const headers = { Authorization: this.auth(this.conn.token) };
      let last;
      for (const p of paths) {
        let r;
        try { r = await fetch(this.conn.url + p, { method, headers }); } catch { throw this.netErr(this.conn.url); }
        if (r.status === 404 || r.status === 405 || r.status === 400) { last = r; continue; }
        if (r.status === 401) throw new Error('Jellyfin-Anmeldung abgelaufen. Bitte neu verbinden.');
        if (!r.ok) throw new Error('Jellyfin-Fehler (' + r.status + ').');
        return r.status === 204 ? null : r.json().catch(() => null);
      }
      throw new Error('Jellyfin-Fehler (' + (last ? last.status : '?') + ').');
    },
    iid(type, id) { return this.lib && this.lib[type === 'movie' ? 'm' : 's'][id]; },
    async isFavorite(type, id) {
      const iid = this.iid(type, id); const u = this.conn.userId;
      const j = await this.req('GET', [`/Items?userId=${u}&Ids=${iid}&EnableUserData=true&EnableImages=false`, `/Users/${u}/Items?Ids=${iid}&EnableUserData=true&EnableImages=false`]);
      const it = j && j.Items && j.Items[0];
      return !!(it && it.UserData && it.UserData.IsFavorite);
    },
    async setFavorite(type, id, on) {
      const iid = this.iid(type, id); const u = this.conn.userId;
      await this.req(on ? 'POST' : 'DELETE', [`/UserFavoriteItems/${iid}?userId=${u}`, `/Users/${u}/FavoriteItems/${iid}`]);
    },
    disconnect() {
      if (this.conn) fetch(this.conn.url + '/Sessions/Logout', { method: 'POST', headers: { Authorization: this.auth(this.conn.token) } }).catch(() => {});
      this.conn = null; this.lib = null;
      store.del('jf'); store.del('jflib');
      updateJfDot();
    },
  };
  const statusOk = (it) => {
    if (G.status === 'all' || !JF.ready) return true;
    const h = JF.has(it.type, it.id);
    return G.status === 'missing' ? !h : h;
  };
  function updateJfDot() {
    const b = $('#jf-status');
    b.classList.toggle('on', JF.ready);
    b.title = JF.ready ? `Jellyfin verbunden · ${fmtNum(JF.lib.nm)} Filme, ${fmtNum(JF.lib.ns)} Serien` : 'Jellyfin nicht verbunden';
  }

  /* ================= Discover / Feeds ================= */
  function norm(r, type, provs = null) {
    const t = type || r.media_type;
    return {
      type: t, id: r.id, title: r.title || r.name || r.original_title || r.original_name || '–',
      date: r.release_date || r.first_air_date || '', poster: r.poster_path, vote: r.vote_average || 0, votes: r.vote_count || 0,
      pop: r.popularity || 0, provs,
    };
  }

  function discoverParams(type, f, provIds) {
    const p = { watch_region: S.region, with_watch_providers: provIds.join('|'), with_watch_monetization_types: 'flatrate|free|ads', language: LANG, include_adult: false };
    const today = isoDate(0);
    p.sort_by = f.sort === 'newest' ? (type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc') : f.sort === 'rating' ? 'vote_average.desc' : 'popularity.desc';
    const since = type === 'movie' ? (f.sinceMovie ?? f.since) : (f.sinceTv ?? f.since);
    if (type === 'movie') {
      if (since) p['primary_release_date.gte'] = isoDate(-since);
      p['primary_release_date.lte'] = today;
    } else if (since) {
      p['air_date.gte'] = isoDate(-since); p['air_date.lte'] = today;
    } else {
      p['first_air_date.lte'] = today;
    }
    let vc = 0;
    if (f.sort === 'rating') vc = type === 'movie' ? 200 : 100;
    if (f.minRating) { p['vote_average.gte'] = f.minRating; vc = Math.max(vc, 30); }
    if (vc) p['vote_count.gte'] = vc;
    if (f.genres && f.genres.length) {
      const ids = uniq(f.genres.map((gk) => { const g = GENRES.find((x) => x.key === gk); return g ? g[type] : null; }).filter(Boolean));
      if (!ids.length) return null; // Genre existiert für diesen Typ nicht
      p.with_genres = ids.join('|');
    }
    return p;
  }

  const sorter = (sort) => sort === 'newest' ? (a, b) => (b.date || '').localeCompare(a.date || '')
    : sort === 'rating' ? (a, b) => b.vote - a.vote : (a, b) => b.pop - a.pop;

  function discoverSource(type, f, provIds) {
    const types = type === 'all' ? ['movie', 'tv'] : [type];
    const done = {};
    const tag = provIds.length === 1 ? provIds.slice() : null;
    return async (page) => {
      const parts = await Promise.all(types.map(async (t) => {
        if (done[t]) return [];
        const p = discoverParams(t, f, provIds);
        if (!p) { done[t] = true; return []; }
        const r = await tmdb('/discover/' + t, { ...p, page });
        if (page >= Math.min(r.total_pages || 0, 500)) done[t] = true;
        return (r.results || []).map((x) => norm(x, t, tag));
      }));
      const items = parts.flat().sort(sorter(f.sort));
      return { items, done: types.every((t) => done[t]) };
    };
  }

  function makeFeed(source, accept = null) {
    let page = 0; let done = false; const seen = new Set();
    return {
      get done() { return done; },
      async next(want = 18, maxPages = 5) {
        const out = []; let n = 0;
        while (!done && out.length < want && n < maxPages) {
          page++; n++;
          const r = await source(page);
          if (r.done) done = true;
          let items = r.items.filter((it) => { const k = key(it); if (seen.has(k)) return false; seen.add(k); return true; });
          if (accept) { const ok = await Promise.all(items.map((it) => Promise.resolve(accept(it)).catch(() => false))); items = items.filter((_, i) => ok[i]); }
          out.push(...items);
        }
        return out;
      },
    };
  }

  /* ================= Rendering: Kacheln ================= */
  const enrIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target; enrIO.unobserve(el);
      const k = el.dataset.k; const [type, id] = k.split(':');
      enrich(type, +id).then((rec) => paintEnr(k, rec)).catch(() => {});
    }
  }, { rootMargin: '200px' });

  function provLogosHTML(ids, max = 3) {
    if (!ids || !ids.length) return '';
    const mine = new Set(S.providers || []);
    const sorted = [...ids].filter((id) => PMAP.has(id)).sort((a, b) => (mine.has(b) - mine.has(a)) || (prio(a) - prio(b)));
    return sorted.slice(0, max).map((id) => { const p = PMAP.get(id); return p.logo ? `<img src="${IMG}w45${p.logo}" alt="${esc(p.short)}" title="${esc(p.short)}" loading="lazy">` : ''; }).join('');
  }
  const provIdsFor = (it) => (enrFresh(key(it)) ? ENR[key(it)][1] : (it.provs || []));

  function paintEnr(k, rec) {
    $$(`[data-k="${k}"]`).forEach((el) => {
      const box = el.querySelector('.tile-prov');
      if (box) box.innerHTML = provLogosHTML(rec[1]);
      const nd = el.querySelector('[data-ne]');
      if (nd && rec[2]) { nd.textContent = fmtRel(rec[2]); nd.hidden = false; nd.title = (rec[3] || '') + ' · ' + fmtLong(rec[2]); }
    });
  }

  const srvBadge = '<span class="srv" title="Auf dem Server"><svg><use href="#i-check"/></svg></span>';
  const ratingHTML = (it) => (it.vote && it.votes >= 5 ? `<span class="rating"><svg><use href="#i-star"/></svg>${it.vote.toFixed(1)}</span>` : '');

  function tileHTML(it, o = {}) {
    const k = key(it);
    const img = it.poster ? `<img src="${IMG}w185${it.poster}" alt="" loading="lazy" decoding="async">` : `<div class="noimg">${esc(it.title)}</div>`;
    const ne = enrFresh(k) ? ENR[k] : null;
    let badge = '';
    if (o.badge === 'date' && it.date) badge = `<span class="tile-date">${fmtRel(it.date)}</span>`;
    if (o.badge === 'nextep') badge = `<span class="tile-date" data-ne ${ne && ne[2] ? '' : 'hidden'}>${ne && ne[2] ? fmtRel(ne[2]) : ''}</span>`;
    const y = year(it.date);
    return `<button class="tile" data-k="${k}" type="button">
      <div class="poster">${img}<span class="pill ${it.type}">${it.type === 'movie' ? 'Film' : 'Serie'}</span>${JF.has(it.type, it.id) ? srvBadge : ''}<div class="tile-prov">${provLogosHTML(provIdsFor(it))}</div>${badge}</div>
      <div class="tile-meta"><div class="t">${esc(it.title)}</div><div class="s">${y ? `<span>${y}</span>` : ''}${ratingHTML(it)}</div></div>
    </button>`;
  }

  function rowHTML(it, o = {}) {
    const k = key(it);
    const img = it.poster ? `<img src="${IMG}w92${it.poster}" alt="" loading="lazy" decoding="async">` : '';
    const ne = enrFresh(k) ? ENR[k] : null;
    let extra = '';
    if (o.badge === 'date' && it.date) extra = `<span>${fmtRel(it.date)}</span>`;
    if (o.badge === 'nextep') extra = `<span data-ne ${ne && ne[2] ? '' : 'hidden'}>${ne && ne[2] ? fmtRel(ne[2]) : ''}</span>`;
    return `<button class="lrow" data-k="${k}" type="button">
      <div class="lp">${img}</div>
      <div class="lmin"><div class="lt">${esc(it.title)}</div>
        <div class="ls"><span class="tag ${it.type}">${it.type === 'movie' ? 'Film' : 'Serie'}</span>${year(it.date) ? `<span>${year(it.date)}</span>` : ''}${ratingHTML(it)}${extra}</div></div>
      <div class="lr"><div class="tile-prov">${provLogosHTML(provIdsFor(it))}</div>${JF.has(it.type, it.id) ? srvBadge : ''}</div>
    </button>`;
  }

  function appendItems(container, items, o = {}) {
    if (!items.length) return;
    const list = o.list ?? (S.view === 'list' && !o.row);
    const html = items.map((it) => (list ? rowHTML(it, o) : tileHTML(it, o))).join('');
    container.insertAdjacentHTML('beforeend', html);
    const els = [...container.children].slice(-items.length);
    els.forEach((el) => { if (!enrFresh(el.dataset.k)) enrIO.observe(el); });
  }

  const skeleton = (n = 8) => Array.from({ length: n }, () => '<div class="tile sk"><div class="poster"></div><div class="tile-meta"><div class="t"></div></div></div>').join('');

  /* ================= View-Infrastruktur ================= */
  let RT = 0; let observers = [];
  const alive = (tok) => tok === RT;
  const track = (io) => { observers.push(io); return io; };

  function errorHTML(e) {
    const needKey = e && e.status === 401;
    return `<div class="card"><h2>Das hat nicht geklappt</h2><p>${esc(e && e.message ? e.message : String(e))}</p>
      ${needKey ? '<button class="btn primary" data-go="einstellungen">Zu den Einstellungen</button>' : '<button class="btn" data-retry>Erneut versuchen</button>'}</div>`;
  }

  async function runFeed(container, feed, tok, o = {}) {
    const list = S.view === 'list';
    container.innerHTML = `<div class="${list ? 'list' : 'grid'}">${list ? '' : skeleton(12)}</div><div class="more-wrap">${list ? '<div class="spinner"></div>' : ''}</div>`;
    const box = container.firstElementChild; const more = container.lastElementChild;
    let loading = false; let first = true;
    async function load() {
      if (loading || feed.done || !alive(tok)) return;
      loading = true;
      if (!first) more.innerHTML = '<div class="spinner"></div>';
      try {
        const items = await feed.next(o.want || 18, o.maxPages || 5);
        if (!alive(tok)) return;
        if (first) { box.innerHTML = ''; first = false; }
        appendItems(box, items, o);
      } catch (e) {
        if (!alive(tok)) return;
        if (first) { box.innerHTML = ''; first = false; }
        more.innerHTML = `<div style="text-align:center"><p class="err">${esc(e.message)}</p><button class="btn small" data-more>Erneut versuchen</button></div>`;
        loading = false; return;
      }
      loading = false;
      if (feed.done) {
        more.innerHTML = box.children.length ? '' : `<div class="empty">${o.emptyText || 'Keine Titel gefunden. Filter anpassen?'}</div>`;
      } else {
        more.innerHTML = '<button class="btn small" data-more type="button">Mehr laden</button>';
        requestAnimationFrame(() => { if (alive(tok) && more.getBoundingClientRect().top < innerHeight + 500) load(); });
      }
    }
    more.addEventListener('click', (e) => { if (e.target.closest('[data-more]')) load(); });
    track(new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) load(); }, { rootMargin: '500px' })).observe(more);
    await load();
  }

  /* Abschnitt mit horizontaler Reihe, lädt erst bei Sichtbarkeit */
  function lazySection(parent, { head, load, tok, badge }) {
    const sec = document.createElement('section');
    sec.className = 'section';
    sec.innerHTML = `<div class="section-head">${head}</div>
      <div class="row-wrap"><button class="row-nav prev" type="button" aria-label="Zurückscrollen" hidden><svg><use href="#i-chev"/></svg></button><div class="row">${skeleton(8)}</div><button class="row-nav next" type="button" aria-label="Weiterscrollen"><svg><use href="#i-chev"/></svg></button></div>`;
    parent.appendChild(sec);
    const row = sec.querySelector('.row');
    wireRowNav(sec.querySelector('.row-wrap'));
    let started = false;
    const go = async () => {
      if (started) return; started = true;
      try {
        const items = await load();
        if (!alive(tok)) return;
        row.innerHTML = '';
        if (!items.length) { row.parentElement.outerHTML = '<div class="row-empty">Aktuell keine passenden Titel.</div>'; return; }
        appendItems(row, items, { row: true, badge });
        row.dispatchEvent(new Event('scroll'));
      } catch (e) {
        if (!alive(tok)) return;
        row.parentElement.outerHTML = `<div class="row-empty err">${esc(e.message)}</div>`;
      }
    };
    const io = track(new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); go(); } }, { rootMargin: '300px' }));
    io.observe(sec);
    return sec;
  }

  /* Pfeile links/rechts für Reihen (Maus/Trackpad), blenden sich am Anfang/Ende aus */
  function wireRowNav(wrap) {
    const row = wrap.querySelector('.row');
    const prev = wrap.querySelector('.prev'); const next = wrap.querySelector('.next');
    const upd = () => {
      prev.hidden = row.scrollLeft <= 4;
      next.hidden = row.scrollLeft + row.clientWidth >= row.scrollWidth - 4;
    };
    const step = (dir) => row.scrollBy({ left: dir * Math.max(200, row.clientWidth * 0.85), behavior: 'smooth' });
    prev.addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
    next.addEventListener('click', (e) => { e.stopPropagation(); step(1); });
    row.addEventListener('scroll', upd, { passive: true });
    track(new ResizeObserver(upd)).observe(row);
    upd();
  }

  function providerHead(p, sub, allAction) {
    return `${p.logo ? `<img class="plogo" src="${IMG}w92${p.logo}" alt="">` : ''}
      <div><h2>${esc(p.short)}</h2><div class="meta">${esc(sub)}</div></div>
      <div class="acts">
        <a class="link-btn" href="${jwUrl(p)}" target="_blank" rel="noopener" title="Neu bei ${esc(p.short)} auf JustWatch">JustWatch<svg><use href="#i-ext"/></svg></a>
        <button class="link-btn" type="button" data-allprov="${p.id}" data-allmode="${allAction}">Alle<svg><use href="#i-chev"/></svg></button>
      </div>`;
  }

  function statusChipsHTML() {
    if (!JF.ready) return '';
    const b = (v, l) => `<button class="chip" type="button" data-status="${v}" aria-pressed="${G.status === v}">${l}</button>`;
    return b('all', 'Alle') + b('missing', 'Fehlt auf Server') + b('have', 'Auf Server');
  }

  function jfNoteHTML() {
    if (JF.ready || store.get('hideJfNote')) return '';
    return `<div class="note"><span>Mit Jellyfin verbinden, um zu sehen, was schon auf dem Server ist.</span>
      <span class="inline"><button class="btn small primary" data-go="einstellungen" type="button">Verbinden</button><button class="btn small" data-hide-jfnote type="button">Später</button></span></div>`;
  }

  function onboardingHTML() {
    return `<div class="card" style="max-width:640px">
      <h2>Willkommen bei Streamradar</h2>
      <p>Hier siehst du, was bei deinen Streaming-Anbietern neu und beliebt ist und ob es schon auf eurem Jellyfin-Server liegt. Für den Start brauchst du einen kostenlosen TMDB-API-Key:</p>
      <ol class="steps">
        <li>Konto erstellen auf <a href="https://www.themoviedb.org/signup" target="_blank" rel="noopener">themoviedb.org</a></li>
        <li>Unter <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">Einstellungen → API</a> einen Key beantragen (Zweck: privat)</li>
        <li>Den «API-Lesezugriffs-Token» oder den «API-Schlüssel» in den Einstellungen einfügen</li>
      </ol>
      <button class="btn primary" data-go="einstellungen" type="button">Zu den Einstellungen</button>
    </div>`;
  }

  function noProvidersHTML() {
    return '<div class="card"><h2>Keine Anbieter ausgewählt</h2><p>Wähle in den Einstellungen die Streaming-Anbieter, die angezeigt werden sollen.</p><button class="btn primary" data-go="einstellungen" type="button">Anbieter wählen</button></div>';
  }

  /* ================= Views ================= */
  const VIEWS = {};

  /* ---- Start ---- */
  VIEWS.start = async (el, tok) => {
    if (!S.tmdbKey) { el.innerHTML = onboardingHTML(); return; }
    el.innerHTML = '<div class="spinner"></div>';
    await ensureMeta();
    if (!alive(tok)) return;
    const provs = myProviders();
    if (!provs.length) { el.innerHTML = noProvidersHTML(); return; }
    el.innerHTML = `<div class="view-head"><h1>Neu &amp; beliebt</h1></div>
      ${jfNoteHTML()}
      ${JF.ready ? `<div class="chips">${statusChipsHTML()}</div>` : ''}
      <div id="rows"></div>`;
    const rows = $('#rows', el);
    const mine = new Set(myIds());

    lazySection(rows, {
      tok,
      head: `<div><h2>Im Trend diese Woche</h2><div class="meta">bei deinen Anbietern</div></div>
        <div class="acts"><button class="link-btn" data-go="trends" type="button">Alle<svg><use href="#i-chev"/></svg></button></div>`,
      load: () => makeFeed(
        async (page) => { const r = await tmdb('/trending/all/week', { language: LANG, page }); return { items: (r.results || []).filter((x) => x.media_type === 'movie' || x.media_type === 'tv').map((x) => norm(x)), done: page >= Math.min(r.total_pages || 1, 5) }; },
        async (it) => statusOk(it) && (await enrich(it.type, it.id))[1].some((id) => mine.has(id)),
      ).next(20, 3),
    });

    for (const p of provs) {
      lazySection(rows, {
        tok,
        head: providerHead(p, 'Neu & beliebt', 'new'),
        load: () => makeFeed(discoverSource('all', { sort: 'popularity', sinceMovie: 120, sinceTv: 30 }, [p.id]), statusOk).next(20, 3),
      });
    }
  };

  /* ---- Entdecken ---- */
  const SORTS = [['popularity', 'Beliebt'], ['newest', 'Neueste'], ['rating', 'Bewertung'], ['provider', 'Nach Anbieter']];
  const SINCE = [[0, 'Alle'], [30, '30 Tage'], [90, '3 Monate'], [365, '12 Monate']];
  const RATINGS = [[0, 'Egal'], [6, '6+'], [7, '7+'], [8, '8+']];
  const filterCount = () => (F.since ? 1 : 0) + (F.genres.length ? 1 : 0) + (F.minRating ? 1 : 0) + (JF.ready && G.status !== 'all' ? 1 : 0);

  VIEWS.entdecken = async (el, tok) => {
    if (!S.tmdbKey) { el.innerHTML = onboardingHTML(); return; }
    el.innerHTML = '<div class="spinner"></div>';
    await ensureMeta();
    if (!alive(tok)) return;
    const provs = myProviders();
    if (!provs.length) { el.innerHTML = noProvidersHTML(); return; }
    F.providers = F.providers.filter((id) => myIds().includes(id));
    const sel = new Set(F.providers);
    const fc = filterCount();
    el.innerHTML = `<div class="view-head"><h1>Entdecken</h1><span class="spacer"></span>
        <button class="chip" type="button" id="fbtn" aria-pressed="${fc > 0}"><svg style="width:16px;height:16px"><use href="#i-filter"/></svg>Filter${fc ? `<span class="count">${fc}</span>` : ''}</button>
        <div class="seg" role="group" aria-label="Ansicht">
          <button type="button" data-viewmode="grid" aria-pressed="${S.view !== 'list'}" title="Raster"><svg style="width:16px;height:16px"><use href="#i-grid"/></svg></button>
          <button type="button" data-viewmode="list" aria-pressed="${S.view === 'list'}" title="Liste"><svg style="width:16px;height:16px"><use href="#i-list"/></svg></button>
        </div></div>
      <div class="chips" id="pchips">
        <button class="chip" type="button" data-prov="" aria-pressed="${!sel.size}">Alle Anbieter</button>
        ${provs.map((p) => `<button class="chip has-logo" type="button" data-prov="${p.id}" aria-pressed="${sel.has(p.id)}">${p.logo ? `<img src="${IMG}w45${p.logo}" alt="">` : ''}${esc(p.short)}</button>`).join('')}
      </div>
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Typ">
          ${[['all', 'Alle'], ['movie', 'Filme'], ['tv', 'Serien']].map(([v, l]) => `<button type="button" data-ftype="${v}" aria-pressed="${F.type === v}">${l}</button>`).join('')}
        </div>
        <select class="select" id="fsort" aria-label="Sortierung">${SORTS.map(([v, l]) => `<option value="${v}" ${F.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div id="feed"></div>`;
    const feedEl = $('#feed', el);
    const provIds = F.providers.length ? F.providers.slice().sort((a, b) => prio(a) - prio(b)) : myIds();
    const f = { sort: F.sort === 'provider' ? 'popularity' : F.sort, since: F.since, genres: F.genres, minRating: F.minRating };

    if (F.sort === 'provider') {
      for (const id of provIds) {
        const p = PMAP.get(id);
        lazySection(feedEl, {
          tok,
          head: providerHead(p, F.since ? `Beliebt · letzte ${SINCE.find((s) => s[0] === F.since)[1]}` : 'Beliebt', 'keep'),
          load: () => makeFeed(discoverSource(F.type, f, [id]), statusOk).next(20, 3),
        });
      }
      return;
    }
    await runFeed(feedEl, makeFeed(discoverSource(F.type, f, provIds), statusOk), tok);
  };

  function openFilters() {
    const draft = { since: F.since, genres: F.genres.slice(), minRating: F.minRating, status: G.status };
    const render = () => {
      $('.sheet-body').innerHTML = `<div class="f-body"><h2>Filter</h2>
        <div class="f-group"><span class="lbl">Zeitraum</span><div class="chips">${SINCE.map(([v, l]) => `<button class="chip" type="button" data-d-since="${v}" aria-pressed="${draft.since === v}">${l}</button>`).join('')}</div>
          <p class="kv" style="margin:6px 0 0">Filme: Erscheinungsdatum · Serien: neue Episoden im Zeitraum</p></div>
        <div class="f-group"><span class="lbl">Mindestbewertung</span><div class="chips">${RATINGS.map(([v, l]) => `<button class="chip" type="button" data-d-rating="${v}" aria-pressed="${draft.minRating === v}">${l}</button>`).join('')}</div></div>
        <div class="f-group"><span class="lbl">Server-Status</span><div class="chips">${[['all', 'Alle'], ['missing', 'Fehlt auf Server'], ['have', 'Auf Server']].map(([v, l]) => `<button class="chip" type="button" data-d-status="${v}" aria-pressed="${draft.status === v}" ${JF.ready ? '' : 'disabled'}>${l}</button>`).join('')}</div>
          ${JF.ready ? '' : '<p class="kv" style="margin:6px 0 0">Verfügbar, sobald Jellyfin verbunden ist.</p>'}</div>
        <div class="f-group"><span class="lbl">Genres</span><div class="chips">${GENRES.map((g) => `<button class="chip" type="button" data-d-genre="${g.key}" aria-pressed="${draft.genres.includes(g.key)}">${esc(g.name)}</button>`).join('')}</div></div>
        <div class="f-actions"><button class="btn" type="button" data-d-reset>Zurücksetzen</button><button class="btn primary" type="button" data-d-apply>Anwenden</button></div>
      </div>`;
    };
    openSheet('');
    render();
    $('.sheet-body').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.dSince != null) draft.since = +b.dataset.dSince;
      else if (b.dataset.dRating != null) draft.minRating = +b.dataset.dRating;
      else if (b.dataset.dStatus != null) draft.status = b.dataset.dStatus;
      else if (b.dataset.dGenre != null) { const g = b.dataset.dGenre; draft.genres = draft.genres.includes(g) ? draft.genres.filter((x) => x !== g) : [...draft.genres, g]; }
      else if (b.hasAttribute('data-d-reset')) { Object.assign(draft, { since: 0, genres: [], minRating: 0, status: 'all' }); }
      else if (b.hasAttribute('data-d-apply')) {
        Object.assign(F, { since: draft.since, genres: draft.genres, minRating: draft.minRating }); G.status = draft.status;
        saveFilters(); saveUI(); closeSheet(); route(); return;
      } else return;
      render();
    };
  }

  /* ---- Trends ---- */
  VIEWS.trends = async (el, tok) => {
    if (!S.tmdbKey) { el.innerHTML = onboardingHTML(); return; }
    el.innerHTML = '<div class="spinner"></div>';
    await ensureMeta();
    if (!alive(tok)) return;
    el.innerHTML = `<div class="view-head"><h1>Im Trend</h1></div>
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Zeitraum">${[['day', 'Heute'], ['week', 'Woche']].map(([v, l]) => `<button type="button" data-twin="${v}" aria-pressed="${G.trendWin === v}">${l}</button>`).join('')}</div>
        <div class="seg" role="group" aria-label="Typ">${[['all', 'Alle'], ['movie', 'Filme'], ['tv', 'Serien']].map(([v, l]) => `<button type="button" data-ttype="${v}" aria-pressed="${G.trendType === v}">${l}</button>`).join('')}</div>
        <button class="chip" type="button" data-tmine aria-pressed="${G.trendMine}">Nur meine Anbieter</button>
      </div>
      ${JF.ready ? `<div class="chips">${statusChipsHTML()}</div>` : ''}
      <div id="feed"></div>`;
    const mine = new Set(myIds());
    const source = async (page) => {
      const r = await tmdb(`/trending/${G.trendType}/${G.trendWin}`, { language: LANG, page });
      return { items: (r.results || []).filter((x) => G.trendType !== 'all' || x.media_type === 'movie' || x.media_type === 'tv').map((x) => norm(x, G.trendType === 'all' ? null : G.trendType)), done: page >= Math.min(r.total_pages || 1, 15) };
    };
    const accept = async (it) => statusOk(it) && (!G.trendMine || (await enrich(it.type, it.id))[1].some((id) => mine.has(id)));
    await runFeed($('#feed', el), makeFeed(source, accept), tok, { emptyText: 'Keine Trend-Titel bei deinen Anbietern gefunden.' });
  };

  /* ---- Demnächst ---- */
  VIEWS.demnaechst = async (el, tok) => {
    if (!S.tmdbKey) { el.innerHTML = onboardingHTML(); return; }
    el.innerHTML = '<div class="spinner"></div>';
    await ensureMeta();
    if (!alive(tok)) return;
    el.innerHTML = `<div class="view-head"><h1>Demnächst</h1></div>
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Bereich">${[['tv', 'Neue Episoden'], ['movie', 'Kinostarts']].map(([v, l]) => `<button type="button" data-upmode="${v}" aria-pressed="${G.upMode === v}">${l}</button>`).join('')}</div>
      </div>
      <p class="kv" style="margin:-4px 0 12px">${G.upMode === 'tv' ? 'Serien bei deinen Anbietern mit Episoden in den nächsten 6 Wochen' : `Kinostarts in ${esc(regionName(S.region))} – kommen später zu den Streaming-Anbietern`}</p>
      ${JF.ready ? `<div class="chips">${statusChipsHTML()}</div>` : ''}
      <div id="feed"></div>`;
    const feedEl = $('#feed', el);
    if (G.upMode === 'tv') {
      const ids = myIds();
      if (!ids.length) { feedEl.innerHTML = noProvidersHTML(); return; }
      const source = async (page) => {
        const r = await tmdb('/discover/tv', {
          watch_region: S.region, with_watch_providers: ids.join('|'), with_watch_monetization_types: 'flatrate|free|ads', language: LANG,
          'air_date.gte': isoDate(0), 'air_date.lte': isoDate(42), sort_by: 'popularity.desc', page,
        });
        return { items: (r.results || []).map((x) => norm(x, 'tv')), done: page >= Math.min(r.total_pages || 1, 20) };
      };
      await runFeed(feedEl, makeFeed(source, statusOk), tok, { badge: 'nextep' });
    } else {
      const today = isoDate(0);
      const source = async (page) => {
        const r = await tmdb('/movie/upcoming', { region: S.region, language: LANG, page });
        const items = (r.results || []).map((x) => norm(x, 'movie')).filter((x) => x.date >= today).sort((a, b) => a.date.localeCompare(b.date));
        return { items, done: page >= Math.min(r.total_pages || 1, 10) };
      };
      await runFeed(feedEl, makeFeed(source, statusOk), tok, { badge: 'date', emptyText: 'Keine Kinostarts gefunden.' });
    }
  };

  /* ---- Suche ---- */
  VIEWS.suche = async (el, tok) => {
    if (!S.tmdbKey) { el.innerHTML = onboardingHTML(); return; }
    el.innerHTML = `<div class="view-head"><h1>Suche</h1></div>
      <div class="searchbox"><svg><use href="#i-search"/></svg><input id="q" type="search" placeholder="Film oder Serie suchen …" autocomplete="off" enterkeyhint="search" value="${esc(G.query)}"></div>
      <div id="feed"></div>`;
    ensureMeta().catch(() => {});
    const input = $('#q', el); const feedEl = $('#feed', el);
    const run = () => {
      const q = input.value.trim(); G.query = q;
      if (q.length < 2) { feedEl.innerHTML = '<div class="empty">Mindestens zwei Zeichen eingeben.</div>'; return; }
      const source = async (page) => {
        const r = await tmdb('/search/multi', { query: q, language: LANG, include_adult: false, page }, { ttl: 600e3 });
        return { items: (r.results || []).filter((x) => x.media_type === 'movie' || x.media_type === 'tv').map((x) => norm(x)), done: page >= Math.min(r.total_pages || 1, 10) };
      };
      runFeed(feedEl, makeFeed(source), tok, { emptyText: 'Nichts gefunden.' }).catch(() => {});
    };
    input.addEventListener('input', debounce(run, 350));
    if (G.query) run(); else feedEl.innerHTML = '<div class="empty">Suche nach Titeln – auch solchen, die bei keinem deiner Anbieter laufen.</div>';
    if (matchMedia('(min-width: 900px)').matches) input.focus();
  };

  /* ---- Einstellungen ---- */
  const REGIONS = [['CH', 'Schweiz'], ['DE', 'Deutschland'], ['AT', 'Österreich'], ['US', 'USA'], ['GB', 'Grossbritannien'], ['FR', 'Frankreich'], ['IT', 'Italien']];
  const regionName = (r) => (REGIONS.find((x) => x[0] === r) || [r, r])[1];

  VIEWS.einstellungen = async (el, tok) => {
    const keyMask = S.tmdbKey ? S.tmdbKey.slice(0, 4) + '…' + S.tmdbKey.slice(-4) : '';
    el.innerHTML = `<div class="view-head"><h1>Einstellungen</h1></div>
    <div class="settings">
      <section class="card">
        <h2>TMDB-Zugang</h2>
        <p class="hint">Kostenloser Key von <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org → Einstellungen → API</a>. API-Schlüssel oder Lesezugriffs-Token funktionieren beide. Der Key bleibt nur in diesem Browser gespeichert.</p>
        <div class="field"><label for="s-key">API-Key / Token</label><input class="input" id="s-key" type="password" autocomplete="off" placeholder="${S.tmdbKey ? esc(keyMask) + ' (gespeichert)' : 'Key einfügen'}"></div>
        <div class="inline"><button class="btn primary" id="s-key-save" type="button">Prüfen &amp; speichern</button><span id="s-key-msg" class="kv"></span></div>
      </section>

      <section class="card">
        <h2>Region &amp; Anbieter</h2>
        <p class="hint">Bestimmt, welche Kataloge angezeigt werden. Die Reihenfolge folgt der Beliebtheit in der Region.</p>
        <div class="field"><label for="s-region">Region</label><select class="select" id="s-region" style="height:40px;width:max-content">${REGIONS.map(([v, l]) => `<option value="${v}" ${S.region === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div id="s-provs">${S.tmdbKey ? '<div class="spinner"></div>' : '<p class="kv">Zuerst TMDB-Key hinterlegen.</p>'}</div>
      </section>

      <section class="card" id="s-jf"></section>

      <section class="card">
        <h2>Jellyseerr / Overseerr</h2>
        <p class="hint">Adresse eurer Request-Seite. Der Button «Requesten» öffnet den Titel direkt dort.</p>
        <div class="field"><label for="s-seerr">Adresse</label><input class="input" id="s-seerr" type="text" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://requests.example.ch" value="${esc(S.seerrUrl)}"></div>
        <button class="btn" id="s-seerr-save" type="button">Speichern</button>
      </section>

      <section class="card">
        <h2>Darstellung</h2>
        <div class="f-group"><span class="lbl" style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Kachelgrösse</span>
          <div class="seg" style="margin-top:6px">${[['s', 'Klein'], ['m', 'Mittel'], ['l', 'Gross']].map(([v, l]) => `<button type="button" data-size="${v}" aria-pressed="${S.size === v}">${l}</button>`).join('')}</div></div>
        <div class="f-group"><span class="lbl" style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Design</span>
          <div class="seg" style="margin-top:6px">${[['system', 'System'], ['dark', 'Dunkel'], ['light', 'Hell']].map(([v, l]) => `<button type="button" data-theme="${v}" aria-pressed="${S.theme === v}">${l}</button>`).join('')}</div></div>
      </section>

      <section class="card">
        <h2>Daten</h2>
        <p class="hint">Zwischengespeicherte Katalogdaten löschen (Einstellungen und Logins bleiben erhalten).</p>
        <button class="btn" id="s-clear" type="button">Cache leeren</button>
        <p class="kv" style="margin:12px 0 0">Streamradar ${VERSION} · Daten: <a href="https://www.themoviedb.org" target="_blank" rel="noopener">TMDB</a>, Verfügbarkeit: JustWatch. Dieses Produkt nutzt die TMDB-API, ist aber nicht von TMDB unterstützt oder zertifiziert.</p>
      </section>
    </div>`;

    // TMDB-Key
    $('#s-key-save', el).onclick = async () => {
      const v = $('#s-key', el).value.trim();
      const msg = $('#s-key-msg', el);
      if (!v && !S.tmdbKey) { msg.textContent = 'Bitte Key einfügen.'; return; }
      const old = S.tmdbKey;
      if (v) S.tmdbKey = v;
      msg.textContent = 'Prüfe …';
      mem.clear();
      try {
        await tmdb('/configuration', {}, { ttl: 0 });
        saveSettings(); metaPromise = null;
        msg.innerHTML = '<span style="color:var(--ok)">✓ Key funktioniert</span>';
        renderProvs();
      } catch (e) {
        S.tmdbKey = old;
        msg.innerHTML = `<span class="err">${esc(e.message)}</span>`;
      }
    };

    // Region
    $('#s-region', el).onchange = (e) => {
      S.region = e.target.value; saveSettings(); metaPromise = null; mem.clear();
      for (const k of Object.keys(ENR)) delete ENR[k];
      store.set('enr', {});
      F.providers = []; saveFilters();
      renderProvs();
    };

    // Anbieter
    async function renderProvs() {
      const box = $('#s-provs', el);
      if (!S.tmdbKey) return;
      box.innerHTML = '<div class="spinner"></div>';
      try { await ensureMeta(); } catch (e) { if (alive(tok)) box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
      if (!alive(tok)) return;
      const sel = new Set(S.providers || []);
      const list = PROVIDERS.filter((p) => S.showAllProviders || isMain(p) || sel.has(p.id));
      box.innerHTML = `<div class="plist">${list.map((p) => `<label class="pitem ${sel.has(p.id) ? 'on' : ''}">${p.logo ? `<img src="${IMG}w92${p.logo}" alt="" loading="lazy">` : ''}<span>${esc(p.short)}</span><input type="checkbox" data-pid="${p.id}" ${sel.has(p.id) ? 'checked' : ''}></label>`).join('')}</div>
        <div class="inline" style="margin-top:10px">
          <button class="btn small" type="button" id="s-pdef">Standard</button>
          <button class="btn small" type="button" id="s-pall">${S.showAllProviders ? 'Weniger anzeigen' : `Alle ${PROVIDERS.length} anzeigen`}</button>
          <span class="kv">${sel.size} ausgewählt</span>
        </div>`;
      box.onchange = (e) => {
        const cb = e.target.closest('input[data-pid]'); if (!cb) return;
        const id = +cb.dataset.pid;
        const s = new Set(S.providers || []);
        cb.checked ? s.add(id) : s.delete(id);
        S.providers = [...s]; saveSettings();
        cb.closest('.pitem').classList.toggle('on', cb.checked);
        box.querySelector('.inline .kv').textContent = s.size + ' ausgewählt';
      };
      $('#s-pdef', box).onclick = () => { S.providers = defaultProviderIds(); saveSettings(); renderProvs(); };
      $('#s-pall', box).onclick = () => { S.showAllProviders = !S.showAllProviders; saveSettings(); renderProvs(); };
    }
    renderProvs();

    // Jellyfin
    function renderJf() {
      const box = $('#s-jf', el);
      if (JF.conn) {
        const l = JF.lib;
        box.innerHTML = `<h2>Jellyfin</h2>
          <div class="status-line"><span class="dot"></span><span>Verbunden als <b>${esc(JF.conn.userName)}</b></span></div>
          <p class="kv" style="margin:0 0 4px">${esc(JF.conn.url)}</p>
          <p class="kv" style="margin:0 0 12px">${l ? `${fmtNum(l.nm)} Filme · ${fmtNum(l.ns)} Serien eingelesen${l.noId ? ` · ${fmtNum(l.noId)} ohne TMDB-ID` : ''} · Stand ${new Date(l.ts).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' })}` : 'Bibliothek noch nicht eingelesen.'}</p>
          <div class="inline"><button class="btn" id="s-jf-sync" type="button"><svg><use href="#i-refresh"/></svg>Bibliothek aktualisieren</button><button class="btn" id="s-jf-out" type="button">Trennen</button><span id="s-jf-msg" class="kv"></span></div>`;
        $('#s-jf-sync', box).onclick = async (e) => {
          const b = e.currentTarget; b.disabled = true; $('#s-jf-msg', box).textContent = 'Lese Bibliothek …';
          try { await JF.sync(); renderJf(); toast('Bibliothek aktualisiert'); } catch (err) { $('#s-jf-msg', box).innerHTML = `<span class="err">${esc(err.message)}</span>`; b.disabled = false; }
        };
        $('#s-jf-out', box).onclick = () => { JF.disconnect(); renderJf(); };
      } else {
        box.innerHTML = `<h2>Jellyfin</h2>
          <p class="hint">Mit deinem normalen Jellyfin-Konto anmelden. Gespeichert wird nur ein Zugriffs-Token, nicht dein Passwort.</p>
          <form id="s-jf-form">
            <div class="field"><label for="jf-url">Server-Adresse</label><input class="input" id="jf-url" type="text" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://jellyfin.example.ch" required value="${esc(store.get('jfUrlHint', ''))}"></div>
            <div class="field"><label for="jf-user">Benutzername</label><input class="input" id="jf-user" autocomplete="username" autocapitalize="off" required></div>
            <div class="field"><label for="jf-pw">Passwort</label><input class="input" id="jf-pw" type="password" autocomplete="current-password"></div>
            <div class="inline"><button class="btn primary" type="submit">Verbinden</button><span id="s-jf-msg" class="kv"></span></div>
          </form>`;
        $('#s-jf-form', box).onsubmit = async (e) => {
          e.preventDefault();
          const url = $('#jf-url', box).value; const msg = $('#s-jf-msg', box); const btn = e.submitter || $('button[type=submit]', box);
          store.set('jfUrlHint', normUrl(url));
          btn.disabled = true; msg.textContent = 'Verbinde …';
          try {
            await JF.connect(url, $('#jf-user', box).value.trim(), $('#jf-pw', box).value);
            toast(`Verbunden · ${fmtNum(JF.lib.nm)} Filme, ${fmtNum(JF.lib.ns)} Serien`);
            renderJf();
          } catch (err) { msg.innerHTML = `<span class="err">${esc(err.message)}</span>`; btn.disabled = false; }
        };
      }
    }
    renderJf();

    $('#s-seerr-save', el).onclick = () => { S.seerrUrl = normUrl($('#s-seerr', el).value); $('#s-seerr', el).value = S.seerrUrl; saveSettings(); toast('Gespeichert'); };
    el.querySelectorAll('[data-size]').forEach((b) => { b.onclick = () => { S.size = b.dataset.size; saveSettings(); applyLook(); el.querySelectorAll('[data-size]').forEach((x) => x.setAttribute('aria-pressed', x === b)); }; });
    el.querySelectorAll('[data-theme]').forEach((b) => { b.onclick = () => { S.theme = b.dataset.theme; saveSettings(); applyLook(); el.querySelectorAll('[data-theme]').forEach((x) => x.setAttribute('aria-pressed', x === b)); }; });
    $('#s-clear', el).onclick = () => {
      mem.clear(); for (const k of Object.keys(ENR)) delete ENR[k];
      store.set('enr', {}); store.del('genres'); REGIONS.forEach(([r]) => store.del('prov.' + r)); metaPromise = null;
      if ('caches' in window) caches.keys().then((ks) => ks.filter((k) => k.startsWith('sr-img')).forEach((k) => caches.delete(k)));
      toast('Cache geleert');
    };
  };

  /* ================= Detailansicht ================= */
  const TV_STATUS = { 'Returning Series': 'Laufend', Ended: 'Beendet', Canceled: 'Abgesetzt', 'In Production': 'In Produktion', Planned: 'Geplant', Pilot: 'Pilot' };

  async function openDetail(type, id) {
    openSheet('<div class="spinner" style="margin:90px auto"></div>');
    const my = ++openDetail.n;
    let d;
    try {
      d = await tmdb(`/${type}/${id}`, { language: LANG, append_to_response: 'videos,watch/providers,credits', include_video_language: 'de,en,null' }, { ttl: 3600e3 });
    } catch (e) {
      if (my === openDetail.n) $('.sheet-body').innerHTML = `<div class="f-body">${errorHTML(e)}</div>`;
      return;
    }
    if (my !== openDetail.n || $('#sheet').hidden) return;
    let overview = d.overview;
    if (!overview) { try { overview = (await tmdb(`/${type}/${id}`, { language: 'en-US' })).overview; } catch { /* egal */ } }
    if (my !== openDetail.n) return;

    const wp = (d['watch/providers'] && d['watch/providers'].results && d['watch/providers'].results[S.region]) || {};
    const pids = provListFrom(wp);
    const k = type + ':' + id;
    ENR[k] = [Date.now(), pids, d.next_episode_to_air ? d.next_episode_to_air.air_date : null, d.next_episode_to_air ? `S${d.next_episode_to_air.season_number} E${d.next_episode_to_air.episode_number}` : null];
    saveEnr(); paintEnr(k, ENR[k]);

    const title = d.title || d.name;
    const orig = d.original_title || d.original_name;
    const date = d.release_date || d.first_air_date || '';
    const vids = (d.videos && d.videos.results) || [];
    const trailer = vids.filter((v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
      .sort((a, b) => (a.iso_639_1 === 'de' ? 0 : 1) - (b.iso_639_1 === 'de' ? 0 : 1) || (a.type === 'Trailer' ? 0 : 1) - (b.type === 'Trailer' ? 0 : 1))[0];
    const mine = new Set(S.providers || []);
    const meta = [];
    meta.push(`<span class="tag ${type}">${type === 'movie' ? 'Film' : 'Serie'}</span>`);
    if (year(date)) meta.push(`<span>${year(date)}</span>`);
    if (type === 'movie' && d.runtime) meta.push(`<span>${d.runtime >= 60 ? Math.floor(d.runtime / 60) + ' h ' : ''}${d.runtime % 60 ? (d.runtime % 60) + ' min' : ''}</span>`);
    if (type === 'tv' && d.number_of_seasons) meta.push(`<span>${d.number_of_seasons} Staffel${d.number_of_seasons > 1 ? 'n' : ''}</span>`);
    if (type === 'tv' && TV_STATUS[d.status]) meta.push(`<span>${TV_STATUS[d.status]}</span>`);
    if (d.vote_count >= 5) meta.push(`<span class="rating"><svg><use href="#i-star"/></svg>${d.vote_average.toFixed(1)} <span class="kv">(${fmtNum(d.vote_count)})</span></span>`);

    const have = JF.has(type, id);
    const jfLink = JF.itemUrl(type, id);
    const seerr = S.seerrUrl ? `${S.seerrUrl}/${type}/${id}` : null;
    let status = '';
    if (JF.ready) {
      status = have
        ? '<div class="d-status yes"><svg><use href="#i-check"/></svg>Auf dem Server vorhanden</div>'
        : '<div class="d-status no">Noch nicht auf dem Server</div>';
    }
    const actions = [];
    if (have && jfLink) {
      actions.push(`<a class="btn ok" href="${jfLink}" target="_blank" rel="noopener"><svg><use href="#i-play"/></svg>In Jellyfin öffnen</a>`);
      actions.push('<button class="btn fav" type="button" id="d-fav" disabled><svg><use href="#i-heart"/></svg><span>Favorit</span></button>');
    }
    if (!have) actions.push(seerr ? `<a class="btn primary" href="${seerr}" target="_blank" rel="noopener"><svg><use href="#i-plus"/></svg>Requesten</a>` : '<button class="btn" type="button" data-go="einstellungen">Seerr-Adresse hinterlegen</button>');
    if (trailer) actions.push(`<a class="btn" href="https://www.youtube.com/watch?v=${encodeURIComponent(trailer.key)}" target="_blank" rel="noopener"><svg><use href="#i-play"/></svg>Trailer</a>`);

    const provHTML = pids.length
      ? `<div class="provs">${[...pids].sort((a, b) => (mine.has(b) - mine.has(a)) || (prio(a) - prio(b))).map((pid) => { const p = PMAP.get(pid); return p ? `<span class="prov ${mine.has(pid) ? 'mine' : ''}">${p.logo ? `<img src="${IMG}w92${p.logo}" alt="">` : ''}${esc(p.short)}</span>` : ''; }).join('')}</div>`
      : `<p>Aktuell bei keinem Abo-Anbieter in ${esc(regionName(S.region))}${(wp.rent || wp.buy) ? ' (nur Kauf/Miete)' : ''}.</p>`;

    const crew = type === 'movie'
      ? ((d.credits && d.credits.crew) || []).filter((c) => c.job === 'Director').map((c) => c.name)
      : (d.created_by || []).map((c) => c.name);
    const cast = ((d.credits && d.credits.cast) || []).slice(0, 8).map((c) => c.name);
    const ne = d.next_episode_to_air;

    $('.sheet-body').innerHTML = `
      <div class="d-hero">${d.backdrop_path ? `<img src="${IMG}w780${d.backdrop_path}" alt="">` : ''}</div>
      <div class="d-head">
        <div class="poster">${d.poster_path ? `<img src="${IMG}w185${d.poster_path}" alt="">` : `<div class="noimg">${esc(d.title || d.name)}</div>`}</div>
        <div class="d-title"><h2>${esc(title)}</h2>${orig && orig !== title ? `<div class="orig">${esc(orig)}</div>` : ''}<div class="d-meta">${meta.join('')}</div></div>
      </div>
      ${status}
      <div class="d-actions">${actions.join('')}</div>
      ${ne ? `<div class="d-sec"><h3>Nächste Episode</h3><p>S${ne.season_number} E${ne.episode_number}${ne.name ? ' · ' + esc(ne.name) : ''} – ${fmtLong(ne.air_date)}</p></div>` : ''}
      <div class="d-sec"><h3>Streambar in ${esc(regionName(S.region))}</h3>${provHTML}</div>
      ${overview ? `<div class="d-sec"><h3>Handlung</h3><p>${esc(overview)}</p></div>` : ''}
      ${d.genres && d.genres.length ? `<div class="d-sec"><div class="genres">${d.genres.map((g) => `<span>${esc(g.name)}</span>`).join('')}</div></div>` : ''}
      ${crew.length ? `<div class="d-sec"><h3>${type === 'movie' ? 'Regie' : 'Idee'}</h3><p>${esc(crew.join(', '))}</p></div>` : ''}
      ${cast.length ? `<div class="d-sec"><h3>Besetzung</h3><p>${esc(cast.join(', '))}</p></div>` : ''}
      <div class="d-foot">
        <a class="link-btn" href="https://www.themoviedb.org/${type}/${id}" target="_blank" rel="noopener">TMDB<svg><use href="#i-ext"/></svg></a>
        ${wp.link ? `<a class="link-btn" href="${esc(wp.link)}" target="_blank" rel="noopener">Alle Angebote<svg><use href="#i-ext"/></svg></a>` : ''}
        ${d.imdb_id ? `<a class="link-btn" href="https://www.imdb.com/title/${esc(d.imdb_id)}/" target="_blank" rel="noopener">IMDb<svg><use href="#i-ext"/></svg></a>` : ''}
      </div>`;
    if (have && JF.conn) wireFavorite(type, id, my);
  }
  openDetail.n = 0;

  async function wireFavorite(type, id, my) {
    const b = $('#d-fav'); if (!b) return;
    const paint = (on) => {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
      b.querySelector('use').setAttribute('href', on ? '#i-heart-fill' : '#i-heart');
      b.querySelector('span').textContent = on ? 'Favorit' : 'Zu Favoriten';
      b.title = on ? 'Aus Jellyfin-Favoriten entfernen' : 'Zu Jellyfin-Favoriten hinzufügen';
    };
    let on = false;
    try { on = await JF.isFavorite(type, id); } catch { /* Status unbekannt: als «nicht Favorit» anzeigen */ }
    if (my !== openDetail.n) return;
    paint(on); b.disabled = false;
    b.onclick = async () => {
      b.disabled = true;
      try { await JF.setFavorite(type, id, !on); on = !on; paint(on); toast(on ? 'Zu Jellyfin-Favoriten hinzugefügt' : 'Aus Favoriten entfernt'); } catch (e) { toast(e.message, 4000); }
      b.disabled = false;
    };
  }

  /* ================= Sheet ================= */
  function openSheet(html) {
    const sh = $('#sheet');
    $('.sheet-body').onclick = null;
    $('.sheet-body').innerHTML = html;
    $('.sheet-panel').scrollTop = 0;
    if (sh.hidden) {
      sh.hidden = false;
      document.body.style.overflow = 'hidden';
      history.pushState({ sheet: true }, '');
    }
  }
  let pendingNav = null;
  function closeSheet(fromPop = false) {
    const sh = $('#sheet');
    if (sh.hidden) return false;
    sh.hidden = true;
    document.body.style.overflow = '';
    openDetail.n++;
    if (!fromPop && history.state && history.state.sheet) { history.back(); return true; }
    return false;
  }

  /* ================= Router & Navigation ================= */
  const TABS = [['start', 'Start', 'i-home'], ['entdecken', 'Entdecken', 'i-grid'], ['trends', 'Trends', 'i-trend'], ['demnaechst', 'Demnächst', 'i-cal'], ['suche', 'Suche', 'i-search']];
  function renderTabs() {
    const html = TABS.map(([id, l, ic]) => `<button class="tab" type="button" data-go="${id}"><svg><use href="#${ic}"/></svg><span>${l}</span></button>`).join('');
    $('.tabs-top').innerHTML = html; $('.tabs-bottom').innerHTML = html;
  }
  let current = null;
  function route() {
    const id = (location.hash.slice(1) || 'start').split('?')[0];
    const v = VIEWS[id] ? id : 'start';
    const tok = ++RT;
    observers.forEach((o) => o.disconnect()); observers = [];
    $$('.tab').forEach((t) => (t.dataset.go === v ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
    const el = $('#view');
    if (current !== v) window.scrollTo(0, 0);
    current = v;
    el.innerHTML = '';
    VIEWS[v](el, tok).catch((e) => { if (alive(tok)) el.innerHTML = errorHTML(e); });
  }
  const go = (id) => { if (location.hash.slice(1) === id) route(); else location.hash = id; };

  document.addEventListener('click', (e) => {
    const t = e.target;
    const c = t.closest('[data-close]'); if (c) { closeSheet(); return; }
    const g = t.closest('[data-go]'); if (g) { e.preventDefault(); if (closeSheet()) pendingNav = g.dataset.go; else go(g.dataset.go); return; }
    const tile = t.closest('[data-k]'); if (tile && (tile.classList.contains('tile') || tile.classList.contains('lrow'))) { const [type, id] = tile.dataset.k.split(':'); openDetail(type, +id); return; }
    if (t.closest('[data-retry]')) { metaPromise = null; route(); return; }
    if (t.closest('[data-hide-jfnote]')) { store.set('hideJfNote', true); t.closest('.note').remove(); return; }
    const st = t.closest('[data-status]'); if (st) { G.status = st.dataset.status; saveUI(); route(); return; }
    const ap = t.closest('[data-allprov]');
    if (ap) {
      F.providers = [+ap.dataset.allprov];
      if (ap.dataset.allmode === 'new') { F.sort = 'popularity'; F.since = 90; } else if (F.sort === 'provider') F.sort = 'popularity';
      saveFilters(); go('entdecken'); return;
    }
    // Entdecken
    const pc = t.closest('[data-prov]');
    if (pc) {
      const id = pc.dataset.prov;
      if (!id) F.providers = [];
      else { const n = +id; F.providers = F.providers.includes(n) ? F.providers.filter((x) => x !== n) : [...F.providers, n]; }
      saveFilters(); route(); return;
    }
    const ft = t.closest('[data-ftype]'); if (ft) { F.type = ft.dataset.ftype; saveFilters(); route(); return; }
    const vm = t.closest('[data-viewmode]'); if (vm) { S.view = vm.dataset.viewmode; saveSettings(); route(); return; }
    if (t.closest('#fbtn')) { openFilters(); return; }
    // Trends
    const tw = t.closest('[data-twin]'); if (tw) { G.trendWin = tw.dataset.twin; saveUI(); route(); return; }
    const tt = t.closest('[data-ttype]'); if (tt) { G.trendType = tt.dataset.ttype; saveUI(); route(); return; }
    if (t.closest('[data-tmine]')) { G.trendMine = !G.trendMine; saveUI(); route(); return; }
    // Demnächst
    const um = t.closest('[data-upmode]'); if (um) { G.upMode = um.dataset.upmode; saveUI(); route(); }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'fsort') { F.sort = e.target.value; saveFilters(); route(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  window.addEventListener('popstate', () => {
    if (pendingNav) { const id = pendingNav; pendingNav = null; go(id); return; }
    if (!$('#sheet').hidden) closeSheet(true);
  });
  window.addEventListener('hashchange', route);
  $('#jf-status').addEventListener('click', () => go('einstellungen'));

  function applyLook() {
    const r = document.documentElement;
    if (S.theme === 'system') r.removeAttribute('data-theme'); else r.dataset.theme = S.theme;
    if (S.size === 'm') r.removeAttribute('data-size'); else r.dataset.size = S.size;
    requestAnimationFrame(() => { const bg = getComputedStyle(document.body).backgroundColor; $('meta[name=theme-color]').setAttribute('content', bg); });
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyLook);

  /* ================= Start ================= */
  applyLook();
  renderTabs();
  updateJfDot();
  route();
  // Bibliothek im Hintergrund auffrischen, wenn älter als 6 Stunden
  if (JF.conn && (!JF.lib || Date.now() - JF.lib.ts > 6 * 3600e3)) {
    JF.sync().then(() => { if (['start', 'entdecken', 'trends', 'demnaechst'].includes(current)) route(); }).catch((e) => toast(e.message, 4500));
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
