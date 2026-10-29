'use strict';
/* 紫ビューア (web / iPad) — same features as the Android app where the web allows it. */

const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const PARENT = location.hostname || 'localhost';
const VIDEO_CHANNEL = 'kato_junichi0817';       // only this channel gets a moving preview on the home screen
const SUB_CHANNEL = 'kato_junichi0817';         // subscribe button shown only here
const DEFAULT_CHANNELS = ['kato_junichi0817', 'yaritaiji', 'indegnasen0706', 'batora324', 'sumomoxqx', 'stylishnoob4', 'yuyuta0702'];
const $ = (s, el = document) => el.querySelector(s);

/* ---------- storage ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const prefs = new Proxy({}, {
  get: (_, k) => store.get('p_' + k, ({
    channels: DEFAULT_CHANNELS, fontP: 14, fontL: 13, delay: 0, chatWidth: 32, overlayAlpha: 45,
    landscapeMode: 0, ngWords: [], ngExact: [], ngUsers: [], ngPlayers: [], ngPlayersOn: true, ngPlayersVer: 0,
    names: {}, vodPos: {},
  })[k]),
  set: (_, k, v) => { store.set('p_' + k, v); return true; },
});

/* ---------- shared NG player list (same file the Android app uses) ---------- */
async function syncPlayers() {
  try {
    const r = await fetch('players.json', { cache: 'no-cache' });
    const j = await r.json();
    if (j.version > prefs.ngPlayersVer) {
      prefs.ngPlayers = [...new Set([...prefs.ngPlayers, ...j.players])];
      prefs.ngPlayersVer = j.version;
    }
  } catch {}
}

/* ---------- Twitch queries ---------- */
async function gql(query, variables) {
  const r = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST', headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  return j.data;
}
async function persisted(op, hash, variables) {
  const r = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST', headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ operationName: op, variables, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }]),
  });
  const j = await r.json();
  return (j[0] || {}).data;
}

async function channelInfo(logins) {
  const q = 'query($l:[String!]){users(logins:$l){login displayName stream{title viewersCount}}}';
  const d = await gql(q, { l: logins });
  return (d && d.users) || [];
}

async function searchChannels(text) {
  const pick = n => n && n.login ? { login: n.login, name: n.displayName || n.login,
    followers: (n.followers && n.followers.totalCount) || 0, live: !!n.stream } : null;
  let out = [];
  try {
    const d = await gql('query($q:String!){searchFor(userQuery:$q,platform:"web",options:{targets:[{index:CHANNEL}]}){channels{items{login displayName followers{totalCount} stream{id}}}}}', { q: text });
    out = ((d && d.searchFor && d.searchFor.channels && d.searchFor.channels.items) || []).map(pick).filter(Boolean);
  } catch {}
  if (!out.length) {
    try {
      const d = await gql('query($q:String!){searchUsers(userQuery:$q,first:20){edges{node{login displayName followers{totalCount} stream{id}}}}}', { q: text });
      out = ((d && d.searchUsers && d.searchUsers.edges) || []).map(e => pick(e.node)).filter(Boolean);
    } catch { return null; }
  }
  const seen = new Set();
  return out.filter(r => !seen.has(r.login) && seen.add(r.login)).sort((a, b) => b.followers - a.followers);
}

async function archives(login) {
  const d = await gql('query($l:String!){user(login:$l){videos(first:30,type:ARCHIVE,sort:TIME){edges{node{id title lengthSeconds publishedAt viewCount previewThumbnailURL(width:640,height:360)}}}}}', { l: login });
  return ((d && d.user && d.user.videos && d.user.videos.edges) || []).map(e => e.node);
}

/** archive chat by time; the "continue" cursor is refused by Twitch, so we always ask by seconds */
async function vodComments(id, offset) {
  const d = await persisted('VideoCommentsByOffsetOrCursor', 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a',
    { videoID: id, contentOffsetSeconds: offset });
  const c = d && d.video && d.video.comments;
  if (!c) throw new Error('comments');
  const list = (c.edges || []).map(e => {
    const n = e.node, who = n.commenter || {};
    let text = '', emotes = [];
    for (const f of (n.message && n.message.fragments) || []) {
      if (f.emote && f.emote.emoteID) emotes.push({ s: text.length, e: text.length + f.text.length, id: f.emote.emoteID });
      text += f.text;
    }
    return { at: n.contentOffsetSeconds, id: n.id, login: who.login || '', name: who.displayName || who.login || '',
      color: n.message && n.message.userColor, text, emotes };
  });
  const more = c.pageInfo && c.pageInfo.hasNextPage;
  return { list, next: more && list.length ? list[list.length - 1].at + 1 : null };
}

