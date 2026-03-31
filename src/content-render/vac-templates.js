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

// ── Logo (actual VoiceAI Connect logo — base64 embedded) ────────
const VAC_LOGO_B64 = 'data:image/png;base64,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';

const VAC_LOGO = `<div style="width:56px;height:56px;border-radius:14px;overflow:hidden;">
  <img src="${VAC_LOGO_B64}" style="width:56px;height:56px;object-fit:cover;border-radius:14px;"/>
</div>`;

const VAC_LOGO_SM = `<div style="width:44px;height:44px;border-radius:11px;overflow:hidden;">
  <img src="${VAC_LOGO_B64}" style="width:44px;height:44px;object-fit:cover;border-radius:11px;"/>
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
      ${content.cta_line2?`<div style="margin-top:44px;padding:22px 56px;border-radius:999px;background:#fafaf9;color:#050505;font-size:24px;font-weight:700;letter-spacing:-0.01em;">
        <span style="display:flex;align-items:center;gap:10px;"><span style="width:10px;height:10px;border-radius:50%;background:${EMERALD};"></span> ${esc(content.cta_line1||'')} ${esc(content.cta_line2)}</span>
      </div>`:''}
    </div>
    <div style="padding:0 72px 52px;text-align:center;">${VAC_LOGO}</div>
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
            ${sub?`<div style="font-size:17px;color:rgba(250,250,249,0.45);font-weight:400;line-height:1.4;">${esc(sub)}</div>`:''}
          </div>`;}).join('')}
      </div>`:''}
      ${content.subtext?`<div style="font-size:18px;color:rgba(250,250,249,0.45);font-style:italic;margin-top:36px;text-align:center;max-width:640px;">${esc(content.subtext)}</div>`:''}
    </div>
    <div style="padding:0 72px 52px;text-align:center;">${VAC_LOGO}</div>
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
      ${content.eyebrow?`<div class="mono" style="font-size:16px;font-weight:700;color:${EMERALD};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:16px;">${esc(content.eyebrow)}</div>`:''}
      <div style="font-size:160px;font-weight:900;color:${statColor};line-height:0.95;letter-spacing:-0.04em;">${headline}</div>
      ${content.subtext?`<div style="font-size:24px;color:rgba(250,250,249,0.5);margin-top:16px;line-height:1.4;max-width:560px;font-weight:400;">${esc(content.subtext)}</div>`:''}
      <div style="margin:28px 0;">${DIVIDER}</div>
      ${stats.length?`<div style="display:flex;gap:20px;margin-top:8px;">
        ${stats.map((s,i)=>{
          const isLast = i === stats.length-1;
          return`<div class="${isLast?'glass-bright':'glass'}" style="padding:24px 36px;text-align:center;min-width:180px;">
            <div style="font-size:36px;font-weight:900;color:${i===0?RED:isLast?EMERALD:'#fafaf9'};letter-spacing:-0.02em;">${esc(s.value)}</div>
            <div style="font-size:16px;color:rgba(250,250,249,0.45);margin-top:6px;font-weight:500;">${esc(s.label)}</div>
          </div>`;}).join('')}
      </div>`:''}
      ${items.length?`<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:24px;justify-content:center;">
        ${items.map(it=>{const l=typeof it==='string'?it:it.title||it;
        return`<div class="glass" style="padding:10px 22px;border-radius:999px;"><span class="mono" style="font-size:16px;color:rgba(250,250,249,0.5);text-transform:uppercase;">${esc(l)}</span></div>`;}).join('')}
      </div>`:''}
    </div>
    <div style="padding:0 72px 52px;text-align:center;">${VAC_LOGO}</div>
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// STYLE B: EDITORIAL LEFT-ALIGNED
// ═══════════════════════════════════════════════════════════════════

// Top bar — clean, no category pill, no small logo
function editorialTop() {
  return `<div style="height:56px;flex-shrink:0;"></div>`;
}

// Footer — just the logo centered, no tiny text
function editorialFooter() {
  return `<div style="display:flex;justify-content:center;align-items:center;padding:0 56px 52px;margin-top:auto;">
    ${VAC_LOGO}
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


  return vacShell(`<div class="post">
    ${glow('left:30%','top:30%',500,0.04)}
    ${editorialTop()}
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 56px;position:relative;z-index:1;">
      <div style="font-size:80px;font-weight:900;line-height:1.05;letter-spacing:-0.045em;max-width:900px;">${headlineRendered}</div>
      <div style="width:48px;height:3px;background:${EMERALD};border-radius:2px;margin:28px 0;"></div>
      ${content.subtext?`<div style="font-size:26px;font-weight:700;color:${EMERALD};margin-bottom:16px;">${esc(content.subtext)}</div>`:''}
      ${items.length?`<div style="margin-top:8px;">
        ${items.slice(0,4).map(it=>{const l=typeof it==='string'?it:it.title||it;
        return`<div style="font-size:18px;color:rgba(250,250,249,0.3);margin-bottom:8px;">Not ${esc(l)}</div>`;}).join('')}
      </div>`:''}
    </div>
    ${editorialFooter()}
  </div>`);
}

