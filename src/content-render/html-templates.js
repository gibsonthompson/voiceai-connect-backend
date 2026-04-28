/**
 * Unified Multi-Tenant Template Engine
 * 
 * ONE file renders all template types for ANY business.
 * Visual tokens come from the business's design_system JSONB.
 * Handles both white-background (CallBird) and dark-background (VoiceAI, RSA, GTC) businesses.
 * 
 * Template types:
 *   1. stat_callout    — Large stat number hero
 *   2. checklist       — Headline + checkmark items
 *   3. full_graphic    — Centered headline + pills
 *   4. process_steps   — Numbered "How It Works"
 *   5. faq_card        — Question/answer card
 *   6. cta_card        — Action-oriented with benefits
 *   7. review_showcase — Star rating + testimonials
 * 
 * Usage:
 *   const html = renderTemplate('stat_callout', content, business);
 *   // → complete HTML at 1080×1350, ready for Puppeteer screenshot
 */

// ═══════════════════════════════════════════════════════════════════
// DESIGN TOKEN RESOLVER
// Reads from business.design_system, falls back to sensible defaults
// ═══════════════════════════════════════════════════════════════════

function resolveTokens(biz) {
  const ds = biz.design_system || {};
  const fonts = ds.fonts || {};
  const colors = ds.colors_extended || {};
  const gradients = ds.gradients || {};
  const ctaBar = ds.cta_bar || {};

  // Detect background mode: white if bg_color is light, dark otherwise
  const bg = biz.bg_color || '#ffffff';
  const isLight = isLightColor(bg);

  return {
    // Mode
    isLight,

    // Fonts
    headlineFamily: fonts.headline?.family || 'Inter',
    headlineWeight: fonts.headline?.weight || '700',
    headlineTransform: fonts.headline?.transform || 'none',
    headlineLetterSpacing: fonts.headline?.letter_spacing || '-0.02em',
    bodyFamily: fonts.body?.family || 'Inter',
    bodyWeight: fonts.body?.weight || '400',

    // Colors
    primary: biz.primary_color || '#3B82F6',
    secondary: biz.secondary_color || biz.primary_color || '#3B82F6',
    accent: biz.accent_color || '#F59E0B',
    bgColor: bg,
    textPrimary: isLight ? '#1f2937' : (biz.text_color || '#F1F5F9'),
    textSecondary: isLight ? '#4b5563' : 'rgba(255,255,255,0.7)',
    textTertiary: isLight ? '#6b7280' : 'rgba(255,255,255,0.5)',
    urgency: colors.urgency || '#ef4444',
    success: colors.success || '#10b981',
    border: isLight ? '#e5e7eb' : 'rgba(255,255,255,0.08)',
    cardBg: isLight ? '#f9f9f7' : 'rgba(255,255,255,0.04)',
    cardBorder: isLight ? '#e5e7eb' : 'rgba(255,255,255,0.08)',
    highlightColor: colors.accent_light || biz.accent_color || '#F6B828',

    // Gradients
    headerGradient: gradients.header || (isLight
      ? `linear-gradient(160deg, ${biz.primary_color || '#3B82F6'}, ${biz.secondary_color || '#2563EB'})`
      : `linear-gradient(160deg, ${bg}, ${biz.primary_color || '#1a2744'})`),
    ctaGradient: gradients.cta || ctaBar.bg_gradient || `linear-gradient(135deg, ${biz.primary_color}, ${biz.secondary_color || biz.primary_color})`,
    accentGradient: gradients.accent || `linear-gradient(135deg, ${biz.primary_color}, ${biz.secondary_color || biz.primary_color})`,

    // CTA Bar
    ctaEnabled: ctaBar.enabled !== false,
    ctaPhone: ctaBar.phone || '',
    ctaVariations: ctaBar.cta_variations || [],

    // Trust badges
    trustBadges: ds.trust_badges || [],

    // Brand
    name: biz.name || '',
    website: biz.website || '',
    slug: biz.slug || '',
  };
}

function isLightColor(hex) {
  if (!hex || !hex.startsWith('#')) return true;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128;
}


