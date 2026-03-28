/**
 * HTML Template Rendering System (CommonJS)
 * 
 * Produces 1080x1350 HTML documents for Puppeteer screenshot.
 * Fonts load from Google Fonts with generous wait time.
 * All templates use the three-zone flex architecture.
 */

// ── Utilities ──────────────────────────────────────────────────────

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlight(text, words, cls) {
  if (!words || !words.length || !text) return esc(text || '');
  let result = esc(text);
  (words || []).forEach(w => {
    const e = esc(w);
    result = result.replace(new RegExp(`(${e})`, 'gi'), `<span class="${cls || 'hl'}">\$1</span>`);
  });
  return result;
}

// ── Base HTML Shell ────────────────────────────────────────────────

function shell(biz, body) {
  const ds = biz.design_system || {};
  const f = ds.fonts || {};
  const hf = f.headline?.family || 'Bebas Neue';
  const bf = f.body?.family || 'Montserrat';
  const ht = f.headline?.transform || 'uppercase';
  const hls = f.headline?.letter_spacing || '2px';
  const urgency = ds.colors_extended?.urgency || '#C62828';
  const accentLight = ds.colors_extended?.accent_light || biz.accent_color || '#84d2f2';

  // Build font import
  const families = [];
  if (hf) families.push(hf.replace(/ /g, '+'));
  if (bf && bf !== hf) families.push(bf.replace(/ /g, '+') + ':wght@400;500;600;700;800;900');
  const fontImport = families.length > 0
    ? `@import url('https://fonts.googleapis.com/css2?family=${families.join('&family=')}&display=swap');`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
${fontImport}
* { margin:0; padding:0; box-sizing:border-box; }
body { width:1080px; height:1350px; overflow:hidden; }
.post { width:1080px; height:1350px; display:flex; flex-direction:column; overflow:hidden; position:relative; }
.hf { font-family:'${hf}','Bebas Neue','Impact',sans-serif; text-transform:${ht}; letter-spacing:${hls}; }
.bf { font-family:'${bf}','Montserrat','Segoe UI',sans-serif; }
.hl { color:${accentLight}; }
.ur { color:${urgency}; }
</style></head><body>${body}</body></html>`;
}

// ── CTA Bar (appears on every post) ────────────────────────────────

function ctaBar(biz, content) {
  const ds = biz.design_system || {};
  if (!ds.cta_bar?.enabled) return '';
  const grad = ds.cta_bar?.bg_gradient || ds.gradients?.cta || 'linear-gradient(135deg,#C62828,#B71C1C)';
  const phone = ds.cta_bar?.phone || '';
  const l1 = esc(content.cta_line1 || '');
  const l2 = esc(content.cta_line2 || content.cta || 'FREE ESTIMATE');

  return `<div style="background:${grad};padding:30px 52px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
    <div>
      ${l1 ? `<div class="bf" style="font-size:20px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:2px;">${l1}</div>` : ''}
      <div class="hf" style="font-size:48px;color:#fff;line-height:1;">${l2}</div>
    </div>
    ${phone ? `<div class="hf" style="font-size:50px;color:#fff;">${esc(phone)}</div>` : ''}
  </div>`;
}

// ── Brand Strip ────────────────────────────────────────────────────

function brandStrip(biz) {
  const ds = biz.design_system || {};
  const accent = ds.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const logoUrl = ds.logo_url || '';

  return `<div style="background:${biz.primary_color || '#273373'};padding:22px 48px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
    <div style="display:flex;align-items:center;gap:14px;">
      ${logoUrl ? `<div style="width:48px;height:48px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.2);"><img src="${logoUrl}" style="width:36px;height:36px;object-fit:contain;" /></div>` : ''}
      <div class="hf" style="font-size:24px;color:#fff;letter-spacing:3px;">${esc(biz.name.toUpperCase())}</div>
    </div>
    ${biz.website ? `<div class="bf" style="font-size:14px;color:${accent};font-weight:600;">@${esc(biz.website.replace('www.','').replace('.com',''))}</div>` : ''}
  </div>`;
}

// ── Trust Badges ───────────────────────────────────────────────────

function badges(biz, dark) {
  const list = biz.design_system?.trust_badges || [];
  if (!list.length) return '';
  const bg = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
  const bdr = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';
  const col = dark ? 'rgba(255,255,255,0.75)' : '#444';
  return `<div style="display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;">
    ${list.map(b => `<div style="background:${bg};border:1px solid ${bdr};border-radius:6px;padding:7px 16px;font-size:12px;font-weight:700;color:${col};text-transform:uppercase;letter-spacing:1px;font-family:'Montserrat',sans-serif;">${esc(b)}</div>`).join('')}
  </div>`;
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: PHOTO HERO
// ═══════════════════════════════════════════════════════════════════

function photoHero(content, biz, photo) {
  const ds = biz.design_system || {};
  const primary = biz.primary_color || '#273373';
  const accent = ds.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const stats = content.stats || [];
  const items = content.items || [];
  const logoUrl = ds.logo_url || '';

  const photoHTML = photo
    ? `<div style="flex:0 0 55%;position:relative;overflow:hidden;">
        <img src="${photo}" style="width:100%;height:100%;object-fit:cover;display:block;" />
        <div style="position:absolute;bottom:0;left:0;right:0;height:65%;background:linear-gradient(0deg,${primary} 0%,${primary}CC 30%,transparent 100%);"></div>
        ${logoUrl ? `<div style="position:absolute;top:28px;left:28px;width:64px;height:64px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(0,0,0,0.3);"><img src="${logoUrl}" style="width:48px;height:48px;object-fit:contain;" /></div>` : ''}
        <div style="position:absolute;top:24px;right:24px;display:flex;gap:8px;">
          ${(biz.design_system?.trust_badges || []).slice(0, 2).map(b => `<div style="background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.2);border-radius:5px;padding:5px 12px;font-size:11px;font-weight:700;color:#fff;text-transform:uppercase;letter-spacing:1px;font-family:'Montserrat',sans-serif;">${esc(b)}</div>`).join('')}
        </div>
        <div style="position:absolute;bottom:32px;left:48px;right:48px;">
          <div class="hf" style="font-size:76px;color:#fff;line-height:0.92;">${highlight(content.headline, content.highlight_words, 'hl')}</div>
        </div>
      </div>`
    : `<div style="flex:0 0 40%;background:linear-gradient(160deg,${biz.bg_color || '#1a2a6c'},${primary});display:flex;align-items:flex-end;padding:40px 48px;">
        <div class="hf" style="font-size:80px;color:#fff;line-height:0.92;">${highlight(content.headline, content.highlight_words, 'hl')}</div>
      </div>`;

  return shell(biz, `<div class="post">
    ${photoHTML}
    <div style="flex:1;background:${primary};padding:36px 48px;display:flex;flex-direction:column;justify-content:center;">
      ${content.subtext ? `<div style="text-align:center;margin-bottom:20px;">
        <div style="width:48px;height:3px;background:${accent};margin:0 auto 14px;"></div>
        <div class="bf" style="font-size:18px;color:rgba(255,255,255,0.75);line-height:1.5;font-weight:500;">${esc(content.subtext)}</div>
      </div>` : ''}
      ${stats.length > 0 ? `<div style="display:flex;justify-content:space-around;margin-top:8px;">
        ${stats.map(s => `<div style="text-align:center;">
          <div class="hf" style="font-size:64px;color:${accent};line-height:1;">${esc(s.value)}</div>
          <div class="bf" style="font-size:13px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:2px;margin-top:6px;font-weight:700;">${esc(s.label)}</div>
        </div>`).join('')}
      </div>` : ''}
      ${items.length > 0 ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px 28px;margin-top:12px;">
        ${items.map(item => {
          const title = typeof item === 'string' ? item : item.title || item;
          const sub = typeof item === 'object' ? item.subtitle : '';
          return `<div style="display:flex;align-items:center;gap:12px;">
            <div style="width:38px;height:38px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:15px;color:#fff;">&#10003;</div>
            <div>
              <div class="bf" style="font-size:16px;font-weight:800;color:#fff;text-transform:uppercase;">${esc(title)}</div>
              ${sub ? `<div class="bf" style="font-size:12px;color:rgba(255,255,255,0.45);font-weight:500;">${esc(sub)}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>` : ''}
    </div>
    ${ctaBar(biz, content)}
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: FULL GRAPHIC
// ═══════════════════════════════════════════════════════════════════

function fullGraphic(content, biz) {
  const ds = biz.design_system || {};
  const primary = biz.primary_color || '#273373';
  const accent = ds.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const urgency = ds.colors_extended?.urgency || '#C62828';
  const items = content.items || [];
  const badge = content.badge_label || '';
  const logoUrl = ds.logo_url || '';

  return shell(biz, `<div class="post">
    ${badge ? `<div style="background:${urgency};padding:22px;text-align:center;flex-shrink:0;">
      <div class="bf" style="font-size:20px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:6px;">${esc(badge)}</div>
    </div>` : ''}
    <div style="flex:1;background:linear-gradient(160deg,${biz.bg_color || '#1a2a6c'},${primary});display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 56px;text-align:center;">
      ${logoUrl ? `<div style="width:80px;height:80px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;margin-bottom:28px;box-shadow:0 4px 24px rgba(0,0,0,0.3);"><img src="${logoUrl}" style="width:56px;height:56px;object-fit:contain;" /></div>` : ''}
      <div class="hf" style="font-size:96px;color:#fff;line-height:0.92;margin-bottom:12px;">${highlight(content.headline, content.highlight_words, 'hl')}</div>
      ${content.subtext ? `<div class="bf" style="font-size:20px;color:rgba(255,255,255,0.65);margin-top:14px;line-height:1.5;max-width:780px;font-weight:500;">${esc(content.subtext)}</div>` : ''}
      ${items.length > 0 ? `<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-top:32px;">
        ${items.map(item => {
          const label = typeof item === 'string' ? item : item.title || item;
          return `<div style="background:rgba(${parseInt((accent).slice(1,3),16)},${parseInt((accent).slice(3,5),16)},${parseInt((accent).slice(5,7),16)},0.12);border:1px solid rgba(${parseInt((accent).slice(1,3),16)},${parseInt((accent).slice(3,5),16)},${parseInt((accent).slice(5,7),16)},0.25);border-radius:24px;padding:11px 26px;font-size:16px;font-weight:700;color:${accent};text-transform:uppercase;letter-spacing:1px;font-family:'Montserrat',sans-serif;">${esc(label)}</div>`;
        }).join('')}
      </div>` : ''}
      <div style="margin-top:28px;">${badges(biz, true)}</div>
    </div>
    ${ctaBar(biz, content)}
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: CHECKLIST
// ═══════════════════════════════════════════════════════════════════

function checklist(content, biz) {
  const ds = biz.design_system || {};
  const urgency = ds.colors_extended?.urgency || '#C62828';
  const accent = ds.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const items = content.items || [];
  const badge = content.badge_label || '';

  return shell(biz, `<div class="post">
    ${brandStrip(biz)}
    <div style="flex:1;background:${biz.bg_color || '#0d1b2a'};padding:44px 56px;display:flex;flex-direction:column;position:relative;">
      ${badge ? `<div style="position:absolute;top:-62px;right:48px;background:${urgency};border-radius:6px;padding:8px 18px;z-index:2;">
        <div class="bf" style="font-size:13px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:2px;">${esc(badge)}</div>
      </div>` : ''}
      <div style="text-align:center;margin-bottom:28px;">
        <div class="hf" style="font-size:76px;color:#fff;line-height:0.92;">${highlight(content.headline, content.highlight_words, 'ur')}</div>
        ${content.subtext ? `<div class="bf" style="font-size:17px;color:rgba(255,255,255,0.55);margin-top:16px;line-height:1.5;font-weight:500;max-width:700px;margin-left:auto;margin-right:auto;">${esc(content.subtext)}</div>` : ''}
      </div>
      <div style="flex:1;display:flex;flex-direction:column;justify-content:space-evenly;">
        ${items.map(item => {
          const label = typeof item === 'string' ? item : item.title || item;
          return `<div style="display:flex;align-items:center;gap:20px;padding:18px 24px;background:rgba(255,255,255,0.03);border-radius:12px;border:1px solid rgba(255,255,255,0.04);">
            <div style="width:38px;height:38px;border-radius:8px;background:${accent};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              <span style="color:${biz.bg_color || '#0d1b2a'};font-size:18px;font-weight:900;">&#10003;</span>
            </div>
            <div class="bf" style="font-size:22px;font-weight:700;color:#fff;">${esc(label)}</div>
          </div>`;
        }).join('')}
      </div>
      <div style="text-align:center;margin-top:20px;">${badges(biz, true)}</div>
    </div>
    ${ctaBar(biz, content)}
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: REVIEW SHOWCASE
// ═══════════════════════════════════════════════════════════════════

function reviewShowcase(content, biz) {
  const accent = biz.design_system?.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const reviews = content.reviews || [];

  return shell(biz, `<div class="post">
    ${brandStrip(biz)}
    <div style="flex:1;background:linear-gradient(180deg,${biz.bg_color || '#0d1b2a'},${biz.primary_color || '#273373'}22);padding:40px 52px;display:flex;flex-direction:column;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="color:#FBBC04;font-size:24px;letter-spacing:4px;margin-bottom:8px;">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
        <div class="bf" style="font-size:15px;font-weight:700;color:rgba(255,255,255,0.45);text-transform:uppercase;letter-spacing:4px;">Google Reviews</div>
        <div class="hf" style="font-size:96px;color:#fff;line-height:1;margin-top:4px;">${esc(content.headline || '5.0')}</div>
        <div class="bf" style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:4px;margin-top:4px;">Perfect Rating</div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;justify-content:space-evenly;gap:14px;">
        ${reviews.map(r => `<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:24px 28px;">
          <div style="color:#FBBC04;font-size:15px;margin-bottom:10px;">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
          <div class="bf" style="font-size:17px;font-weight:500;color:rgba(255,255,255,0.82);line-height:1.5;font-style:italic;">"${esc(r.text)}"</div>
          <div style="margin-top:10px;">
            <span class="bf" style="font-size:14px;font-weight:800;color:${accent};text-transform:uppercase;">— ${esc(r.author || 'Homeowner')}</span>
            <span class="bf" style="font-size:12px;color:rgba(255,255,255,0.25);margin-left:8px;">Google Review</span>
          </div>
        </div>`).join('')}
      </div>
    </div>
    ${ctaBar(biz, content)}
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: PROCESS STEPS
// ═══════════════════════════════════════════════════════════════════

function processSteps(content, biz, photo) {
  const primary = biz.primary_color || '#273373';
  const secondary = biz.secondary_color || '#115997';
  const accent = biz.accent_color || '#2692cc';
  const ds = biz.design_system || {};
  const items = content.items || [];
  const logoUrl = ds.logo_url || '';

  const photoHTML = photo
    ? `<div style="flex:0 0 35%;position:relative;overflow:hidden;">
        <img src="${photo}" style="width:100%;height:100%;object-fit:cover;display:block;" />
        <div style="position:absolute;bottom:0;left:0;right:0;height:75%;background:linear-gradient(0deg,#fff 0%,rgba(255,255,255,0.8) 40%,transparent 100%);"></div>
        ${logoUrl ? `<div style="position:absolute;top:24px;left:24px;width:56px;height:56px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,0.25);"><img src="${logoUrl}" style="width:40px;height:40px;object-fit:contain;" /></div>` : ''}
        <div style="position:absolute;bottom:20px;left:48px;right:48px;">
          ${content.eyebrow ? `<div class="bf" style="font-size:15px;font-weight:600;color:${accent};text-transform:uppercase;letter-spacing:4px;margin-bottom:4px;">${esc(content.eyebrow)}</div>` : ''}
          <div class="hf" style="font-size:64px;color:${primary};line-height:0.92;">${highlight(content.headline, content.highlight_words, 'hl')}</div>
        </div>
      </div>`
    : `<div style="flex:0 0 18%;background:${primary};display:flex;align-items:center;padding:32px 48px;">
        <div class="hf" style="font-size:68px;color:#fff;line-height:0.92;">${highlight(content.headline, content.highlight_words, 'hl')}</div>
      </div>`;

  return shell(biz, `<div class="post">
    ${photoHTML}
    <div style="flex:1;background:#fff;padding:36px 56px;display:flex;flex-direction:column;">
      ${content.subtext ? `<div class="hf" style="font-size:26px;color:${primary};text-align:center;margin-bottom:28px;letter-spacing:3px;">${esc(content.subtext)}</div>` : ''}
      <div style="flex:1;display:flex;flex-direction:column;justify-content:space-evenly;">
        ${items.map((item, i) => {
          const title = typeof item === 'string' ? item : item.title || item;
          const sub = typeof item === 'object' ? item.subtitle : '';
          return `<div style="display:flex;align-items:flex-start;gap:20px;">
            <div style="width:54px;height:54px;border-radius:14px;flex-shrink:0;background:linear-gradient(135deg,${secondary},${accent});display:flex;align-items:center;justify-content:center;">
              <span class="hf" style="font-size:28px;color:#fff;">${String(i + 1).padStart(2, '0')}</span>
            </div>
            <div style="padding-top:4px;">
              <div class="bf" style="font-size:23px;font-weight:800;color:${primary};text-transform:uppercase;">${esc(title)}</div>
              ${sub ? `<div class="bf" style="font-size:15px;color:#777;font-weight:500;margin-top:4px;line-height:1.4;">${esc(sub)}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
    ${ctaBar(biz, content)}
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: STAT CALLOUT
// ═══════════════════════════════════════════════════════════════════

function statCallout(content, biz) {
  const ds = biz.design_system || {};
  const primary = biz.primary_color || '#273373';
  const accent = ds.colors_extended?.accent_light || biz.accent_color || '#84d2f2';
  const items = content.items || [];

  return shell(biz, `<div class="post">
    <div style="flex:1;background:linear-gradient(160deg,${biz.bg_color || '#0d1b2a'},${primary});display:flex;flex-direction:column;align-items:center;justify-content:center;padding:56px;text-align:center;position:relative;">
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;background:radial-gradient(circle at 50% 40%,${primary}40 0%,transparent 60%);"></div>
      <div style="position:relative;z-index:1;">
        ${content.eyebrow ? `<div class="bf" style="font-size:18px;font-weight:700;color:rgba(255,255,255,0.45);text-transform:uppercase;letter-spacing:5px;margin-bottom:16px;">${esc(content.eyebrow)}</div>` : ''}
        <div class="hf" style="font-size:164px;color:${accent};line-height:1;">${esc(content.headline)}</div>
        <div style="width:100px;height:4px;background:${primary};margin:24px auto;opacity:0.6;"></div>
        <div class="bf" style="font-size:26px;color:rgba(255,255,255,0.8);font-weight:600;line-height:1.4;max-width:700px;">${esc(content.subtext)}</div>
        ${items.length > 0 ? `<div style="display:flex;justify-content:center;gap:12px;margin-top:28px;flex-wrap:wrap;">
          ${items.map(item => {
            const label = typeof item === 'string' ? item : item.title || item;
            return `<div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:10px 22px;">
              <span class="bf" style="font-size:15px;font-weight:700;color:rgba(255,255,255,0.65);text-transform:uppercase;">${esc(label)}</span>
            </div>`;
          }).join('')}
        </div>` : ''}
        <div style="margin-top:28px;">${badges(biz, true)}</div>
      </div>
    </div>
    ${ctaBar(biz, content)}
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════════════════

const TEMPLATES = {
  photo_hero:      { label: 'Photo Hero', render: photoHero, needsPhoto: true },
  full_graphic:    { label: 'Full Graphic', render: fullGraphic, needsPhoto: false },
  checklist:       { label: 'Checklist', render: checklist, needsPhoto: false },
  review_showcase: { label: 'Reviews', render: reviewShowcase, needsPhoto: false },
  process_steps:   { label: 'Process Steps', render: processSteps, needsPhoto: true },
  stat_callout:    { label: 'Stat Callout', render: statCallout, needsPhoto: false },
};

function renderTemplate(templateId, content, biz, photo) {
  const tpl = TEMPLATES[templateId || 'full_graphic'];
  if (!tpl) return fullGraphic(content, biz);
  return tpl.render(content, biz, photo);
}

module.exports = { TEMPLATES, renderTemplate };