/* ---------- NG filter ---------- */
function norm(s) {
  return (s || '').normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
function makeFilter() {
  const words = [...prefs.ngWords, ...(prefs.ngPlayersOn ? prefs.ngPlayers : [])].map(norm).filter(Boolean);
  const exact = new Set(prefs.ngExact.map(w => norm(w).trim()).filter(Boolean));
  const users = new Set(prefs.ngUsers.map(u => u.toLowerCase()));
  return m => {
    if (users.has((m.login || '').toLowerCase()) || users.has((m.name || '').toLowerCase())) return true;
    const t = norm(m.text);
    return exact.has(t.trim()) || words.some(w => t.includes(w));
  };
}

/* ---------- small UI helpers ---------- */
function toast(t) {
  const el = $('#toast'); el.textContent = t; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 1800);
}
function confirmSheet(title, text, okLabel) {
  return new Promise(res => {
    const s = document.createElement('div');
    s.className = 'sheet';
    s.innerHTML = '<div><h3></h3><p></p><div class="row"><button class="no">キャンセル</button><button class="ok"></button></div></div>';
    $('h3', s).textContent = title; $('p', s).textContent = text; $('.ok', s).textContent = okLabel;
    const done = v => { s.remove(); res(v); };
    $('.no', s).onclick = () => done(false); $('.ok', s).onclick = () => done(true);
    s.onclick = e => { if (e.target === s) done(false); };
    document.body.append(s);
  });
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const nameOf = login => prefs.names[login] || login;
function fmtCount(n) { return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n); }
function fmtLen(s) { const h = s / 3600 | 0, m = s % 3600 / 60 | 0, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }
function fmtDate(iso) { const d = new Date(iso); return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

/* ---------- navigation (works with the iPad swipe-back too) ---------- */
let current = 'home';
const leaveHooks = {};
function show(view, push = true) {
  // opening settings keeps the stream playing underneath
  if (leaveHooks[current] && current !== view && view !== 'settings') leaveHooks[current]();
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== view);
  current = view;
  if (push) history.pushState({ view }, '');
}
window.addEventListener('popstate', e => show((e.state && e.state.view) || 'home', false));
document.addEventListener('click', e => {
  if (e.target.closest('[data-back]')) history.back();
  if (e.target.closest('[data-settings]')) openSettings();
});

/* ======================================================================
   HOME
   ====================================================================== */
const live = {};          // login -> {title, viewers}
let previewOn = null;

function renderChannels() {
  const box = $('#channels');
  box.innerHTML = '';
  for (const ch of prefs.channels) {
    const info = live[ch];
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.ch = ch;
    let thumb = '';
    if (info) {
      const media = ch === VIDEO_CHANNEL
        ? `<iframe src="https://player.twitch.tv/?channel=${ch}&parent=${PARENT}&muted=true&autoplay=true&controls=false" allow="autoplay" tabindex="-1" style="pointer-events:none"></iframe>`
        : `<img alt="" src="https://static-cdn.jtvnw.net/previews-ttv/live_user_${ch}-640x360.jpg?t=${Date.now() / 60000 | 0}">`;
      thumb = `<div class="thumb">${media}<span class="pill">LIVE</span>${info.viewers != null ? `<span class="viewers">${fmtCount(info.viewers)}人が視聴中</span>` : ''}</div>`;
    }
    card.innerHTML = `${thumb}<div class="info"><div class="grow"><b>${esc(nameOf(ch))}</b><small>${info ? esc(info.title || '配信中') : 'オフライン'}</small></div>
      <button class="outline" data-arch>アーカイブ</button>${ch === SUB_CHANNEL ? '<button class="outline sub" data-sub>サブスク</button>' : ''}</div>`;
    box.append(card);
    attachCardGestures(card);
  }
  previewOn = live[VIDEO_CHANNEL] ? VIDEO_CHANNEL : null;
}

async function refreshHome() {
  const chs = prefs.channels;
  try {
    const users = await channelInfo(chs);
    const names = prefs.names;
    for (const k of Object.keys(live)) delete live[k];
    for (const u of users) {
      if (u.displayName) names[u.login] = u.displayName;
      if (u.stream) live[u.login] = { title: u.stream.title, viewers: u.stream.viewersCount };
    }
    prefs.names = names;
  } catch {}
  renderChannels();
}