// ═══════════════════════════════════════════════════════════════════
// SHARED HTML COMPONENTS
// ═══════════════════════════════════════════════════════════════════

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlight(text, words, color) {
  if (!words || !words.length || !text) return esc(text || '');
  let result = esc(text);
  words.forEach(w => {
    const escaped = esc(w);
    const regex = new RegExp(`(${escaped})`, 'gi');
    result = result.replace(regex, `<span style="color:${color}">$1</span>`);
  });
  return result;
}

function shell(t, bodyHTML) {
  // Build Google Fonts URL for both headline and body families
  const families = new Set();
  if (t.headlineFamily) families.add(t.headlineFamily.replace(/ /g, '+') + ':wght@400;600;700;800;900');
  if (t.bodyFamily && t.bodyFamily !== t.headlineFamily) families.add(t.bodyFamily.replace(/ /g, '+') + ':wght@400;500;600;700');
  const fontUrl = families.size > 0
    ? `https://fonts.googleapis.com/css2?family=${[...families].join('&family=')}&display=swap`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
${fontUrl ? `<link href="${fontUrl}" rel="stylesheet">` : ''}
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1080px;height:1350px;overflow:hidden;font-family:'${t.bodyFamily}',sans-serif;background:${t.bgColor}}
  .post{width:1080px;height:1350px;display:flex;flex-direction:column;overflow:hidden;position:relative;background:${t.bgColor}}
  .hf{font-family:'${t.headlineFamily}',sans-serif;font-weight:${t.headlineWeight};text-transform:${t.headlineTransform};letter-spacing:${t.headlineLetterSpacing}}
  .bf{font-family:'${t.bodyFamily}',sans-serif;font-weight:${t.bodyWeight}}
</style></head><body>${bodyHTML}</body></html>`;
}

function ctaBarHTML(t, content) {
  if (!t.ctaEnabled) return '';
  const line1 = content.cta_line1 || '';
  const line2 = content.cta_line2 || 'LEARN MORE';

  return `<div style="background:${t.ctaGradient};padding:32px 56px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
    <div>
      ${line1 ? `<div class="bf" style="font-size:16px;font-weight:600;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:3px;margin-bottom:6px">${esc(line1)}</div>` : ''}
      <div class="hf" style="font-size:36px;color:${t.accent};line-height:1.1">${esc(line2)}</div>
    </div>
    ${t.ctaPhone ? `<div style="text-align:right">
      <div class="bf" style="font-size:12px;font-weight:600;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:2px;margin-bottom:4px">Call now</div>
      <div class="hf" style="font-size:28px;color:white">${esc(t.ctaPhone)}</div>
    </div>` : ''}
  </div>`;
}

function grainSVG(t) {
  const opacity = t.isLight ? 0.025 : 0.05;
  return `<svg style="opacity:${opacity};position:absolute;width:100%;height:100%;top:0;left:0;pointer-events:none;z-index:999"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#g)"/></svg>`;
}

function brandWatermark(t) {
  return `<div style="display:flex;align-items:center;gap:10px;opacity:0.35">
    <div style="width:8px;height:8px;border-radius:50%;background:${t.primary}"></div>
    <span class="bf" style="font-size:13px;font-weight:600;color:${t.isLight ? t.primary : 'white'};text-transform:uppercase;letter-spacing:3px">${esc(t.website || t.name)}</span>
  </div>`;
}

function trustBadgesHTML(t) {
  if (!t.trustBadges.length) return '';
  return `<div style="display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap">
    ${t.trustBadges.map(b => `<div style="background:${t.isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)'};border:1px solid ${t.cardBorder};border-radius:6px;padding:6px 14px;font-size:11px;font-weight:700;color:${t.textTertiary};text-transform:uppercase;letter-spacing:1px">${esc(b)}</div>`).join('')}
  </div>`;
}