// Matches: Post 7/post7.png (Zero Fulfillment)
function vacChecklist(content, biz) {
  const items = content.items || [];
  const hl = content.highlight_words || [];
  const headline = esc(content.headline || '');
  const headlineHl = hl.length ? headline.replace(new RegExp(`(${hl.map(w=>esc(w)).join('|')})`, 'gi'), `<span class="em">$1</span>`) : headline;

  return vacShell(`<div class="post">
    ${glow('left:40%','top:20%',500,0.04)}
    ${editorialTop()}
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
    ${editorialFooter()}
  </div>`);
}

// Matches: Post 8/post8.png (Built For:) and Post 3 (Who It's For)
function vacSplitFeature(content, biz) {
  const items = content.items || [];
  const hl = content.highlight_words || [];
  const headline = esc(content.headline || '');
  const headlineHl = hl.length ? headline.replace(new RegExp(`(${hl.map(w=>esc(w)).join('|')})`, 'gi'), `<span class="em">$1</span>`) : headline;

  return vacShell(`<div class="post">
    ${glow('left:40%','top:25%',500,0.04)}
    ${editorialTop()}
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
              ${sub?`<div style="font-size:17px;color:rgba(250,250,249,0.4);margin-top:4px;font-weight:400;">${esc(sub)}</div>`:''}
            </div>
          </div>`;}).join('')}
      </div>`:''}
    </div>
    ${editorialFooter()}
  </div>`);
}

// Matches: Post 3/post3.png (Honest Math) comparison rows
function vacDidYouKnow(content, biz) {
  const items = content.items || [];
  const hl = content.highlight_words || [];
  const headline = esc(content.headline || '');
  const headlineHl = hl.length ? headline.replace(new RegExp(`(${hl.map(w=>esc(w)).join('|')})`, 'gi'), `<span class="em">$1</span>`) : headline;

  return vacShell(`<div class="post">
    ${glow('left:50%','top:45%',500,0.04)}
    ${editorialTop()}
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
    ${editorialFooter()}
  </div>`);
}

// Matches: Post 9/post9.png (Funnel diagram)
function vacProcessSteps(content, biz) {
  const items = content.items || [];
  const hl = content.highlight_words || [];
  const headline = esc(content.headline || '');
  const headlineHl = hl.length ? headline.replace(new RegExp(`(${hl.map(w=>esc(w)).join('|')})`, 'gi'), `<span class="em">$1</span>`) : headline;
  // Highlight the middle step (or step 2 if 3 steps)
  const highlightIdx = items.length === 3 ? 1 : Math.floor(items.length / 2);

  return vacShell(`<div class="post">
    ${glow('left:50%','top:30%',500,0.04)}
    ${editorialTop()}
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
              ${sub?`<div style="font-size:16px;color:rgba(250,250,249,${isHl?'0.5':'0.3'});margin-top:3px;">${esc(sub)}</div>`:''}
            </div>
            ${isHl?`<div class="mono" style="margin-left:auto;font-size:11px;color:${EMERALD};border:1px solid rgba(16,185,129,0.25);border-radius:5px;padding:4px 12px;text-transform:uppercase;">This is the gap</div>`:''}
          </div>`;}).join('')}
      </div>`:''}
      <div style="font-size:48px;font-weight:900;line-height:1.1;letter-spacing:-0.04em;text-align:center;">${headlineHl}</div>
      ${content.subtext?`<div style="font-size:18px;color:rgba(250,250,249,0.4);margin-top:16px;text-align:center;font-weight:400;line-height:1.5;">${esc(content.subtext)}</div>`:''}
    </div>
    ${editorialFooter()}
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
    <div style="padding:0 72px 52px;text-align:center;">${VAC_LOGO}</div>
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
      ${content.eyebrow?`<div class="mono" style="font-size:16px;font-weight:700;color:${EMERALD};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:14px;">${esc(content.eyebrow)}</div>`:''}
      <div style="font-size:48px;font-weight:900;letter-spacing:-0.04em;line-height:1.1;max-width:800px;">${headline}</div>
      <div style="margin:28px 0;">${DIVIDER}</div>
      ${stats.length?`<div style="display:flex;gap:20px;margin-bottom:28px;">
        ${stats.map((s,i)=>`<div class="glass" style="padding:24px 36px;text-align:center;min-width:160px;">
          <div style="font-size:36px;font-weight:900;color:${i===0?RED:i===stats.length-1?EMERALD:'#fafaf9'};letter-spacing:-0.02em;">${esc(s.value)}</div>
          <div style="font-size:16px;color:rgba(250,250,249,0.45);margin-top:6px;">${esc(s.label)}</div>
        </div>`).join('')}
      </div>`:''}
      ${reviews.length?`<div style="margin-top:8px;">
        ${reviews.slice(0,2).map(r=>`<div style="font-size:18px;color:rgba(250,250,249,0.5);font-style:italic;line-height:1.5;margin-bottom:12px;max-width:700px;">"${esc(r.text)}"</div>
        <div style="font-size:16px;color:rgba(250,250,249,0.3);margin-bottom:16px;">— ${esc(r.author)}</div>`).join('')}
      </div>`:''}
    </div>
    <div style="padding:0 72px 52px;text-align:center;">${VAC_LOGO}</div>
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