$('#channels').addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (!card || card.dataset.dragged) return;
  const ch = card.dataset.ch;
  if (e.target.closest('[data-arch]')) return openArchives(ch);
  if (e.target.closest('[data-sub]')) return window.open('https://www.twitch.tv/subs/' + ch, '_blank');
  openLive(ch);
});
$('#btnRefresh').onclick = () => { refreshHome(); toast('更新しました'); };
$('#btnSettings').onclick = () => openSettings();

/* long-press drag to reorder, swipe left to delete */
function attachCardGestures(card) {
  let timer, startX, startY, dragging = false, swiping = false;
  card.addEventListener('touchstart', e => {
    const t = e.touches[0]; startX = t.clientX; startY = t.clientY; delete card.dataset.dragged;
    timer = setTimeout(() => { dragging = true; card.classList.add('dragging'); navigator.vibrate && navigator.vibrate(10); }, 400);
  }, { passive: true });
  card.addEventListener('touchmove', e => {
    const t = e.touches[0], dx = t.clientX - startX, dy = t.clientY - startY;
    if (!dragging && !swiping) {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5 && dx < 0) { swiping = true; clearTimeout(timer); }
      else if (Math.abs(dy) > 10 || Math.abs(dx) > 10) clearTimeout(timer);
    }
    if (swiping) { e.preventDefault(); card.style.transform = `translateX(${Math.min(0, dx)}px)`; }
    if (dragging) {
      e.preventDefault();
      card.style.transform = `translateY(${dy}px)`;
      const over = document.elementFromPoint(t.clientX, t.clientY);
      const other = over && over.closest('.card');
      if (other && other !== card) {
        const list = prefs.channels, a = list.indexOf(card.dataset.ch), b = list.indexOf(other.dataset.ch);
        list.splice(b, 0, list.splice(a, 1)[0]);
        prefs.channels = list;
        const r1 = card.getBoundingClientRect();
        if (a < b) other.after(card); else other.before(card);
        startY += card.getBoundingClientRect().top - r1.top;
        card.style.transform = `translateY(${t.clientY - startY}px)`;
      }
    }
  }, { passive: false });
  const end = async e => {
    clearTimeout(timer);
    if (dragging) { card.dataset.dragged = '1'; card.classList.remove('dragging'); card.style.transform = ''; dragging = false; setTimeout(() => delete card.dataset.dragged, 300); }
    if (swiping) {
      swiping = false; card.dataset.dragged = '1';
      const dx = e.changedTouches[0].clientX - startX;
      card.style.transform = '';
      if (dx < -80) {
        const ch = card.dataset.ch;
        if (await confirmSheet(nameOf(ch), '一覧から削除しますか?', '削除')) {
          prefs.channels = prefs.channels.filter(c => c !== ch); renderChannels();
        }
      }
      setTimeout(() => delete card.dataset.dragged, 300);
    }
  };
  card.addEventListener('touchend', end); card.addEventListener('touchcancel', end);
}