// Check icon SVG
function checkSVG(color = 'white', size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE 1: STAT CALLOUT
// ═══════════════════════════════════════════════════════════════════

function statCallout(content, t) {
  const stat = content.headline || '';
  const isDollar = stat.includes('$');
  const isNeg = (content.content_type || '').includes('miss') || (content.content_type || '').includes('pain');
  const statColor = isDollar ? t.accent : isNeg ? t.urgency : t.primary;
  const items = content.items || [];

  return shell(t, `<div class="post">${grainSVG(t)}
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 72px;text-align:center;position:relative">
      <div style="position:absolute;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle,${statColor}08 0%,transparent 70%);top:50%;left:50%;transform:translate(-50%,-60%)"></div>
      ${content.eyebrow ? `<div class="bf" style="font-size:15px;font-weight:700;color:${t.textTertiary};text-transform:uppercase;letter-spacing:5px;margin-bottom:24px;position:relative">${esc(content.eyebrow)}</div>` : ''}
      <div class="hf" style="font-size:180px;color:${statColor};line-height:0.9;position:relative">${esc(stat)}</div>
      <div style="width:80px;height:4px;background:linear-gradient(90deg,${t.primary},${t.accent});margin:36px auto;border-radius:2px"></div>
      <div class="bf" style="font-size:28px;font-weight:500;color:${t.textSecondary};line-height:1.5;max-width:720px">${esc(content.subtext)}</div>
      ${items.length ? `<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-top:40px">${items.map(i => `<div style="background:${t.isLight ? `${t.primary}0D` : 'rgba(255,255,255,0.06)'};border:1px solid ${t.isLight ? `${t.primary}1F` : 'rgba(255,255,255,0.1)'};border-radius:100px;padding:12px 28px"><span class="bf" style="font-size:15px;font-weight:600;color:${t.isLight ? t.primary : t.accent};text-transform:uppercase;letter-spacing:1px">${esc(typeof i === 'string' ? i : i.title || i)}</span></div>`).join('')}</div>` : ''}
      ${t.trustBadges.length ? `<div style="margin-top:28px">${trustBadgesHTML(t)}</div>` : ''}
      <div style="position:absolute;bottom:32px;left:50%;transform:translateX(-50%)">${brandWatermark(t)}</div>
    </div>
    ${ctaBarHTML(t, content)}
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE 2: CHECKLIST
// ═══════════════════════════════════════════════════════════════════

function checklist(content, t) {
  const items = content.items || [];
  const badge = content.badge_label || '';

  return shell(t, `<div class="post">${grainSVG(t)}
    ${badge ? `<div style="background:${t.urgency};padding:16px 56px;text-align:center;flex-shrink:0"><span class="bf" style="font-size:14px;font-weight:800;color:white;text-transform:uppercase;letter-spacing:6px">${esc(badge)}</span></div>` : ''}
    <div style="flex:1;padding:64px 64px 40px;display:flex;flex-direction:column">
      <div style="width:48px;height:5px;background:${t.primary};border-radius:3px;margin-bottom:28px"></div>
      <div class="hf" style="font-size:64px;color:${t.textPrimary};line-height:1.1;margin-bottom:12px">${highlight(content.headline, content.highlight_words, t.primary)}</div>
      ${content.subtext ? `<div class="bf" style="font-size:21px;color:${t.textTertiary};line-height:1.5;margin-bottom:36px;max-width:800px">${esc(content.subtext)}</div>` : '<div style="margin-bottom:24px"></div>'}
      <div style="flex:1;display:flex;flex-direction:column;justify-content:space-evenly;gap:4px">
        ${items.map(i => {
          const text = typeof i === 'string' ? i : i.title || i;
          return `<div style="display:flex;align-items:center;gap:22px;padding:20px 28px;background:${t.cardBg};border-radius:16px;border:1px solid ${t.cardBorder}">
            <div style="width:44px;height:44px;border-radius:12px;flex-shrink:0;background:${t.accentGradient};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px ${t.primary}33">${checkSVG('white', 20)}</div>
            <span class="bf" style="font-size:24px;font-weight:600;color:${t.textPrimary};line-height:1.3">${esc(text)}</span>
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top:24px;display:flex;justify-content:center">${brandWatermark(t)}</div>
    </div>
    ${ctaBarHTML(t, content)}
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE 3: FULL GRAPHIC
// ═══════════════════════════════════════════════════════════════════

function fullGraphic(content, t) {
  const items = content.items || [];
  const badge = content.badge_label || '';

  return shell(t, `<div class="post">${grainSVG(t)}
    <div style="flex:1;display:flex;flex-direction:column;position:relative">
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;background:radial-gradient(circle at 30% 20%,${t.primary}08 0%,transparent 50%),radial-gradient(circle at 70% 80%,${t.accent}08 0%,transparent 50%)"></div>
      ${badge ? `<div style="position:absolute;top:48px;left:50%;transform:translateX(-50%);z-index:2"><div style="background:${t.primary};border-radius:100px;padding:10px 32px"><span class="bf" style="font-size:13px;font-weight:700;color:${t.accent};text-transform:uppercase;letter-spacing:4px">${esc(badge)}</span></div></div>` : ''}
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 72px;text-align:center;position:relative;z-index:1">
        <div class="hf" style="font-size:76px;color:${t.textPrimary};line-height:1.08;max-width:900px;margin-bottom:20px">${highlight(content.headline, content.highlight_words, t.primary)}</div>
        ${content.subtext ? `<div class="bf" style="font-size:24px;color:${t.textTertiary};line-height:1.5;max-width:720px;margin-bottom:40px">${esc(content.subtext)}</div>` : ''}
        ${items.length ? `<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:14px;max-width:800px">${items.map(i => `<div style="background:${t.isLight ? 'white' : 'rgba(255,255,255,0.04)'};border:1.5px solid ${t.cardBorder};border-radius:14px;padding:14px 28px;box-shadow:${t.isLight ? '0 2px 8px rgba(0,0,0,0.04)' : 'none'}"><span class="bf" style="font-size:17px;font-weight:600;color:${t.textPrimary}">${esc(typeof i === 'string' ? i : i.title || i)}</span></div>`).join('')}</div>` : ''}
        <div style="position:absolute;bottom:32px">${brandWatermark(t)}</div>
      </div>
    </div>
    ${ctaBarHTML(t, content)}
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE 4: PROCESS STEPS
// ═══════════════════════════════════════════════════════════════════

function processSteps(content, t) {
  const items = content.items || [];

  return shell(t, `<div class="post">${grainSVG(t)}
    <div style="flex:1;padding:64px 64px 40px;display:flex;flex-direction:column">
      <div style="margin-bottom:40px">
        <div class="bf" style="font-size:14px;font-weight:700;color:${t.accent};text-transform:uppercase;letter-spacing:5px;margin-bottom:14px">${esc(content.eyebrow || 'How It Works')}</div>
        <div class="hf" style="font-size:60px;color:${t.textPrimary};line-height:1.1">${highlight(content.headline, content.highlight_words, t.primary)}</div>
        ${content.subtext ? `<div class="bf" style="font-size:20px;color:${t.textTertiary};margin-top:14px;line-height:1.4">${esc(content.subtext)}</div>` : ''}
      </div>
      <div style="flex:1;display:flex;flex-direction:column;justify-content:space-evenly;gap:8px">
        ${items.map((item, i) => {
          const title = typeof item === 'string' ? item : item.title || item;
          const subtitle = typeof item === 'object' ? item.subtitle : '';
          const isFirst = i === 0;
          return `<div style="display:flex;align-items:flex-start;gap:24px;padding:24px 28px;background:${isFirst ? (t.isLight ? `${t.primary}0A` : 'rgba(255,255,255,0.06)') : t.cardBg};border-radius:20px;border:1px solid ${isFirst ? (t.isLight ? `${t.primary}1F` : 'rgba(255,255,255,0.12)') : t.cardBorder}">
            <div style="width:56px;height:56px;border-radius:16px;flex-shrink:0;background:${isFirst ? t.accentGradient : (t.isLight ? 'white' : 'rgba(255,255,255,0.06)')};border:${isFirst ? 'none' : `2px solid ${t.cardBorder}`};display:flex;align-items:center;justify-content:center;box-shadow:${isFirst ? `0 4px 12px ${t.primary}40` : `0 1px 3px rgba(0,0,0,0.06)`}">
              <span class="hf" style="font-size:24px;color:${isFirst ? 'white' : t.primary}">${String(i + 1).padStart(2, '0')}</span>
            </div>
            <div style="flex:1;padding-top:4px">
              <div class="hf" style="font-size:24px;font-weight:700;color:${t.textPrimary};margin-bottom:${subtitle ? '6px' : '0'}">${esc(title)}</div>
              ${subtitle ? `<div class="bf" style="font-size:17px;color:${t.textTertiary};line-height:1.4">${esc(subtitle)}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top:24px;display:flex;justify-content:center">${brandWatermark(t)}</div>
    </div>
    ${ctaBarHTML(t, content)}
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE 5: FAQ CARD
// ═══════════════════════════════════════════════════════════════════

function faqCard(content, t) {
  return shell(t, `<div class="post">${grainSVG(t)}
    <div style="flex:1;background:${t.cardBg};display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 56px;position:relative">
      <div style="position:absolute;top:-40px;right:-40px;width:280px;height:280px;border-radius:50%;background:${t.primary}08"></div>
      <div style="position:absolute;bottom:-60px;left:-60px;width:320px;height:320px;border-radius:50%;background:${t.accent}08"></div>
      <div style="margin-bottom:32px;z-index:1"><div style="background:${t.primary};border-radius:100px;padding:10px 28px;display:inline-block"><span class="bf" style="font-size:13px;font-weight:700;color:white;text-transform:uppercase;letter-spacing:4px">${esc(content.eyebrow || 'FAQ')}</span></div></div>
      <div style="background:${t.isLight ? 'white' : 'rgba(255,255,255,0.04)'};border-radius:28px;padding:64px 56px;box-shadow:${t.isLight ? '0 4px 6px -1px rgba(0,0,0,0.05),0 20px 50px -12px rgba(0,0,0,0.08)' : '0 8px 32px rgba(0,0,0,0.3)'};border:1px solid ${t.cardBorder};max-width:920px;width:100%;position:relative;z-index:1">
        <div style="position:absolute;top:28px;right:36px;font-size:100px;font-weight:800;color:${t.primary}0A;font-family:'${t.headlineFamily}',sans-serif;line-height:1">?</div>
        <div class="hf" style="font-size:48px;color:${t.textPrimary};line-height:1.15;margin-bottom:28px;position:relative">${highlight(content.headline, content.highlight_words, t.primary)}</div>
        <div style="width:60px;height:4px;background:linear-gradient(90deg,${t.primary},${t.accent});border-radius:2px;margin-bottom:28px"></div>
        <div class="bf" style="font-size:24px;color:${t.textSecondary};line-height:1.6">${esc(content.subtext)}</div>
      </div>
      <div style="margin-top:40px;z-index:1">${brandWatermark(t)}</div>
    </div>
    ${ctaBarHTML(t, content)}
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE 6: CTA CARD
// ═══════════════════════════════════════════════════════════════════

function ctaCard(content, t) {
  const items = content.items || [];

  return shell(t, `<div class="post">${grainSVG(t)}
    <div style="flex:1;display:flex;flex-direction:column;position:relative;overflow:hidden">
      <div style="flex:0 0 45%;background:${t.headerGradient};display:flex;flex-direction:column;justify-content:flex-end;padding:56px 64px;position:relative">
        <div style="position:absolute;top:-60px;right:-60px;width:300px;height:300px;border-radius:50%;background:${t.accent}14"></div>
        <div class="hf" style="font-size:64px;color:${t.isLight ? 'white' : t.textPrimary};line-height:1.08;position:relative;z-index:1">${highlight(content.headline, content.highlight_words, t.accent)}</div>
        ${content.subtext ? `<div class="bf" style="font-size:22px;color:rgba(255,255,255,0.75);line-height:1.4;margin-top:16px;position:relative;z-index:1">${esc(content.subtext)}</div>` : ''}
      </div>
      <div style="flex:1;padding:40px 64px;background:${t.isLight ? 'white' : t.bgColor};display:flex;flex-direction:column;justify-content:center">
        ${items.length ? `<div style="display:flex;flex-direction:column;gap:18px">${items.map(i => `<div style="display:flex;align-items:center;gap:18px">
          <div style="width:36px;height:36px;border-radius:50%;background:${t.success}1A;display:flex;align-items:center;justify-content:center;flex-shrink:0">${checkSVG(t.success, 18)}</div>
          <span class="bf" style="font-size:22px;font-weight:600;color:${t.textPrimary}">${esc(typeof i === 'string' ? i : i.title || i)}</span>
        </div>`).join('')}</div>` : ''}
        ${t.ctaPhone ? `<div style="margin-top:32px;padding:24px 32px;background:${t.accent}14;border:1.5px solid ${t.accent}33;border-radius:16px;text-align:center">
          <div class="bf" style="font-size:15px;font-weight:600;color:${t.textTertiary};text-transform:uppercase;letter-spacing:2px;margin-bottom:6px">Try it right now</div>
          <div class="hf" style="font-size:32px;color:${t.primary}">Call ${esc(t.ctaPhone)}</div>
        </div>` : ''}
        <div style="margin-top:20px;display:flex;justify-content:center">${brandWatermark(t)}</div>
      </div>
    </div>
    ${ctaBarHTML(t, content)}
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE 7: REVIEW SHOWCASE
// ═══════════════════════════════════════════════════════════════════

function reviewShowcase(content, t) {
  const reviews = content.reviews || [];
  const stars = '★★★★★';

  return shell(t, `<div class="post">${grainSVG(t)}
    <div style="flex:1;padding:56px 56px 32px;display:flex;flex-direction:column">
      <div style="text-align:center;margin-bottom:32px">
        <div class="bf" style="font-size:13px;font-weight:700;color:${t.textTertiary};text-transform:uppercase;letter-spacing:5px;margin-bottom:10px">What Customers Say</div>
        <div style="font-size:36px;color:${t.accent};letter-spacing:4px;margin-bottom:8px">${stars}</div>
        <div class="hf" style="font-size:56px;color:${t.textPrimary};line-height:1">${esc(content.headline || '5.0')}</div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;justify-content:space-evenly;gap:16px">
        ${reviews.map(r => `<div style="background:${t.cardBg};border:1px solid ${t.cardBorder};border-radius:20px;padding:28px 32px;position:relative">
          <div style="position:absolute;top:16px;right:24px;font-size:48px;color:${t.primary}0F;font-family:Georgia,serif;line-height:1">"</div>
          <div style="font-size:16px;color:${t.accent};margin-bottom:12px">★★★★★</div>
          <div class="bf" style="font-size:19px;color:${t.textPrimary};line-height:1.5;font-style:italic">"${esc(r.text)}"</div>
          <div style="margin-top:14px;display:flex;align-items:center;gap:10px">
            <div style="width:32px;height:32px;border-radius:50%;background:${t.accentGradient};display:flex;align-items:center;justify-content:center">
              <span style="color:white;font-size:14px;font-weight:700">${esc((r.author || 'A')[0].toUpperCase())}</span>
            </div>
            <span class="bf" style="font-size:15px;font-weight:700;color:${t.primary}">${esc(r.author || 'Customer')}</span>
          </div>
        </div>`).join('')}
      </div>
      <div style="margin-top:20px;display:flex;justify-content:center">${brandWatermark(t)}</div>
    </div>
    ${ctaBarHTML(t, content)}
  </div>`);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE REGISTRY + PUBLIC API
// ═══════════════════════════════════════════════════════════════════

const TEMPLATES = {
  stat_callout:     { render: statCallout },
  checklist:        { render: checklist },
  full_graphic:     { render: fullGraphic },
  process_steps:    { render: processSteps },
  faq_card:         { render: faqCard },
  cta_card:         { render: ctaCard },
  review_showcase:  { render: reviewShowcase },
};

/**
 * Render any template for any business.
 * Reads design tokens from business.design_system.
 * 
 * @param {string} templateId - Template type identifier
 * @param {object} content    - AI-generated content JSON
 * @param {object} business   - Full business profile with design_system
 * @returns {string}          - Complete HTML document at 1080×1350
 */
function renderTemplate(templateId, content, business, photoDataUrl) {
  const tokens = resolveTokens(business);
  const tpl = TEMPLATES[templateId];
  if (!tpl) return fullGraphic(content, tokens); // Fallback
  return tpl.render(content, tokens);
}

module.exports = { renderTemplate, resolveTokens, TEMPLATES, HTML_TEMPLATES: TEMPLATES };