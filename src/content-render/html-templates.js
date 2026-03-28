/**
 * HTML Template Rendering System v2
 * 
 * 12 template types with varied layouts:
 * - photo_hero, full_graphic, checklist, review_showcase
 * - process_steps, stat_callout, service_highlight, offer_coupon
 * - warning_signs, did_you_know, brand_intro, split_feature
 */

const { RSA_LOGO, BBB_BADGE, IICRC_BADGE, GOOGLE_LOGO, GREENSKY_BADGE } = require('./assets');

// ── SVG Icons ──────────────────────────────────────────────────────
const ICONS = {
  check: (c,s) => `<svg width="${s||20}" height="${s||20}" viewBox="0 0 24 24" fill="none" stroke="${c||'#fff'}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  shield: (c,s) => `<svg width="${s||20}" height="${s||20}" viewBox="0 0 24 24" fill="none" stroke="${c||'#fff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  home: (c,s) => `<svg width="${s||20}" height="${s||20}" viewBox="0 0 24 24" fill="none" stroke="${c||'#fff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  star: (c,s) => `<svg width="${s||20}" height="${s||20}" viewBox="0 0 24 24" fill="${c||'#FBBC04'}" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
  alert: (c,s) => `<svg width="${s||20}" height="${s||20}" viewBox="0 0 24 24" fill="none" stroke="${c||'#fff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  droplet: (c,s) => `<svg width="${s||20}" height="${s||20}" viewBox="0 0 24 24" fill="none" stroke="${c||'#fff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0z"/></svg>`,
  clock: (c,s) => `<svg width="${s||20}" height="${s||20}" viewBox="0 0 24 24" fill="none" stroke="${c||'#fff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  phone: (c,s) => `<svg width="${s||20}" height="${s||20}" viewBox="0 0 24 24" fill="none" stroke="${c||'#fff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>`,
  tool: (c,s) => `<svg width="${s||20}" height="${s||20}" viewBox="0 0 24 24" fill="none" stroke="${c||'#fff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>`,
  award: (c,s) => `<svg width="${s||20}" height="${s||20}" viewBox="0 0 24 24" fill="none" stroke="${c||'#fff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>`,
  zap: (c,s) => `<svg width="${s||20}" height="${s||20}" viewBox="0 0 24 24" fill="${c||'#FBBC04'}" stroke="${c||'#FBBC04'}" stroke-width="1"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  cloud: (c,s) => `<svg width="${s||20}" height="${s||20}" viewBox="0 0 24 24" fill="none" stroke="${c||'#fff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/></svg>`,
};

const ICON_ROTATION = ['shield', 'home', 'star', 'award', 'tool', 'clock'];

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function hl(text, words, cls) {
  if (!words?.length || !text) return esc(text||'');
  let r = esc(text);
  words.forEach(w => { r = r.replace(new RegExp(`(${esc(w)})`, 'gi'), `<span class="${cls||'hl'}">$1</span>`); });
  return r;
}

function starsRow(n, sz) {
  return Array(n||5).fill(0).map(()=>ICONS.star('#FBBC04', sz||24)).join('');
}

function getAssets(biz) {
  const id = biz.id || biz.slug || '';
  if (id === 'rsa') return { logo: RSA_LOGO, bbb: BBB_BADGE, iicrc: IICRC_BADGE, google: GOOGLE_LOGO, greensky: GREENSKY_BADGE };
  return { logo: biz.design_system?.logo_url || '', bbb: '', iicrc: '', google: GOOGLE_LOGO, greensky: '' };
}

// ── Base shell ─────────────────────────────────────────────────────

function shell(biz, body) {
  const ds = biz.design_system || {};
  const f = ds.fonts || {};
  const hf = f.headline?.family || 'Bebas Neue';
  const bf = f.body?.family || 'Montserrat';
  const ht = f.headline?.transform || 'uppercase';
  const hls = f.headline?.letter_spacing || '2px';
  const accent = ds.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const urgency = ds.colors_extended?.urgency || '#C62828';

  const fams = [];
  if (hf) fams.push(hf.replace(/ /g, '+'));
  if (bf && bf !== hf) fams.push(bf.replace(/ /g, '+') + ':wght@400;500;600;700;800;900');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
@import url('https://fonts.googleapis.com/css2?family=${fams.join('&family=')}&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{width:1080px;height:1350px;overflow:hidden;}
.post{width:1080px;height:1350px;display:flex;flex-direction:column;overflow:hidden;position:relative;}
.hf{font-family:'${hf}','Bebas Neue','Impact',sans-serif;text-transform:${ht};letter-spacing:${hls};}
.bf{font-family:'${bf}','Montserrat','Segoe UI',sans-serif;}
.hl{color:${accent};}
.ur{color:${urgency};}
</style></head><body>${body}</body></html>`;
}

// ── Shared components ──────────────────────────────────────────────

function ctaBar(biz, c) {
  const ds = biz.design_system || {};
  if (!ds.cta_bar?.enabled) return '';
  const grad = ds.cta_bar?.bg_gradient || ds.gradients?.cta || 'linear-gradient(135deg,#C62828,#B71C1C)';
  const phone = ds.cta_bar?.phone || '';
  const l1 = esc(c.cta_line1||''); const l2 = esc(c.cta_line2||c.cta||'FREE ESTIMATE');
  return `<div style="background:${grad};padding:30px 52px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;min-height:110px;">
    <div style="flex:1;min-width:0;">
      ${l1?`<div class="bf" style="font-size:22px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:2px;">${l1}</div>`:''}
      <div class="hf" style="font-size:52px;color:#fff;line-height:1;">${l2}</div>
    </div>
    ${phone?`<div class="hf" style="font-size:52px;color:#fff;margin-left:40px;">${esc(phone)}</div>`:''}
  </div>`;
}

function badgeImgs(biz, pos) {
  const a = getAssets(biz); const imgs = [];
  if (a.bbb) imgs.push(a.bbb); if (a.iicrc) imgs.push(a.iicrc);
  if (!imgs.length) return '';
  const h = pos==='corner'?'42':'50';
  return `<div style="display:flex;gap:${pos==='corner'?'6':'14'}px;align-items:center;${pos==='corner'?'':'justify-content:center;'}">${imgs.map(i=>`<img src="${i}" style="height:${h}px;border-radius:4px;"/>`).join('')}</div>`;
}

function brandBar(biz) {
  const a = getAssets(biz);
  const accent = biz.design_system?.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  return `<div style="background:${biz.primary_color||'#273373'};padding:22px 48px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
    <div style="display:flex;align-items:center;gap:14px;">
      ${a.logo?`<div style="width:48px;height:48px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,0.2);"><img src="${a.logo}" style="width:36px;height:36px;object-fit:contain;"/></div>`:''}
      <div class="hf" style="font-size:24px;color:#fff;letter-spacing:3px;">${esc(biz.name.toUpperCase())}</div>
    </div>
    ${biz.website?`<div class="bf" style="font-size:14px;color:${accent};font-weight:600;">@${esc(biz.website.replace('www.','').replace('.com',''))}</div>`:''}
  </div>`;
}

function accentStrip(biz, h) {
  const accent = biz.design_system?.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const sec = biz.secondary_color || biz.primary_color;
  return `<div style="height:${h||6}px;background:linear-gradient(90deg,${accent},${sec},${biz.primary_color});flex-shrink:0;"></div>`;
}

function logoCircle(biz, size) {
  const a = getAssets(biz); if (!a.logo) return '';
  const s = size||68; const is = Math.round(s*0.72);
  return `<div style="width:${s}px;height:${s}px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(0,0,0,0.3);"><img src="${a.logo}" style="width:${is}px;height:${is}px;object-fit:contain;"/></div>`;
}

function decorCircles(color, opacity) {
  const c = color || 'rgba(255,255,255,0.03)';
  return `<div style="position:absolute;top:-80px;right:-80px;width:300px;height:300px;border-radius:50%;background:${c};opacity:${opacity||1};"></div>
  <div style="position:absolute;bottom:-120px;left:-60px;width:240px;height:240px;border-radius:50%;background:${c};opacity:${opacity||1};"></div>`;
}


// ═══════════════════════════════════════════════════════════════════
// 1. PHOTO HERO
// ═══════════════════════════════════════════════════════════════════

function photoHero(content, biz, photo) {
  const ds = biz.design_system || {};
  const primary = biz.primary_color || '#273373';
  const accent = ds.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const stats = content.stats || [];
  const items = content.items || [];

  const top = photo
    ? `<div style="flex:0 0 52%;position:relative;overflow:hidden;">
        <img src="${photo}" style="width:100%;height:100%;object-fit:cover;display:block;"/>
        <div style="position:absolute;bottom:0;left:0;right:0;height:70%;background:linear-gradient(0deg,${primary} 0%,${primary}DD 25%,transparent 100%);"></div>
        <div style="position:absolute;top:28px;left:28px;">${logoCircle(biz,68)}</div>
        <div style="position:absolute;top:24px;right:24px;">${badgeImgs(biz,'corner')}</div>
        <div style="position:absolute;bottom:32px;left:0;right:0;text-align:center;padding:0 52px;">
          <div class="hf" style="font-size:88px;color:#fff;line-height:0.9;">${hl(content.headline, content.highlight_words)}</div>
        </div>
      </div>`
    : `<div style="flex:0 0 40%;background:linear-gradient(160deg,${biz.bg_color||'#1a2a6c'},${primary});display:flex;align-items:center;justify-content:center;padding:40px 52px;text-align:center;position:relative;overflow:hidden;">
        ${decorCircles(primary+'30')}
        <div style="position:absolute;top:28px;left:28px;">${logoCircle(biz,68)}</div>
        <div style="position:absolute;top:24px;right:24px;">${badgeImgs(biz,'corner')}</div>
        <div class="hf" style="font-size:92px;color:#fff;line-height:0.9;position:relative;z-index:1;">${hl(content.headline, content.highlight_words)}</div>
      </div>`;

  return shell(biz, `<div class="post">${top}
    <div style="flex:1;background:${primary};padding:36px 48px;display:flex;flex-direction:column;justify-content:center;">
      ${content.subtext?`<div style="text-align:center;margin-bottom:24px;">
        <div style="width:50px;height:3px;background:${accent};margin:0 auto 14px;"></div>
        <div class="bf" style="font-size:20px;color:rgba(255,255,255,0.8);line-height:1.5;font-weight:500;">${esc(content.subtext)}</div>
      </div>`:''}
      ${stats.length?`<div style="display:flex;justify-content:space-around;margin-top:8px;">
        ${stats.map(s=>`<div style="text-align:center;">
          <div class="hf" style="font-size:68px;color:${accent};line-height:1;">${esc(s.value)}</div>
          <div class="bf" style="font-size:14px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:2px;margin-top:6px;font-weight:700;">${esc(s.label)}</div>
        </div>`).join('')}
      </div>`:''}
      ${items.length&&!stats.length?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px 32px;margin-top:12px;">
        ${items.map((it,i)=>{const t=typeof it==='string'?it:it.title||it;const sub=typeof it==='object'?it.subtitle:'';const ic=ICON_ROTATION[i%ICON_ROTATION.length];
        return`<div style="display:flex;align-items:center;gap:14px;">
          <div style="width:42px;height:42px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;">${ICONS[ic]('rgba(255,255,255,0.7)',20)}</div>
          <div><div class="bf" style="font-size:17px;font-weight:800;color:#fff;text-transform:uppercase;">${esc(t)}</div>
          ${sub?`<div class="bf" style="font-size:12px;color:rgba(255,255,255,0.4);font-weight:500;">${esc(sub)}</div>`:''}</div>
        </div>`;}).join('')}
      </div>`:''}
    </div>${ctaBar(biz,content)}</div>`);
}


// ═══════════════════════════════════════════════════════════════════
// 2. FULL GRAPHIC
// ═══════════════════════════════════════════════════════════════════

function fullGraphic(content, biz) {
  const ds = biz.design_system || {};
  const primary = biz.primary_color || '#273373';
  const accent = ds.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const items = content.items || [];
  const badge = content.badge_label || '';

  return shell(biz, `<div class="post">
    ${badge?`<div style="background:${ds.colors_extended?.urgency||'#C62828'};padding:22px;text-align:center;flex-shrink:0;">
      <div class="bf" style="font-size:20px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:6px;">${esc(badge)}</div>
    </div>`:''}
    <div style="flex:1;background:linear-gradient(160deg,${biz.bg_color||'#1a2a6c'},${primary});display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 56px;text-align:center;position:relative;overflow:hidden;">
      ${decorCircles(accent+'10')}
      <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;">
        ${logoCircle(biz,88)}
        <div style="margin-top:32px;" class="hf" style2="a">${''}</div>
        <div class="hf" style="font-size:96px;color:#fff;line-height:0.92;margin-top:32px;">${hl(content.headline, content.highlight_words)}</div>
        ${content.subtext?`<div class="bf" style="font-size:22px;color:rgba(255,255,255,0.65);margin-top:18px;line-height:1.5;max-width:780px;font-weight:500;">${esc(content.subtext)}</div>`:''}
        ${items.length?`<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-top:36px;">
          ${items.map(it=>{const l=typeof it==='string'?it:it.title||it;
          return`<div style="background:rgba(132,210,242,0.12);border:1px solid rgba(132,210,242,0.25);border-radius:24px;padding:12px 28px;font-size:17px;font-weight:700;color:${accent};text-transform:uppercase;letter-spacing:1px;font-family:'Montserrat',sans-serif;">${esc(l)}</div>`;}).join('')}
        </div>`:''}
        <div style="margin-top:32px;">${badgeImgs(biz,'center')}</div>
      </div>
    </div>${ctaBar(biz,content)}</div>`);
}


// ═══════════════════════════════════════════════════════════════════
// 3. CHECKLIST — with weather icon for seasonal, accent checkboxes
// ═══════════════════════════════════════════════════════════════════

function checklist(content, biz) {
  const ds = biz.design_system || {};
  const urgency = ds.colors_extended?.urgency || '#C62828';
  const accent = ds.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const items = content.items || [];
  const badge = content.badge_label || '';
  const isSeasonal = badge.toLowerCase().includes('season') || badge.toLowerCase().includes('storm') || badge.toLowerCase().includes('alert');

  return shell(biz, `<div class="post">
    ${brandBar(biz)}
    <div style="flex:1;background:${biz.bg_color||'#0d1b2a'};padding:44px 56px;display:flex;flex-direction:column;position:relative;overflow:hidden;">
      ${decorCircles('rgba(255,255,255,0.015)')}
      ${badge?`<div style="position:absolute;top:-62px;right:48px;background:${urgency};border-radius:6px;padding:8px 18px;z-index:2;">
        <div class="bf" style="font-size:14px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:2px;">${esc(badge)}</div>
      </div>`:''}
      <div style="text-align:center;margin-bottom:28px;position:relative;z-index:1;">
        ${isSeasonal?`<div style="margin-bottom:16px;">${ICONS.cloud('rgba(255,255,255,0.6)',48)}${ICONS.zap('#FBBC04',32)}</div>`:''}
        <div class="hf" style="font-size:82px;color:#fff;line-height:0.92;">${hl(content.headline, content.highlight_words, 'ur')}</div>
        ${content.subtext?`<div class="bf" style="font-size:18px;color:rgba(255,255,255,0.55);margin-top:16px;line-height:1.5;font-weight:500;max-width:700px;margin-left:auto;margin-right:auto;">${esc(content.subtext)}</div>`:''}
      </div>
      <div style="flex:1;display:flex;flex-direction:column;justify-content:space-evenly;position:relative;z-index:1;">
        ${items.map(it=>{const l=typeof it==='string'?it:it.title||it;
        return`<div style="display:flex;align-items:center;gap:20px;padding:18px 24px;background:rgba(255,255,255,0.03);border-radius:12px;border:1px solid rgba(255,255,255,0.04);">
          <div style="width:40px;height:40px;border-radius:8px;background:${accent};display:flex;align-items:center;justify-content:center;flex-shrink:0;">${ICONS.check(biz.bg_color||'#0d1b2a',20)}</div>
          <div class="bf" style="font-size:23px;font-weight:700;color:#fff;">${esc(l)}</div>
        </div>`;}).join('')}
      </div>
      <div style="text-align:center;margin-top:20px;position:relative;z-index:1;">${badgeImgs(biz,'center')}</div>
    </div>${ctaBar(biz,content)}</div>`);
}


// ═══════════════════════════════════════════════════════════════════
// 4. REVIEW SHOWCASE — darker cards, real Google logo, SVG stars
// ═══════════════════════════════════════════════════════════════════

function reviewShowcase(content, biz) {
  const accent = biz.design_system?.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const reviews = content.reviews || [];
  const a = getAssets(biz);

  return shell(biz, `<div class="post">
    ${brandBar(biz)}
    <div style="flex:1;background:linear-gradient(180deg,${biz.bg_color||'#0d1b2a'},${biz.primary_color||'#273373'}15);padding:40px 52px;display:flex;flex-direction:column;">
      <div style="text-align:center;margin-bottom:28px;">
        <div style="display:flex;justify-content:center;gap:4px;margin-bottom:10px;">${starsRow(5,28)}</div>
        <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:6px;">
          ${a.google?`<img src="${a.google}" style="width:28px;height:28px;border-radius:50%;"/>`:''}
          <span class="bf" style="font-size:16px;font-weight:700;color:rgba(255,255,255,0.45);text-transform:uppercase;letter-spacing:4px;">Google Reviews</span>
        </div>
        <div class="hf" style="font-size:96px;color:#fff;line-height:1;">${esc(content.headline||'5.0')}</div>
        <div class="bf" style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:4px;margin-top:6px;">Perfect Rating</div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;justify-content:space-evenly;gap:14px;">
        ${reviews.map(r=>`<div style="background:rgba(20,30,60,0.85);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:24px 28px;">
          <div style="display:flex;gap:3px;margin-bottom:10px;">${starsRow(5,16)}</div>
          <div class="bf" style="font-size:17px;font-weight:500;color:rgba(255,255,255,0.88);line-height:1.5;font-style:italic;">"${esc(r.text)}"</div>
          <div style="margin-top:12px;">
            <span class="bf" style="font-size:14px;font-weight:800;color:${accent};text-transform:uppercase;">— ${esc(r.author||'Homeowner')}</span>
            <span class="bf" style="font-size:12px;color:rgba(255,255,255,0.25);margin-left:8px;">Google Review</span>
          </div>
        </div>`).join('')}
      </div>
    </div>${ctaBar(biz,content)}</div>`);
}


// ═══════════════════════════════════════════════════════════════════
// 5. PROCESS STEPS — numbered gradient pills
// ═══════════════════════════════════════════════════════════════════

function processSteps(content, biz, photo) {
  const primary = biz.primary_color || '#273373';
  const secondary = biz.secondary_color || '#115997';
  const accent = biz.accent_color || '#2692cc';
  const items = content.items || [];

  const top = photo
    ? `<div style="flex:0 0 35%;position:relative;overflow:hidden;">
        <img src="${photo}" style="width:100%;height:100%;object-fit:cover;display:block;"/>
        <div style="position:absolute;bottom:0;left:0;right:0;height:75%;background:linear-gradient(0deg,#fff 0%,rgba(255,255,255,0.8) 40%,transparent 100%);"></div>
        <div style="position:absolute;top:24px;left:24px;">${logoCircle(biz,56)}</div>
        <div style="position:absolute;bottom:20px;left:0;right:0;text-align:center;padding:0 48px;">
          ${content.eyebrow?`<div class="bf" style="font-size:16px;font-weight:600;color:${accent};text-transform:uppercase;letter-spacing:4px;margin-bottom:4px;">${esc(content.eyebrow)}</div>`:''}
          <div class="hf" style="font-size:68px;color:${primary};line-height:0.92;">${hl(content.headline, content.highlight_words)}</div>
        </div>
      </div>`
    : `<div style="flex:0 0 18%;background:${primary};display:flex;align-items:center;justify-content:center;padding:32px 48px;text-align:center;">
        <div class="hf" style="font-size:72px;color:#fff;line-height:0.92;">${hl(content.headline, content.highlight_words)}</div>
      </div>`;

  return shell(biz, `<div class="post">${top}
    <div style="flex:1;background:#fff;padding:36px 56px;display:flex;flex-direction:column;">
      ${content.subtext?`<div class="hf" style="font-size:28px;color:${primary};text-align:center;margin-bottom:32px;letter-spacing:3px;">${esc(content.subtext)}</div>`:''}
      <div style="flex:1;display:flex;flex-direction:column;justify-content:space-evenly;">
        ${items.map((it,i)=>{const t=typeof it==='string'?it:it.title||it;const sub=typeof it==='object'?it.subtitle:'';
        return`<div style="display:flex;align-items:flex-start;gap:20px;">
          <div style="width:56px;height:56px;border-radius:14px;flex-shrink:0;background:linear-gradient(135deg,${secondary},${accent});display:flex;align-items:center;justify-content:center;">
            <span class="hf" style="font-size:28px;color:#fff;">${String(i+1).padStart(2,'0')}</span>
          </div>
          <div style="padding-top:6px;">
            <div class="bf" style="font-size:24px;font-weight:800;color:${primary};text-transform:uppercase;">${esc(t)}</div>
            ${sub?`<div class="bf" style="font-size:16px;color:#777;font-weight:500;margin-top:4px;line-height:1.4;">${esc(sub)}</div>`:''}
          </div>
        </div>`;}).join('')}
      </div>
    </div>${ctaBar(biz,content)}</div>`);
}


// ═══════════════════════════════════════════════════════════════════
// 6. STAT CALLOUT — radial glow, massive number
// ═══════════════════════════════════════════════════════════════════

function statCallout(content, biz) {
  const ds = biz.design_system || {};
  const primary = biz.primary_color || '#273373';
  const accent = ds.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const items = content.items || [];

  return shell(biz, `<div class="post">
    <div style="flex:1;background:linear-gradient(160deg,${biz.bg_color||'#0d1b2a'},${primary});display:flex;flex-direction:column;align-items:center;justify-content:center;padding:56px;text-align:center;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;background:radial-gradient(circle at 50% 40%,${primary}50 0%,transparent 50%);"></div>
      <div style="position:absolute;top:28px;left:28px;z-index:2;">${logoCircle(biz,64)}</div>
      <div style="position:absolute;top:24px;right:24px;z-index:2;">${badgeImgs(biz,'corner')}</div>
      <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;width:100%;">
        ${content.eyebrow?`<div class="bf" style="font-size:20px;font-weight:700;color:rgba(255,255,255,0.45);text-transform:uppercase;letter-spacing:5px;margin-bottom:20px;">${esc(content.eyebrow)}</div>`:''}
        <div class="hf" style="font-size:180px;color:${accent};line-height:0.95;text-align:center;">${esc(content.headline)}</div>
        <div style="width:100px;height:4px;background:${accent};margin:28px auto;opacity:0.4;"></div>
        <div class="bf" style="font-size:28px;color:rgba(255,255,255,0.85);font-weight:600;line-height:1.4;max-width:720px;text-align:center;margin:0 auto;">${esc(content.subtext)}</div>
        ${items.length?`<div style="display:flex;justify-content:center;gap:12px;margin-top:32px;flex-wrap:wrap;">
          ${items.map(it=>{const l=typeof it==='string'?it:it.title||it;
          return`<div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:11px 24px;">
            <span class="bf" style="font-size:16px;font-weight:700;color:rgba(255,255,255,0.65);text-transform:uppercase;">${esc(l)}</span>
          </div>`;}).join('')}
        </div>`:''}
        <div style="margin-top:32px;">${badgeImgs(biz,'center')}</div>
      </div>
    </div>${ctaBar(biz,content)}</div>`);
}


// ═══════════════════════════════════════════════════════════════════
// 7. SERVICE HIGHLIGHT — accent gradient bar, service dot list
// ═══════════════════════════════════════════════════════════════════

function serviceHighlight(content, biz) {
  const primary = biz.primary_color || '#273373';
  const accent = biz.design_system?.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const items = content.items || [];

  return shell(biz, `<div class="post">
    ${accentStrip(biz, 8)}
    <div style="flex:1;background:${primary};padding:48px 56px;display:flex;flex-direction:column;text-align:center;position:relative;overflow:hidden;">
      ${decorCircles(accent+'08')}
      <div style="position:relative;z-index:1;">
        ${logoCircle(biz,80)}
        ${content.eyebrow?`<div class="bf" style="font-size:18px;font-weight:700;color:${accent};text-transform:uppercase;letter-spacing:5px;margin:24px 0 8px;">${esc(content.eyebrow)}</div>`:''}
        <div class="hf" style="font-size:88px;color:#fff;line-height:0.92;margin:12px 0 20px;">${hl(content.headline, content.highlight_words)}</div>
        ${content.subtext?`<div class="bf" style="font-size:20px;color:rgba(255,255,255,0.6);line-height:1.5;font-weight:500;max-width:700px;margin:0 auto 28px;">${esc(content.subtext)}</div>`:''}
      </div>
      ${items.length?`<div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:18px;max-width:700px;margin:0 auto;position:relative;z-index:1;">
        ${items.map(it=>{const l=typeof it==='string'?it:it.title||it;
        return`<div style="display:flex;align-items:center;gap:16px;text-align:left;">
          <div style="width:14px;height:14px;border-radius:50%;background:${accent};flex-shrink:0;"></div>
          <div class="bf" style="font-size:24px;font-weight:800;color:#fff;text-transform:uppercase;">${esc(l)}</div>
        </div>`;}).join('')}
      </div>`:''}
      <div style="margin-top:28px;position:relative;z-index:1;">${badgeImgs(biz,'center')}</div>
    </div>${ctaBar(biz,content)}</div>`);
}


// ═══════════════════════════════════════════════════════════════════
// 8. OFFER/COUPON — dashed border, urgency banner
// ═══════════════════════════════════════════════════════════════════

function offerCoupon(content, biz) {
  const ds = biz.design_system || {};
  const primary = biz.primary_color || '#273373';
  const urgency = ds.colors_extended?.urgency || '#C62828';
  const accent = ds.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const items = content.items || [];
  const a = getAssets(biz);

  return shell(biz, `<div class="post">
    <div style="background:${urgency};padding:22px;text-align:center;flex-shrink:0;">
      <div class="bf" style="font-size:22px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:6px;">${esc(content.badge_label||'LIMITED TIME OFFER')}</div>
    </div>
    <div style="flex:1;background:linear-gradient(160deg,${biz.bg_color||'#1a2a6c'},${primary});display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 56px;text-align:center;">
      ${logoCircle(biz,88)}
      <div style="border:3px dashed rgba(255,255,255,0.2);border-radius:20px;padding:40px 60px;margin:28px 0;">
        <div class="hf" style="font-size:144px;color:#fff;line-height:0.85;">${hl(content.headline, content.highlight_words, 'ur')}</div>
        ${content.subtext?`<div class="hf" style="font-size:40px;color:rgba(255,255,255,0.6);margin-top:12px;letter-spacing:4px;">${esc(content.subtext)}</div>`:''}
      </div>
      ${items.length?`<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-bottom:20px;">
        ${items.map(it=>{const l=typeof it==='string'?it:it.title||it;
        return`<div style="background:rgba(132,210,242,0.12);border:1px solid rgba(132,210,242,0.25);border-radius:24px;padding:11px 26px;font-size:16px;font-weight:700;color:${accent};text-transform:uppercase;letter-spacing:1px;font-family:'Montserrat',sans-serif;">${esc(l)}</div>`;}).join('')}
      </div>`:''}
      ${a.greensky?`<div class="bf" style="font-size:16px;color:rgba(255,255,255,0.5);font-weight:600;">Financing through <span style="color:#4CAF50;">GreenSky</span> — plans starting at <span style="color:#4CAF50;">0% interest</span></div>`:''} 
      <div style="margin-top:16px;">${badgeImgs(biz,'center')}</div>
    </div>${ctaBar(biz,content)}</div>`);
}


// ═══════════════════════════════════════════════════════════════════
// 9. WARNING SIGNS — numbered danger list (dark, red accents)
// ═══════════════════════════════════════════════════════════════════

function warningSigns(content, biz) {
  const ds = biz.design_system || {};
  const urgency = ds.colors_extended?.urgency || '#C62828';
  const primary = biz.primary_color || '#273373';
  const items = content.items || [];

  return shell(biz, `<div class="post">
    ${brandBar(biz)}
    ${accentStrip(biz, 4)}
    <div style="flex:1;background:${biz.bg_color||'#0d1b2a'};padding:44px 56px;display:flex;flex-direction:column;position:relative;overflow:hidden;">
      ${decorCircles('rgba(198,40,40,0.04)')}
      <div style="text-align:center;margin-bottom:32px;position:relative;z-index:1;">
        <div style="margin-bottom:12px;">${ICONS.alert(urgency, 44)}</div>
        <div class="hf" style="font-size:78px;color:#fff;line-height:0.92;">${hl(content.headline, content.highlight_words, 'ur')}</div>
        ${content.subtext?`<div class="bf" style="font-size:17px;color:rgba(255,255,255,0.5);margin-top:14px;line-height:1.5;font-weight:500;">${esc(content.subtext)}</div>`:''}
      </div>
      <div style="flex:1;display:flex;flex-direction:column;justify-content:space-evenly;position:relative;z-index:1;">
        ${items.map((it,i)=>{const l=typeof it==='string'?it:it.title||it;const sub=typeof it==='object'?it.subtitle:'';
        return`<div style="display:flex;align-items:flex-start;gap:18px;padding:14px 20px;border-left:3px solid ${urgency};background:rgba(198,40,40,0.06);border-radius:0 10px 10px 0;">
          <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,${urgency},#EF5350);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <span class="hf" style="font-size:22px;color:#fff;">${i+1}</span>
          </div>
          <div style="padding-top:4px;">
            <div class="bf" style="font-size:20px;font-weight:800;color:#fff;text-transform:uppercase;">${esc(l)}</div>
            ${sub?`<div class="bf" style="font-size:14px;color:rgba(255,255,255,0.4);font-weight:500;margin-top:3px;">${esc(sub)}</div>`:''}
          </div>
        </div>`;}).join('')}
      </div>
      <div style="text-align:center;margin-top:16px;position:relative;z-index:1;">${badgeImgs(biz,'center')}</div>
    </div>${ctaBar(biz,content)}</div>`);
}


// ═══════════════════════════════════════════════════════════════════
// 10. DID YOU KNOW — educational fact with big icon
// ═══════════════════════════════════════════════════════════════════

function didYouKnow(content, biz, photo) {
  const primary = biz.primary_color || '#273373';
  const accent = biz.design_system?.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const items = content.items || [];

  const top = photo
    ? `<div style="flex:0 0 40%;position:relative;overflow:hidden;">
        <img src="${photo}" style="width:100%;height:100%;object-fit:cover;display:block;"/>
        <div style="position:absolute;bottom:0;left:0;right:0;height:50%;background:linear-gradient(0deg,${primary} 0%,transparent 100%);"></div>
        <div style="position:absolute;top:24px;left:24px;">${logoCircle(biz,56)}</div>
        <div style="position:absolute;bottom:20px;left:0;right:0;text-align:center;">
          <div class="bf" style="font-size:20px;font-weight:800;color:${accent};text-transform:uppercase;letter-spacing:6px;">Did You Know?</div>
        </div>
      </div>`
    : `<div style="flex:0 0 22%;background:linear-gradient(90deg,${accent},${biz.secondary_color||primary},${primary});display:flex;align-items:center;justify-content:center;position:relative;">
        <div style="position:absolute;left:48px;">${logoCircle(biz,56)}</div>
        <div class="bf" style="font-size:22px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:6px;">Did You Know?</div>
      </div>`;

  return shell(biz, `<div class="post">${top}
    <div style="flex:1;background:${primary};padding:48px 56px;display:flex;flex-direction:column;justify-content:center;text-align:center;">
      <div class="hf" style="font-size:80px;color:#fff;line-height:0.92;margin-bottom:24px;">${hl(content.headline, content.highlight_words)}</div>
      ${content.subtext?`<div class="bf" style="font-size:22px;color:rgba(255,255,255,0.7);line-height:1.6;font-weight:500;max-width:740px;margin:0 auto 28px;">${esc(content.subtext)}</div>`:''}
      ${items.length?`<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:10px;">
        ${items.map(it=>{const l=typeof it==='string'?it:it.title||it;
        return`<div style="background:rgba(132,210,242,0.1);border:1px solid rgba(132,210,242,0.2);border-radius:20px;padding:10px 22px;font-size:15px;font-weight:700;color:${accent};text-transform:uppercase;font-family:'Montserrat',sans-serif;">${esc(l)}</div>`;}).join('')}
      </div>`:''}
      <div style="margin-top:28px;">${badgeImgs(biz,'center')}</div>
    </div>${ctaBar(biz,content)}</div>`);
}


// ═══════════════════════════════════════════════════════════════════
// 11. BRAND INTRO — full service overview, all trust signals
// ═══════════════════════════════════════════════════════════════════

function brandIntro(content, biz) {
  const primary = biz.primary_color || '#273373';
  const accent = biz.design_system?.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const secondary = biz.secondary_color || '#115997';
  const items = content.items || [];
  const stats = content.stats || [];
  const a = getAssets(biz);

  return shell(biz, `<div class="post">
    <div style="flex:0 0 8%;background:linear-gradient(90deg,${accent},${secondary},${primary});flex-shrink:0;"></div>
    <div style="flex:1;background:${primary};padding:48px 56px;display:flex;flex-direction:column;align-items:center;text-align:center;position:relative;overflow:hidden;">
      ${decorCircles(accent+'06')}
      <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;width:100%;">
        ${logoCircle(biz,96)}
        <div class="hf" style="font-size:86px;color:#fff;line-height:0.92;margin:24px 0 12px;">${hl(content.headline, content.highlight_words)}</div>
        ${content.subtext?`<div class="bf" style="font-size:20px;color:rgba(255,255,255,0.6);line-height:1.5;font-weight:500;max-width:700px;margin-bottom:24px;">${esc(content.subtext)}</div>`:''}
        ${items.length?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 24px;text-align:left;margin-bottom:24px;width:100%;max-width:680px;">
          ${items.map(it=>{const l=typeof it==='string'?it:it.title||it;
          return`<div style="display:flex;align-items:center;gap:14px;">
            <div style="width:12px;height:12px;border-radius:50%;background:${accent};flex-shrink:0;"></div>
            <div class="bf" style="font-size:22px;font-weight:800;color:#fff;text-transform:uppercase;">${esc(l)}</div>
          </div>`;}).join('')}
        </div>`:''}
        ${stats.length?`<div style="display:flex;justify-content:space-around;width:100%;margin:12px 0;">
          ${stats.map(s=>`<div style="text-align:center;">
            <div class="hf" style="font-size:56px;color:${accent};line-height:1;">${esc(s.value)}</div>
            <div class="bf" style="font-size:12px;color:rgba(255,255,255,0.45);text-transform:uppercase;letter-spacing:2px;margin-top:4px;font-weight:700;">${esc(s.label)}</div>
          </div>`).join('')}
        </div>`:''}
        <div style="margin-top:20px;">${badgeImgs(biz,'center')}</div>
      </div>
    </div>${ctaBar(biz,content)}</div>`);
}


// ═══════════════════════════════════════════════════════════════════
// 12. SPLIT FEATURE — two-tone layout, left accent + right content
// ═══════════════════════════════════════════════════════════════════

function splitFeature(content, biz, photo) {
  const primary = biz.primary_color || '#273373';
  const accent = biz.design_system?.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const items = content.items || [];

  const left = photo
    ? `<div style="flex:0 0 42%;position:relative;overflow:hidden;">
        <img src="${photo}" style="width:100%;height:100%;object-fit:cover;display:block;"/>
        <div style="position:absolute;top:0;left:0;right:0;bottom:0;background:${primary}88;"></div>
        <div style="position:absolute;top:28px;left:28px;">${logoCircle(biz,56)}</div>
        <div style="position:absolute;bottom:0;left:0;right:0;padding:32px;text-align:center;">
          <div class="hf" style="font-size:72px;color:#fff;line-height:0.9;">${hl(content.headline, content.highlight_words)}</div>
        </div>
      </div>`
    : `<div style="flex:0 0 42%;background:linear-gradient(180deg,${biz.bg_color||'#0d1b2a'},${primary});display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center;position:relative;overflow:hidden;">
        ${decorCircles(accent+'10')}
        <div style="position:relative;z-index:1;">
          ${logoCircle(biz,72)}
          <div class="hf" style="font-size:72px;color:#fff;line-height:0.9;margin-top:24px;">${hl(content.headline, content.highlight_words)}</div>
        </div>
      </div>`;

  return shell(biz, `<div class="post">${left}
    <div style="flex:1;background:#fff;padding:40px 48px;display:flex;flex-direction:column;justify-content:center;">
      ${content.subtext?`<div class="bf" style="font-size:20px;color:#555;line-height:1.6;font-weight:500;margin-bottom:28px;">${esc(content.subtext)}</div>`:''}
      ${items.length?`<div style="display:flex;flex-direction:column;gap:16px;">
        ${items.map((it,i)=>{const t=typeof it==='string'?it:it.title||it;const sub=typeof it==='object'?it.subtitle:'';const ic=ICON_ROTATION[i%ICON_ROTATION.length];
        return`<div style="display:flex;align-items:flex-start;gap:16px;">
          <div style="width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,${primary},${biz.secondary_color||primary});display:flex;align-items:center;justify-content:center;flex-shrink:0;">${ICONS[ic]('#fff',22)}</div>
          <div style="padding-top:2px;">
            <div class="bf" style="font-size:20px;font-weight:800;color:${primary};text-transform:uppercase;">${esc(t)}</div>
            ${sub?`<div class="bf" style="font-size:14px;color:#888;font-weight:500;margin-top:3px;line-height:1.4;">${esc(sub)}</div>`:''}
          </div>
        </div>`;}).join('')}
      </div>`:''}
      <div style="margin-top:24px;">${badgeImgs(biz,'center')}</div>
    </div>${ctaBar(biz,content)}</div>`);
}


// ═══════════════════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════════════════

const TEMPLATES = {
  photo_hero:        { render: photoHero, photo: true },
  full_graphic:      { render: fullGraphic, photo: false },
  checklist:         { render: checklist, photo: false },
  review_showcase:   { render: reviewShowcase, photo: false },
  process_steps:     { render: processSteps, photo: true },
  stat_callout:      { render: statCallout, photo: false },
  service_highlight: { render: serviceHighlight, photo: false },
  offer_coupon:      { render: offerCoupon, photo: false },
  warning_signs:     { render: warningSigns, photo: false },
  did_you_know:      { render: didYouKnow, photo: true },
  brand_intro:       { render: brandIntro, photo: false },
  split_feature:     { render: splitFeature, photo: true },
};

function renderTemplate(id, content, biz, photo) {
  const tpl = TEMPLATES[id || 'full_graphic'];
  if (!tpl) return fullGraphic(content, biz);
  return tpl.render(content, biz, photo);
}

module.exports = { TEMPLATES, renderTemplate };