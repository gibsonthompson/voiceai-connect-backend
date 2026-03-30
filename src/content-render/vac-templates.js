/**
 * VoiceAI Connect — Template System
 * 
 * Two layout systems matching the approved social media posts:
 * 
 * STYLE A (Centered): Logo top, emerald divider, symmetric glass cards
 *   → brand_intro, service_highlight, stat_callout (centered variant)
 * 
 * STYLE B (Editorial): Category pill top-left, left-aligned massive headlines,
 *   numbered glass cards, footer with tagline + URL
 *   → full_graphic, checklist, split_feature, did_you_know, process_steps
 * 
 * Design tokens:
 *   BG: #050505 (flat, no gradients)
 *   Text: #fafaf9 primary, opacity layers for hierarchy
 *   Accent: #10b981 emerald (ONLY color)
 *   Negative: #ef4444 red (problems/before states only)
 *   Font: Plus Jakarta Sans 400-900, Space Mono for labels
 *   Cards: rgba(255,255,255,0.03) bg, rgba(255,255,255,0.06) border
 */

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── SVG Logo (waveform icon in rounded square) ──────────────────
const VAC_LOGO = `<div style="width:56px;height:56px;border-radius:14px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;">
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
    <rect x="3" y="8" width="2" height="8" rx="1" fill="rgba(255,255,255,0.5)"/>
    <rect x="7" y="5" width="2" height="14" rx="1" fill="rgba(255,255,255,0.7)"/>
    <rect x="11" y="3" width="2" height="18" rx="1" fill="#fff"/>
    <rect x="15" y="5" width="2" height="14" rx="1" fill="rgba(255,255,255,0.7)"/>
    <rect x="19" y="8" width="2" height="8" rx="1" fill="rgba(255,255,255,0.5)"/>
  </svg>
</div>`;

const VAC_LOGO_SM = `<div style="width:44px;height:44px;border-radius:11px;border:1px dashed rgba(255,255,255,0.12);background:transparent;display:flex;align-items:center;justify-content:center;">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
    <rect x="3" y="8" width="2" height="8" rx="1" fill="rgba(255,255,255,0.3)"/>
    <rect x="7" y="5" width="2" height="14" rx="1" fill="rgba(255,255,255,0.5)"/>
    <rect x="11" y="3" width="2" height="18" rx="1" fill="rgba(255,255,255,0.7)"/>
    <rect x="15" y="5" width="2" height="14" rx="1" fill="rgba(255,255,255,0.5)"/>
    <rect x="19" y="8" width="2" height="8" rx="1" fill="rgba(255,255,255,0.3)"/>
  </svg>
</div>`;

const EMERALD = '#10b981';
const RED = '#ef4444';

// ── Shared SVG icons (emerald stroke) ───────────────────────────
const VAC_ICONS = {
  check: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${EMERALD}" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  phone: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${EMERALD}" stroke-width="1.8" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>`,
  calendar: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${EMERALD}" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  message: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${EMERALD}" stroke-width="1.8" stroke-linecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>`,
  tag: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${EMERALD}" stroke-width="1.8" stroke-linecap="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
  trending: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${EMERALD}" stroke-width="1.8" stroke-linecap="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
  zap: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${EMERALD}" stroke-width="1.8" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  home: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${EMERALD}" stroke-width="1.8" stroke-linecap="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>`,
  x: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
};
const ICON_KEYS = Object.keys(VAC_ICONS).filter(k => k !== 'x' && k !== 'check');

// ── Emerald divider ─────────────────────────────────────────────
const DIVIDER = `<div style="width:48px;height:3px;background:${EMERALD};border-radius:2px;"></div>`;