/* search */
let searchGen = 0, searchTimer;
$('#search').addEventListener('input', e => {
  const q = e.target.value.trim(), gen = ++searchGen;
  clearTimeout(searchTimer);
  if (!q) { $('#suggest').hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const res = await searchChannels(q);
    if (gen !== searchGen) return;
    const box = $('#suggest');
    box.innerHTML = '';
    if (!res || !res.length) box.innerHTML = `<div class="msg">${res ? '見つかりませんでした' : '検索できませんでした。IDを入れてEnterでも追加できます'}</div>`;
    for (const r of (res || []).slice(0, 8)) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<div class="grow"><b>${esc(r.name)}</b><small>${esc(r.login)} ・ フォロワー ${fmtCount(r.followers)}</small></div>
        ${r.live ? '<span class="pill" style="position:static">LIVE</span>' : ''}<span class="add">${prefs.channels.includes(r.login) ? '追加済み' : '＋追加'}</span>`;
      row.onclick = () => addChannel(r.login, r.name);
      box.append(row);
    }
    box.hidden = false;
  }, 400);
});
$('#search').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const v = e.target.value.trim().replace(/^.*twitch\.tv\//, '').replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
  if (v) addChannel(v);
});
function addChannel(login, name) {
  if (name) { const n = prefs.names; n[login] = name; prefs.names = n; }
  if (!prefs.channels.includes(login)) prefs.channels = [login, ...prefs.channels];
  $('#search').value = ''; $('#suggest').hidden = true; $('#search').blur();
  refreshHome();
}

/* ======================================================================
   CHAT (shared by live and archive)
   ====================================================================== */
class ChatView {
  constructor(listEl, statusEl, onLong) {
    this.list = listEl; this.status = statusEl; this.onLong = onLong; this.items = 0;
    this.latest = listEl.parentElement.querySelector('.latest');
    this.latest.onclick = () => this.toEnd();
    listEl.addEventListener('scroll', () => this.latest.hidden = this.atBottom());
  }
  atBottom() { const l = this.list; return l.scrollHeight - l.scrollTop - l.clientHeight < 40; }
  toEnd() { this.list.scrollTop = this.list.scrollHeight; this.latest.hidden = true; }
  clear() { this.list.innerHTML = ''; }
  add(m) {
    const stick = this.atBottom();
    const div = document.createElement('div');
    div.className = 'msg' + (m.notice ? ' notice' : '');
    div.dataset.login = (m.login || '').toLowerCase();
    if (m.id) div.dataset.id = m.id;
    div.innerHTML = (m.notice ? '' : `<span class="n" style="color:${readable(m.color, m.login)}">${esc(m.name)}</span>: `) + renderText(m.text, m.emotes);
    let t;
    div.addEventListener('touchstart', () => { t = setTimeout(() => this.onLong(m), 550); }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(ev => div.addEventListener(ev, () => clearTimeout(t), { passive: true }));
    this.list.append(div);
    while (this.list.childElementCount > 400) this.list.firstElementChild.remove();
    if (stick) this.toEnd();
  }
  removeWhere(fn) { for (const el of [...this.list.children]) if (fn(el)) el.remove(); }
}
function renderText(text, emotes) {
  if (!emotes || !emotes.length) return esc(text);
  let out = '', pos = 0;
  for (const e of [...emotes].sort((a, b) => a.s - b.s)) {
    out += esc(text.slice(pos, e.s));
    out += `<img alt="${esc(text.slice(e.s, e.e))}" src="https://static-cdn.jtvnw.net/emoticons/v2/${e.id}/default/dark/2.0">`;
    pos = e.e;
  }
  return out + esc(text.slice(pos));
}
const PALETTE = ['#ff7f50', '#1e90ff', '#00ff7f', '#9acd32', '#ff69b4', '#daa520', '#5f9ea0', '#b57bff'];
function readable(hex, login) {
  let c = hex;
  if (!c) { let h = 0; for (const ch of login || '') h = (h * 31 + ch.charCodeAt(0)) | 0; c = PALETTE[Math.abs(h) % PALETTE.length]; }
  const n = parseInt(c.slice(1), 16); if (isNaN(n)) return '#bf94ff';
  let r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  if ((0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.45) { r += (255 - r) * .45; g += (255 - g) * .45; b += (255 - b) * .45; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
async function askNgUser(m, view) {
  if (!m.login) return;
  if (await confirmSheet(m.name, 'この人のコメントを今後すべて非表示にしますか?', 'NGにする')) {
    prefs.ngUsers = [...prefs.ngUsers, m.login];
    view.removeWhere(el => el.dataset.login === m.login.toLowerCase());
  }
}
function applyChatStyle() {
  const land = matchMedia('(orientation: landscape)').matches;
  document.documentElement.style.setProperty('--chat-font', (land ? prefs.fontL : prefs.fontP) + 'px');
  document.documentElement.style.setProperty('--chat-width', prefs.chatWidth + '%');
  document.documentElement.style.setProperty('--overlay-bg', `rgba(0,0,0,${prefs.overlayAlpha / 100})`);
}
matchMedia('(orientation: landscape)').addEventListener('change', () => { applyChatStyle(); applyMode(); showBarBriefly(); });

/* ======================================================================
   LIVE
   ====================================================================== */
let livePlayer = null, irc = null, liveCh = null, liveFilter = null, folded = false, liveTimers = [];
const liveChat = new ChatView($('#liveList'), $('#liveStatus'), m => askNgUser(m, liveChat));

function openLive(ch) {
  liveCh = ch; folded = false;
  $('#liveName').textContent = nameOf(ch);
  show('player');
  applyChatStyle(); applyMode();
  $('#liveEmbed').innerHTML = '';
  livePlayer = new Twitch.Player('liveEmbed', { channel: ch, parent: [PARENT], width: '100%', height: '100%', autoplay: true, muted: false });
  connectChat();
  showBarBriefly();
}
leaveHooks.player = () => {
  if (irc) { irc.onclose = null; irc.close(); irc = null; }
  liveTimers.forEach(clearTimeout); liveTimers = [];
  $('#liveEmbed').innerHTML = ''; livePlayer = null;
};
/* Twitch sometimes goes quiet without closing: ask, and reconnect if there is no answer */
let lastRx = 0, pinged = false;
setInterval(() => {
  if (current !== 'player' || !irc) return;
  const quiet = Date.now() - lastRx;
  if (quiet > 75000 && pinged) { pinged = false; connectChat(); }
  else if (quiet > 60000 && !pinged && irc.readyState === 1) { pinged = true; irc.send('PING :tmi.twitch.tv'); }
}, 5000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && current === 'player' && Date.now() - lastRx > 45000) connectChat();
});

function connectChat() {
  lastRx = Date.now(); pinged = false;
  if (irc) { irc.onclose = null; irc.close(); }
  liveTimers.forEach(clearTimeout); liveTimers = [];
  liveChat.clear();
  liveFilter = makeFilter();
  $('#liveStatus').textContent = 'チャットに接続しています…';
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  irc = ws;
  ws.onopen = () => {
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send('PASS SCHMOOPIIE');
    ws.send('NICK justinfan' + (10000 + Math.random() * 89999 | 0));
    ws.send('JOIN #' + liveCh.toLowerCase());
    $('#liveStatus').textContent = 'チャットに接続しました(読み取り専用)';
    setTimeout(() => { if (liveChat.list.childElementCount) $('#liveStatus').textContent = ''; }, 3000);
  };
  ws.onmessage = ev => { lastRx = Date.now(); pinged = false; ev.data.split('\r\n').forEach(line => line && handleIrc(ws, line)); };
  ws.onclose = () => { if (irc === ws) { $('#liveStatus').textContent = 'チャットに再接続しています…'; setTimeout(() => irc === ws && connectChat(), 3000); } };
}
function handleIrc(ws, line) {
  if (line.startsWith('PING')) return ws.send('PONG' + line.slice(4));
  let rest = line, tags = {};
  if (rest[0] === '@') {
    const sp = rest.indexOf(' ');
    for (const kv of rest.slice(1, sp).split(';')) {
      const i = kv.indexOf('=');
      tags[kv.slice(0, i)] = kv.slice(i + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\');
    }
    rest = rest.slice(sp + 1);
  }
  let prefix = '';
  if (rest[0] === ':') { const sp = rest.indexOf(' '); prefix = rest.slice(1, sp); rest = rest.slice(sp + 1); }
  const ti = rest.indexOf(' :'), trailing = ti >= 0 ? rest.slice(ti + 2) : '';
  const cmd = (ti >= 0 ? rest.slice(0, ti) : rest).split(' ')[0];
  if (cmd === 'PRIVMSG') {
    let text = trailing, action = false;
    if (text.startsWith('\u0001ACTION ') && text.endsWith('\u0001')) { text = text.slice(8, -1); action = true; }
    const login = prefix.split('!')[0];
    const m = { id: tags.id, login, name: tags['display-name'] || login, color: tags.color, text, emotes: parseEmotes(tags.emotes, text) };
    deliver(m);
  } else if (cmd === 'USERNOTICE' && tags['system-msg']) {
    deliver({ id: tags.id, login: tags.login || '', name: '', text: tags['system-msg'] + (trailing ? '  ' + trailing : ''), notice: true });
  } else if (cmd === 'CLEARCHAT') {
    if (trailing) liveChat.removeWhere(el => el.dataset.login === trailing.toLowerCase()); else liveChat.clear();
  } else if (cmd === 'CLEARMSG' && tags['target-msg-id']) {
    liveChat.removeWhere(el => el.dataset.id === tags['target-msg-id']);
  } else if (cmd === 'RECONNECT') ws.close();
}
function parseEmotes(raw, text) {
  if (!raw) return [];
  const cps = Array.from(text), out = [];
  const idx = i => cps.slice(0, i).join('').length;   // code points -> string index
  for (const g of raw.split('/')) {
    const [id, ranges] = g.split(':');
    for (const r of (ranges || '').split(',')) {
      const [a, b] = r.split('-').map(Number);
      if (isNaN(a) || isNaN(b) || b >= cps.length) continue;
      out.push({ s: idx(a), e: idx(b + 1), id });
    }
  }
  return out;
}
function deliver(m) {
  const go = () => { if (!liveFilter(m)) { liveChat.add(m); $('#liveStatus').textContent = ''; } };
  if (prefs.delay > 0) liveTimers.push(setTimeout(go, prefs.delay * 1000)); else go();
}

/* layout modes in landscape: side / overlay / none, plus fold */
function applyMode() {
  const stage = $('#player .stage');
  const mode = folded ? 2 : prefs.landscapeMode;
  stage.classList.toggle('overlay', mode === 1);
  stage.classList.toggle('nochat', mode === 2);
  $('#btnMode').textContent = ['横並び', '重ねる', 'チャットなし'][prefs.landscapeMode];
  const land = matchMedia('(orientation: landscape)').matches;
  $('#btnMode').hidden = !land || folded;
  $('#btnUnfold').hidden = !(land && folded && prefs.landscapeMode !== 2);
  // the bar spans only the video in side-by-side mode
  stage.style.setProperty('--bar-right', land && mode === 0 ? `calc(${prefs.chatWidth}% + 16px)` : (land && mode === 1 ? prefs.chatWidth + '%' : '0'));
}
$('#btnMode').onclick = () => { prefs.landscapeMode = (prefs.landscapeMode + 1) % 3; applyMode(); showBarBriefly(); };
$('#btnFold').onclick = () => { folded = true; applyMode(); };
$('#btnUnfold').onclick = () => { folded = false; applyMode(); };
$('#btnLiveRefresh').onclick = () => {
  connectChat();
  try {
    if (!livePlayer || livePlayer.isPaused()) { $('#liveEmbed').innerHTML = ''; livePlayer = new Twitch.Player('liveEmbed', { channel: liveCh, parent: [PARENT], width: '100%', height: '100%', autoplay: true }); }
  } catch {}
  toast('更新しました');
};

/* the bar hides after 3s in landscape; touching the top edge or the chat brings it back
   (taps on the video itself go to Twitch's player and cannot be seen by this page) */
function showBarBriefly() {
  const bar = $('#player .bar');
  bar.classList.remove('hide');
  clearTimeout(showBarBriefly.t);
  if (matchMedia('(orientation: landscape)').matches) showBarBriefly.t = setTimeout(() => bar.classList.add('hide'), 3000);
}
document.addEventListener('touchstart', e => {
  if (current !== 'player') return;
  if (e.touches[0].clientY < 60 || e.target.closest('.chat')) showBarBriefly();
}, { passive: true });

/* drag the splitter to resize the chat */
(() => {
  const sp = $('#splitter');
  sp.addEventListener('touchmove', e => {
    e.preventDefault();
    const w = window.innerWidth, x = e.touches[0].clientX;
    const pct = Math.round(Math.min(65, Math.max(15, (w - x) / w * 100)));
    prefs.chatWidth = pct; applyChatStyle(); applyMode();
  }, { passive: false });
})();

/* ======================================================================
   ARCHIVES
   ====================================================================== */
async function openArchives(ch) {
  $('#archTitle').textContent = nameOf(ch) + ' のアーカイブ';
  $('#archStatus').textContent = '読み込み中…'; $('#archStatus').hidden = false;
  $('#archList').innerHTML = '';
  show('archives');
  let vids;
  try { vids = await archives(ch); } catch { vids = null; }
  if (!vids) return $('#archStatus').textContent = '読み込めませんでした';
  if (!vids.length) return $('#archStatus').textContent = 'アーカイブはありません';
  $('#archStatus').hidden = true;
  for (const v of vids) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="thumb">${v.previewThumbnailURL ? `<img alt="" loading="lazy" src="${esc(v.previewThumbnailURL)}">` : ''}<span class="len">${fmtLen(v.lengthSeconds)}</span></div>
      <div class="info"><div class="grow"><b>${esc(v.title || '(タイトルなし)')}</b><small>${fmtDate(v.publishedAt)} ・ ${v.viewCount}回視聴</small></div></div>`;
    card.onclick = () => openVod(v);
    $('#archList').append(card);
  }
}

/* ---------- archive player with chat replay ---------- */
let vodPlayer = null, vodId = null, vodTick = null, vodFilter = null;
const vodChat = new ChatView($('#vodList'), $('#vodStatus'), m => askNgUser(m, vodChat));
const vs = { pending: [], next: null, started: false, fetching: false, gen: 0, last: -1, seen: new Set() };

function openVod(v) {
  vodId = v.id;
  $('#vodName').textContent = v.title || '';
  show('vod');
  applyChatStyle();
  vodFilter = makeFilter();
  $('#vodEmbed').innerHTML = '';
  const start = prefs.vodPos[v.id] || 0;
  vodPlayer = new Twitch.Player('vodEmbed', { video: v.id, parent: [PARENT], width: '100%', height: '100%', autoplay: true, time: start + 's' });
  resetVodChat(start);
  vodTick = setInterval(tickVod, 250);
}
leaveHooks.vod = () => {
  clearInterval(vodTick);
  try { const p = prefs.vodPos; p[vodId] = vodPlayer.getCurrentTime() | 0; prefs.vodPos = p; } catch {}
  $('#vodEmbed').innerHTML = ''; vodPlayer = null; vs.gen++;
};
function resetVodChat(pos) {
  vs.gen++; vs.pending = []; vs.next = null; vs.started = false; vs.fetching = false; vs.seen = new Set();
  vodChat.clear();
  fetchVod(pos);
}
async function fetchVod(offset) {
  if (vs.fetching) return;
  vs.fetching = true; vs.started = true;
  const gen = vs.gen;
  let page;
  try { page = await vodComments(vodId, offset); } catch { page = null; }
  if (gen !== vs.gen) return;
  vs.fetching = false;
  if (!page) { $('#vodStatus').textContent = 'チャットを読み込めませんでした'; vs.next = null; return; }
  $('#vodStatus').textContent = '';
  const pos = vodPlayer ? vodPlayer.getCurrentTime() : 0;
  for (const c of page.list) {
    if (vs.seen.has(c.id)) continue;   // pages overlap by a few seconds
    vs.seen.add(c.id);
    if (c.at <= pos) { if (!vodFilter(c)) vodChat.add(c); } else vs.pending.push(c);
  }
  vs.next = page.next;
}
function tickVod() {
  if (!vodPlayer) return;
  let pos; try { pos = vodPlayer.getCurrentTime(); } catch { return; }
  if (vs.last >= 0 && (pos < vs.last - 2 || pos > vs.last + 15)) { vs.last = pos; return resetVodChat(pos | 0); }
  vs.last = pos;
  while (vs.pending.length && vs.pending[0].at <= pos) {
    const c = vs.pending.shift();
    if (!vodFilter(c)) vodChat.add(c);
  }
  if (vs.pending.length < 30 && vs.next != null) fetchVod(vs.next);
}

/* ======================================================================
   SETTINGS
   ====================================================================== */
const units = { fontP: '', fontL: '', delay: '秒', chatWidth: '%', overlayAlpha: '%' };
function openSettings() {
  document.querySelectorAll('[data-key]').forEach(inp => {
    const k = inp.dataset.key; inp.value = prefs[k];
    const out = $(`[data-out="${k}"]`); out.textContent = prefs[k] + units[k];
    inp.oninput = () => { prefs[k] = Number(inp.value); out.textContent = inp.value + units[k]; applyChatStyle(); };
  });
  document.querySelectorAll('[data-list]').forEach(t => { t.value = prefs[t.dataset.list].join('\n'); });
  $('#ngPlayersOn').checked = prefs.ngPlayersOn;
  $('#ngPlayersTitle').textContent = `NG選手(${prefs.ngPlayers.length}人)`;
  show('settings');
}
leaveHooks.settings = () => {
  document.querySelectorAll('[data-list]').forEach(t => {
    const v = t.value.split('\n').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
    prefs[t.dataset.list] = t.dataset.list === 'ngUsers' ? v.map(s => s.toLowerCase()) : v;
  });
  prefs.ngPlayersOn = $('#ngPlayersOn').checked;
  // settings may change what is hidden right now
  liveFilter = makeFilter(); vodFilter = makeFilter();
  applyChatStyle(); applyMode();
};

/* ---------- start ---------- */
history.replaceState({ view: 'home' }, '');
syncPlayers();
refreshHome();
setInterval(() => { if (current === 'home' && !document.hidden) refreshHome(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && current === 'home') refreshHome(); });
