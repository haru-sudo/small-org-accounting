// ══════════════════════════════════════════════════════════════════════════════
// icons.js — 絵文字の代わりに使う線のアイコン
//   HTML に <span class="ei" data-i="check"></span> と書くと、SVG に置き換える。
//   あとから innerHTML で入った要素も MutationObserver で置き換える。
//   色は文字色（currentColor）、大きさは文字の大きさ（1.15em）に合わせる。
// ══════════════════════════════════════════════════════════════════════════════
const ICONS = {
  home:     '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/>',
  upload:   '<path d="M12 15V4"/><path d="m7 9 5-5 5 5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  list:     '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  train:    '<rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 10h14"/><circle cx="9" cy="13" r=".8"/><circle cx="15" cy="13" r=".8"/><path d="m8 21 2-5M16 21l-2-5"/>',
  users:    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  user:     '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  file:     '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  chart:    '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="11" width="3" height="6"/><rect x="12" y="7" width="3" height="10"/><rect x="17" y="13" width="3" height="4"/>',
  book:     '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7"/>',
  books:    '<path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="m16.5 4.5 3.5-1 3 15.5-3.5 1z"/>',
  spark:    '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="m12 8 1.3 2.7L16 12l-2.7 1.3L12 16l-1.3-2.7L8 12l2.7-1.3z"/>',
  chat:     '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  bolt:     '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  card:     '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>',
  tag:      '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  clock:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  hourglass:'<path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9"/>',
  gear:     '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus:     '<path d="M12 5v14M5 12h14"/>',
  check:    '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkc:   '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  x:        '<path d="M6 6l12 12M18 6 6 18"/>',
  xc:       '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  alert:    '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  key:      '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
  eye:      '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  logout:   '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5"/><path d="M15 16l4-4-4-4M19 12H9"/>',
  clipboard:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>',
  bank:     '<path d="M3 10 12 4l9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  mail:     '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  save:     '<path d="M5 3h11l3 3v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
  search:   '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  refresh:  '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 21v-5h-5"/>',
  edit:     '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash:    '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  lock:     '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock:   '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  clip:     '<path d="m20 12-8.5 8.5a5 5 0 0 1-7-7L13 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 8"/>',
  receipt:  '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  grid:     '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
  yen:      '<path d="m6 4 6 8 6-8M12 12v8M7 13h10M7 17h10"/>',
  box:      '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  ticket:   '<path d="M3 8V6h18v2a2 2 0 0 0 0 4v2a2 2 0 0 0 0 4v0H3v-4a2 2 0 0 0 0-4z"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
  meal:     '<path d="M3 12h18a9 9 0 0 1-18 0zM8 9V4M12 9V3M16 9V4"/>',
  image:    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5-9 9"/>',
  eraser:   '<path d="M14 4 21 11 12 20H7l-4-4z"/><path d="M9 9l7 7M7 20h13"/>',
  send:     '<path d="M21 3 3 10.5l7 3 3 7z"/><path d="m10 13.5 4-4"/>',
};

function iconSvg(name, size) {
  const p = ICONS[name]; if (!p) return '';
  const wh = size ? ` width="${size}" height="${size}"` : '';
  return `<svg${wh} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

// data-i の付いた要素にアイコンを入れる（何度呼んでもよい）
function paintIcons(root) {
  const els = root && root.matches && root.matches('[data-i]') ? [root] : [];
  (root || document).querySelectorAll('[data-i]').forEach(el => els.push(el));
  els.forEach(el => {
    if (el.dataset.iDone === el.dataset.i) return;
    if (!ICONS[el.dataset.i]) return;   // アイコン名でない data-i（行番号など）は中身を消さない
    el.innerHTML = iconSvg(el.dataset.i, parseInt(el.dataset.size || '0', 10) || undefined);
    el.dataset.iDone = el.dataset.i;
  });
}
document.addEventListener('DOMContentLoaded', () => {
  paintIcons(document);
  // あとから画面に入った要素（innerHTML で作る一覧など）も置き換える
  new MutationObserver(list => {
    for (const m of list) m.addedNodes.forEach(n => { if (n.nodeType === 1) paintIcons(n); });
  }).observe(document.body, { childList: true, subtree: true });
});