// ── Base shell ──────────────────────────────────────────────────
function vacShell(body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&family=Space+Mono:wght@400;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{width:1080px;height:1350px;overflow:hidden;background:#050505;}
.post{width:1080px;height:1350px;display:flex;flex-direction:column;overflow:hidden;position:relative;background:#050505;color:#fafaf9;font-family:'Plus Jakarta Sans',system-ui,sans-serif;}
.mono{font-family:'Space Mono',monospace;letter-spacing:0.05em;}
.glass{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:14px;}
.glass-bright{background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);border-radius:14px;}
.em{color:${EMERALD};}
.red{color:${RED};}
.dim{color:rgba(250,250,249,0.4);}
.muted{color:rgba(250,250,249,0.55);}
</style></head><body>${body}</body></html>`;
}

// ── Glow background (subtle emerald radial) ─────────────────────
function glow(x, y, size, opacity) {
  return `<div style="position:absolute;${x||'left:50%'};${y||'top:40%'};transform:translate(-50%,-50%);width:${size||600}px;height:${size||600}px;border-radius:50%;background:radial-gradient(circle,rgba(16,185,129,${opacity||0.06}) 0%,transparent 70%);pointer-events:none;"></div>`;
}


// ═══════════════════════════════════════════════════════════════════
// STYLE A: CENTERED SYMMETRIC
// ═══════════════════════════════════════════════════════════════════

// Matches: Post 1 (product shot), Post 9 (start free)
function vacBrandIntro(content, biz) {
  const items = content.items || [];
  const stats = content.stats || [];
  const hl = content.highlight_words || [];
  const headline = esc(content.headline || '');
  const headlineHl = hl.length ? headline.replace(new RegExp(`(${hl.map(w=>esc(w)).join('|')})`, 'gi'), `<span class="em">$1</span>`) : headline;

  return vacShell(`<div class="post">
    ${glow('left:50%','top:35%',700,0.07)}
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 72px;text-align:center;position:relative;z-index:1;">
      ${VAC_LOGO}
      <div style="font-size:20px;font-weight:700;color:#fafaf9;margin-top:16px;letter-spacing:-0.01em;">VoiceAI Connect</div>
      <div style="margin:28px 0;">${DIVIDER}</div>
      <div style="font-size:72px;font-weight:900;line-height:1.05;letter-spacing:-0.045em;max-width:800px;">${headlineHl}</div>
      ${content.subtext?`<div style="font-size:22px;color:rgba(250,250,249,0.5);margin-top:20px;line-height:1.5;max-width:640px;font-weight:400;">${esc(content.subtext)}</div>`:''}
      ${items.length?`<div style="margin-top:36px;display:flex;flex-direction:column;gap:10px;align-items:flex-start;text-align:left;">
        ${items.slice(0,4).map(it=>{const l=typeof it==='string'?it:it.title||it;
        return`<div style="display:flex;align-items:center;gap:12px;">
          <div style="width:22px;height:22px;border-radius:50%;background:rgba(16,185,129,0.15);display:flex;align-items:center;justify-content:center;">${VAC_ICONS.check}</div>
          <span style="font-size:20px;color:rgba(250,250,249,0.7);font-weight:500;">${esc(l)}</span>
        </div>`;}).join('')}
      </div>`:''}
      ${content.cta_line2?`<div style="margin-top:40px;padding:18px 48px;border-radius:999px;background:#fafaf9;color:#050505;font-size:20px;font-weight:700;letter-spacing:-0.01em;">
        <span style="display:flex;align-items:center;gap:8px;"><span style="width:8px;height:8px;border-radius:50%;background:${EMERALD};"></span> ${esc(content.cta_line1||'')} ${esc(content.cta_line2)}</span>
      </div>`:''}
    </div>
    <div style="padding:24px 72px 40px;text-align:center;">
      <div class="mono" style="font-size:15px;color:rgba(250,250,249,0.25);">myvoiceaiconnect.com</div>
    </div>
  </div>`);
}

// Matches: Post 5 (What Clients Get)
function vacServiceHighlight(content, biz) {
  const items = content.items || [];
  const headline = esc(content.headline || '');
  const icons = [VAC_ICONS.phone, VAC_ICONS.calendar, VAC_ICONS.message, VAC_ICONS.tag, VAC_ICONS.zap, VAC_ICONS.home];

  return vacShell(`<div class="post">
    ${glow('left:50%','top:30%',500,0.05)}
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;padding:80px 72px;position:relative;z-index:1;">
      <div style="font-size:56px;font-weight:900;letter-spacing:-0.04em;text-align:center;line-height:1.1;">${headline}</div>
      <div style="margin:32px 0;">${DIVIDER}</div>
      ${items.length?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;width:100%;max-width:780px;margin-top:12px;">
        ${items.slice(0,4).map((it,i)=>{
          const t = typeof it==='string'?it:it.title||it;
          const sub = typeof it==='object'?it.subtitle:'';
          return`<div class="glass" style="padding:36px 28px;text-align:center;">
            <div style="width:44px;height:44px;border-radius:11px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.15);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">${icons[i%icons.length]}</div>
            <div style="font-size:22px;font-weight:800;color:#fafaf9;margin-bottom:8px;">${esc(t)}</div>
            ${sub?`<div style="font-size:15px;color:rgba(250,250,249,0.45);font-weight:400;line-height:1.4;">${esc(sub)}</div>`:''}
          </div>`;}).join('')}
      </div>`:''}
      ${content.subtext?`<div style="font-size:18px;color:rgba(250,250,249,0.45);font-style:italic;margin-top:36px;text-align:center;max-width:640px;">${esc(content.subtext)}</div>`:''}
    </div>
    <div style="padding:20px 72px 40px;text-align:center;">
      ${VAC_LOGO}
      <div class="mono" style="font-size:15px;color:rgba(250,250,249,0.25);margin-top:10px;">myvoiceaiconnect.com</div>
    </div>
  </div>`);
}

// Matches: Post 4 (Revenue Model), Post 6 (62% stat)
function vacStatCallout(content, biz) {
  const items = content.items || [];
  const stats = content.stats || [];
  const headline = esc(content.headline || '');
  // Detect if headline is a negative stat (contains %)
  const isNegative = headline.includes('%') && (content.content_type||'').includes('problem');
  const statColor = isNegative ? RED : EMERALD;

  return vacShell(`<div class="post">
    ${glow('left:50%','top:35%',600, isNegative ? 0 : 0.06)}
    ${isNegative ? `<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:500px;height:500px;border-radius:50%;background:radial-gradient(circle,rgba(239,68,68,0.08) 0%,transparent 70%);pointer-events:none;"></div>` : ''}
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 72px;text-align:center;position:relative;z-index:1;">
      ${content.eyebrow?`<div class="mono" style="font-size:14px;font-weight:700;color:${EMERALD};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:16px;">${esc(content.eyebrow)}</div>`:''}
      <div style="font-size:160px;font-weight:900;color:${statColor};line-height:0.95;letter-spacing:-0.04em;">${headline}</div>
      ${content.subtext?`<div style="font-size:24px;color:rgba(250,250,249,0.5);margin-top:16px;line-height:1.4;max-width:560px;font-weight:400;">${esc(content.subtext)}</div>`:''}
      <div style="margin:28px 0;">${DIVIDER}</div>
      ${stats.length?`<div style="display:flex;gap:20px;margin-top:8px;">
        ${stats.map((s,i)=>{
          const isLast = i === stats.length-1;
          return`<div class="${isLast?'glass-bright':'glass'}" style="padding:24px 36px;text-align:center;min-width:180px;">
            <div style="font-size:36px;font-weight:900;color:${i===0?RED:isLast?EMERALD:'#fafaf9'};letter-spacing:-0.02em;">${esc(s.value)}</div>
            <div style="font-size:13px;color:rgba(250,250,249,0.45);margin-top:6px;font-weight:500;">${esc(s.label)}</div>
          </div>`;}).join('')}
      </div>`:''}
      ${items.length?`<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:24px;justify-content:center;">
        ${items.map(it=>{const l=typeof it==='string'?it:it.title||it;
        return`<div class="glass" style="padding:10px 22px;border-radius:999px;"><span class="mono" style="font-size:13px;color:rgba(250,250,249,0.5);text-transform:uppercase;">${esc(l)}</span></div>`;}).join('')}
      </div>`:''}
    </div>
    <div style="padding:20px 72px 40px;text-align:center;">
      ${VAC_LOGO}
      <div class="mono" style="font-size:15px;color:rgba(250,250,249,0.25);margin-top:10px;">myvoiceaiconnect.com</div>
    </div>
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// STYLE B: EDITORIAL LEFT-ALIGNED
// ═══════════════════════════════════════════════════════════════════

// Top bar for editorial posts
function editorialTop(label) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:40px 56px 0;">
    <div style="display:flex;align-items:center;gap:8px;padding:8px 18px;border:1px solid rgba(255,255,255,0.08);border-radius:6px;">
      <span style="width:6px;height:6px;border-radius:50%;background:${EMERALD};"></span>
      <span class="mono" style="font-size:12px;color:rgba(250,250,249,0.5);text-transform:uppercase;">${esc(label)}</span>
    </div>
    ${VAC_LOGO_SM}
  </div>`;
}

// Footer for editorial posts
function editorialFooter(tagline) {
  return `<div style="display:flex;justify-content:space-between;align-items:flex-end;padding:0 56px 44px;margin-top:auto;">
    <div style="font-size:16px;color:rgba(250,250,249,0.35);">${tagline ? esc(tagline.split('|')[0]?.trim()) : ''} ${tagline && tagline.includes('|') ? `<b style="color:${EMERALD};">${esc(tagline.split('|')[1]?.trim())}</b>` : ''}</div>
    <div class="mono" style="font-size:13px;color:rgba(250,250,249,0.2);">myvoiceaiconnect.com</div>
  </div>`;
}

// Matches: Post 6/post6.png (Not Another CRM)
function vacFullGraphic(content, biz) {
  const items = content.items || [];
  const hl = content.highlight_words || [];
  const headline = esc(content.headline || '');
  const headlineHl = hl.length ? headline.replace(new RegExp(`(${hl.map(w=>esc(w)).join('|')})`, 'gi'), `<span class="em">$1</span>`) : headline;

  // Split headline at first space for dim/bold effect if >2 words
  const words = (content.headline||'').split(' ');
  let headlineRendered = headlineHl;
  if (words.length >= 3) {
    const mid = Math.ceil(words.length / 2);
    const top = words.slice(0, mid).join(' ');
    const bot = words.slice(mid).join(' ');
    headlineRendered = `<span style="color:rgba(250,250,249,0.4);">${esc(top)}</span><br/><b style="color:#fafaf9;">${esc(bot)}</b>`;
    // Re-apply highlight
    if (hl.length) {
      hl.forEach(w => { headlineRendered = headlineRendered.replace(new RegExp(`(${esc(w)})`, 'gi'), `<span class="em">$1</span>`); });
    }
  }

  const eyebrow = content.eyebrow || content.badge_label || content.content_type?.replace(/_/g,' ') || '';
  const tagline = content.cta_line1 ? `${content.cta_line1} | ${content.cta_line2}` : '';

  return vacShell(`<div class="post">
    ${glow('left:30%','top:30%',500,0.04)}
    ${editorialTop(eyebrow)}
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 56px;position:relative;z-index:1;">
      <div style="font-size:80px;font-weight:900;line-height:1.05;letter-spacing:-0.045em;max-width:900px;">${headlineRendered}</div>
      <div style="width:48px;height:3px;background:${EMERALD};border-radius:2px;margin:28px 0;"></div>
      ${content.subtext?`<div style="font-size:26px;font-weight:700;color:${EMERALD};margin-bottom:16px;">${esc(content.subtext)}</div>`:''}
      ${items.length?`<div style="margin-top:8px;">
        ${items.slice(0,4).map(it=>{const l=typeof it==='string'?it:it.title||it;
        return`<div style="font-size:18px;color:rgba(250,250,249,0.3);margin-bottom:8px;">Not ${esc(l)}</div>`;}).join('')}
      </div>`:''}
    </div>
    ${editorialFooter(tagline)}
  </div>`);
}

// Matches: Post 7/post7.png (Zero Fulfillment)
function vacChecklist(content, biz) {
  const items = content.items || [];
  const hl = content.highlight_words || [];
  const headline = esc(content.headline || '');
  const headlineHl = hl.length ? headline.replace(new RegExp(`(${hl.map(w=>esc(w)).join('|')})`, 'gi'), `<span class="em">$1</span>`) : headline;
  const eyebrow = content.eyebrow || content.badge_label || 'HOW IT WORKS';
  const tagline = content.cta_line1 ? `${content.cta_line1} | ${content.cta_line2}` : '';

  return vacShell(`<div class="post">
    ${glow('left:40%','top:20%',500,0.04)}
    ${editorialTop(eyebrow)}
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 56px;position:relative;z-index:1;">
      <div style="font-size:76px;font-weight:900;line-height:1.05;letter-spacing:-0.045em;">${headlineHl}</div>
      ${content.subtext?`<div style="font-size:20px;color:rgba(250,250,249,0.4);margin-top:12px;font-weight:400;">${esc(content.subtext)}</div>`:''}
      ${items.length?`<div class="glass" style="padding:28px 32px;margin-top:32px;">
        ${items.map((it,i)=>{
          const t = typeof it==='string'?it:it.title||it;
          const sub = typeof it==='object'?(it.subtitle||''):'';
          return`<div style="display:flex;align-items:center;gap:16px;padding:16px 0;${i>0?'border-top:1px solid rgba(255,255,255,0.04);':''}">
            <div style="width:28px;height:28px;border-radius:8px;background:rgba(16,185,129,0.12);display:flex;align-items:center;justify-content:center;flex-shrink:0;">${VAC_ICONS.check}</div>
            <div>
              <span style="font-size:19px;font-weight:700;color:#fafaf9;">${esc(t)}</span>
              ${sub?`<span style="font-size:16px;color:rgba(250,250,249,0.4);margin-left:12px;font-weight:400;">${esc(sub)}</span>`:''}
            </div>
          </div>`;}).join('')}
      </div>`:''}
    </div>
    ${editorialFooter(tagline)}
  </div>`);
}

// Matches: Post 8/post8.png (Built For:) and Post 3 (Who It's For)
function vacSplitFeature(content, biz) {
  const items = content.items || [];
  const hl = content.highlight_words || [];
  const headline = esc(content.headline || '');
  const headlineHl = hl.length ? headline.replace(new RegExp(`(${hl.map(w=>esc(w)).join('|')})`, 'gi'), `<span class="em">$1</span>`) : headline;
  const eyebrow = content.eyebrow || 'VOICEAI CONNECT';
  const tagline = content.cta_line1 ? `${content.cta_line1} | ${content.cta_line2}` : '';

  return vacShell(`<div class="post">
    ${glow('left:40%','top:25%',500,0.04)}
    ${editorialTop(eyebrow)}
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 56px;position:relative;z-index:1;">
      <div style="font-size:76px;font-weight:900;line-height:1.05;letter-spacing:-0.045em;">${headlineHl}</div>
      ${content.subtext?`<div style="font-size:20px;color:rgba(250,250,249,0.4);margin-top:12px;font-weight:400;">${esc(content.subtext)}</div>`:''}
      ${items.length?`<div style="display:flex;flex-direction:column;gap:14px;margin-top:32px;">
        ${items.slice(0,4).map((it,i)=>{
          const t = typeof it==='string'?it:it.title||it;
          const sub = typeof it==='object'?(it.subtitle||''):'';
          const num = String(i+1).padStart(2,'0');
          return`<div class="glass" style="padding:24px 28px;display:flex;align-items:center;gap:24px;">
            <span class="mono" style="font-size:20px;font-weight:700;color:rgba(16,185,129,0.5);width:36px;flex-shrink:0;">${num}</span>
            <div>
              <div style="font-size:22px;font-weight:700;color:rgba(250,250,249,0.85);">${esc(t)}</div>
              ${sub?`<div style="font-size:15px;color:rgba(250,250,249,0.4);margin-top:4px;font-weight:400;">${esc(sub)}</div>`:''}
            </div>
          </div>`;}).join('')}
      </div>`:''}
    </div>
    ${editorialFooter(tagline)}
  </div>`);
}

// Matches: Post 3/post3.png (Honest Math) comparison rows
function vacDidYouKnow(content, biz) {
  const items = content.items || [];
  const hl = content.highlight_words || [];
  const headline = esc(content.headline || '');
  const headlineHl = hl.length ? headline.replace(new RegExp(`(${hl.map(w=>esc(w)).join('|')})`, 'gi'), `<span class="em">$1</span>`) : headline;
  const eyebrow = content.eyebrow || 'DID YOU KNOW';
  const tagline = content.cta_line1 ? `${content.cta_line1} | ${content.cta_line2}` : '';

  return vacShell(`<div class="post">
    ${glow('left:50%','top:45%',500,0.04)}
    ${editorialTop(eyebrow)}
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 56px;position:relative;z-index:1;">
      ${items.length?`<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:40px;">
        ${items.slice(0,4).map((it,i)=>{
          const l = typeof it==='string'?it:it.title||it;
          const isLast = i===items.length-1||i===3;
          return`<div class="${isLast?'glass-bright':'glass'}" style="padding:22px 28px;display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:19px;font-weight:600;color:rgba(250,250,249,${isLast?'0.95':'0.7'});">${esc(l)}</span>
          </div>`;}).join('')}
      </div>`:''}
      <div style="font-size:56px;font-weight:900;line-height:1.1;letter-spacing:-0.04em;">${headlineHl}</div>
      ${content.subtext?`<div style="font-size:20px;color:rgba(250,250,249,0.4);margin-top:16px;font-weight:400;line-height:1.5;max-width:700px;">${esc(content.subtext)}</div>`:''}
    </div>
    ${editorialFooter(tagline)}
  </div>`);
}

// Matches: Post 9/post9.png (Funnel diagram)
function vacProcessSteps(content, biz) {
  const items = content.items || [];
  const hl = content.highlight_words || [];
  const headline = esc(content.headline || '');
  const headlineHl = hl.length ? headline.replace(new RegExp(`(${hl.map(w=>esc(w)).join('|')})`, 'gi'), `<span class="em">$1</span>`) : headline;
  const eyebrow = content.eyebrow || 'THE PROCESS';
  const tagline = content.cta_line1 ? `${content.cta_line1} | ${content.cta_line2}` : '';
  // Highlight the middle step (or step 2 if 3 steps)
  const highlightIdx = items.length === 3 ? 1 : Math.floor(items.length / 2);

  return vacShell(`<div class="post">
    ${glow('left:50%','top:30%',500,0.04)}
    ${editorialTop(eyebrow)}
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 56px;position:relative;z-index:1;">
      ${items.length?`<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:40px;position:relative;">
        ${items.slice(0,5).map((it,i)=>{
          const t = typeof it==='string'?it:it.title||it;
          const sub = typeof it==='object'?(it.subtitle||''):'';
          const num = String(i+1).padStart(2,'0');
          const isHl = i===highlightIdx;
          return`<div class="${isHl?'glass-bright':'glass'}" style="padding:24px 28px;display:flex;align-items:center;gap:24px;">
            <span class="mono" style="font-size:22px;font-weight:700;color:${isHl?EMERALD:'rgba(250,250,249,0.25)'};width:40px;flex-shrink:0;">${num}</span>
            <div>
              <div style="font-size:21px;font-weight:700;color:${isHl?EMERALD:'rgba(250,250,249,0.6)'};">${esc(t)}</div>
              ${sub?`<div style="font-size:14px;color:rgba(250,250,249,${isHl?'0.5':'0.3'});margin-top:3px;">${esc(sub)}</div>`:''}
            </div>
            ${isHl?`<div class="mono" style="margin-left:auto;font-size:11px;color:${EMERALD};border:1px solid rgba(16,185,129,0.25);border-radius:5px;padding:4px 12px;text-transform:uppercase;">This is the gap</div>`:''}
          </div>`;}).join('')}
      </div>`:''}
      <div style="font-size:48px;font-weight:900;line-height:1.1;letter-spacing:-0.04em;text-align:center;">${headlineHl}</div>
      ${content.subtext?`<div style="font-size:18px;color:rgba(250,250,249,0.4);margin-top:16px;text-align:center;font-weight:400;line-height:1.5;">${esc(content.subtext)}</div>`:''}
    </div>
    ${editorialFooter(tagline)}
  </div>`);
}

// Matches: Post 7 (Competitive Edge) — before/after comparison
function vacWarningSigns(content, biz) {
  const items = content.items || [];
  const hl = content.highlight_words || [];
  const headline = esc(content.headline || '');
  const headlineHl = hl.length ? headline.replace(new RegExp(`(${hl.map(w=>esc(w)).join('|')})`, 'gi'), `<span class="em">$1</span>`) : headline;

  // Split items into problems (first half) and solutions (second half)
  const mid = Math.ceil(items.length / 2);
  const problems = items.slice(0, mid);
  const solutions = items.slice(mid);

  return vacShell(`<div class="post">
    ${glow('left:50%','top:30%',500,0.04)}
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 72px;text-align:center;position:relative;z-index:1;">
      <div style="font-size:52px;font-weight:900;line-height:1.1;letter-spacing:-0.04em;max-width:800px;">${headlineHl}</div>
      <div style="margin:32px 0;">${DIVIDER}</div>
      <div style="width:100%;max-width:760px;display:flex;flex-direction:column;gap:14px;">
        ${problems.slice(0,2).map(it=>{const l=typeof it==='string'?it:it.title||it;
        return`<div class="glass" style="padding:22px 28px;display:flex;align-items:center;gap:16px;">
          <div style="width:32px;height:32px;border-radius:8px;background:rgba(239,68,68,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;">${VAC_ICONS.x}</div>
          <span style="font-size:19px;color:rgba(250,250,249,0.6);font-weight:500;">${esc(l)}</span>
        </div>`;}).join('')}
        ${solutions.slice(0,2).map(it=>{const l=typeof it==='string'?it:it.title||it;
        return`<div class="glass-bright" style="padding:22px 28px;display:flex;align-items:center;gap:16px;">
          <div style="width:32px;height:32px;border-radius:8px;background:rgba(16,185,129,0.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;">${VAC_ICONS.check}</div>
          <span style="font-size:19px;color:#fafaf9;font-weight:600;">${esc(l)}</span>
        </div>`;}).join('')}
      </div>
      ${content.subtext?`<div style="font-size:24px;font-weight:700;color:${EMERALD};margin-top:32px;line-height:1.4;max-width:600px;">${esc(content.subtext)}</div>`:''}
    </div>
    <div style="padding:20px 72px 40px;text-align:center;">
      ${VAC_LOGO}
      <div class="mono" style="font-size:15px;color:rgba(250,250,249,0.25);margin-top:10px;">myvoiceaiconnect.com</div>
    </div>
  </div>`);
}

// Review showcase — case study style (Post 8 reference)
function vacReviewShowcase(content, biz) {
  const reviews = content.reviews || [];
  const stats = content.stats || [];
  const headline = esc(content.headline || '');

  return vacShell(`<div class="post">
    ${glow('left:50%','top:30%',500,0.04)}
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 72px;text-align:center;position:relative;z-index:1;">
      ${content.eyebrow?`<div class="mono" style="font-size:14px;font-weight:700;color:${EMERALD};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:14px;">${esc(content.eyebrow)}</div>`:''}
      <div style="font-size:48px;font-weight:900;letter-spacing:-0.04em;line-height:1.1;max-width:800px;">${headline}</div>
      <div style="margin:28px 0;">${DIVIDER}</div>
      ${stats.length?`<div style="display:flex;gap:20px;margin-bottom:28px;">
        ${stats.map((s,i)=>`<div class="glass" style="padding:24px 36px;text-align:center;min-width:160px;">
          <div style="font-size:36px;font-weight:900;color:${i===0?RED:i===stats.length-1?EMERALD:'#fafaf9'};letter-spacing:-0.02em;">${esc(s.value)}</div>
          <div style="font-size:13px;color:rgba(250,250,249,0.45);margin-top:6px;">${esc(s.label)}</div>
        </div>`).join('')}
      </div>`:''}
      ${reviews.length?`<div style="margin-top:8px;">
        ${reviews.slice(0,2).map(r=>`<div style="font-size:18px;color:rgba(250,250,249,0.5);font-style:italic;line-height:1.5;margin-bottom:12px;max-width:700px;">"${esc(r.text)}"</div>
        <div style="font-size:14px;color:rgba(250,250,249,0.3);margin-bottom:16px;">— ${esc(r.author)}</div>`).join('')}
      </div>`:''}
    </div>
    <div style="padding:20px 72px 40px;text-align:center;">
      ${VAC_LOGO}
      <div class="mono" style="font-size:15px;color:rgba(250,250,249,0.25);margin-top:10px;">myvoiceaiconnect.com</div>
    </div>
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// LINKEDIN — SIMPLE GRAPHIC (caption is the content, graphic is the hook)
// 1200x628 landscape — LinkedIn native card format
// ═══════════════════════════════════════════════════════════════════

function vacLinkedInShell(body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&family=Space+Mono:wght@400;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{width:1200px;height:628px;overflow:hidden;background:#050505;}
.post{width:1200px;height:628px;display:flex;flex-direction:column;overflow:hidden;position:relative;background:#050505;color:#fafaf9;font-family:'Plus Jakarta Sans',system-ui,sans-serif;}
.mono{font-family:'Space Mono',monospace;letter-spacing:0.05em;}
.em{color:${EMERALD};}
</style></head><body>${body}</body></html>`;
}

function vacLinkedIn(content, biz) {
  const hl = content.highlight_words || [];
  const headline = esc(content.headline || '');
  let headlineHl = headline;
  if (hl.length) {
    hl.forEach(w => { headlineHl = headlineHl.replace(new RegExp(`(${esc(w)})`, 'gi'), `<span class="em">$1</span>`); });
  }

  return vacLinkedInShell(`<div class="post">
    ${glow('left:50%','top:50%',500,0.06)}
    <div style="flex:1;display:flex;align-items:center;padding:0 80px;position:relative;z-index:1;">
      <div style="flex:1;">
        <div style="font-size:52px;font-weight:900;line-height:1.1;letter-spacing:-0.04em;max-width:800px;">${headlineHl}</div>
        ${content.subtext?`<div style="font-size:20px;color:rgba(250,250,249,0.45);margin-top:16px;line-height:1.5;max-width:640px;font-weight:400;">${esc(content.subtext)}</div>`:''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px;flex-shrink:0;margin-left:40px;">
        ${VAC_LOGO}
        <div class="mono" style="font-size:11px;color:rgba(250,250,249,0.2);">myvoiceaiconnect.com</div>
      </div>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,${EMERALD},transparent);"></div>
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════════════════

const VAC_TEMPLATES = {
  brand_intro:       vacBrandIntro,
  full_graphic:      vacFullGraphic,
  checklist:         vacChecklist,
  stat_callout:      vacStatCallout,
  service_highlight: vacServiceHighlight,
  split_feature:     vacSplitFeature,
  did_you_know:      vacDidYouKnow,
  process_steps:     vacProcessSteps,
  warning_signs:     vacWarningSigns,
  review_showcase:   vacReviewShowcase,
  // Fallbacks for templates VoiceAI shouldn't get but might
  photo_hero:        vacBrandIntro,
  offer_coupon:      vacStatCallout,
};

function renderVacTemplate(templateId, content, biz, options = {}) {
  if (options.platform === 'linkedin') {
    return vacLinkedIn(content, biz);
  }
  const fn = VAC_TEMPLATES[templateId] || vacFullGraphic;
  return fn(content, biz);
}

module.exports = { VAC_TEMPLATES, renderVacTemplate };