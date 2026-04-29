/**
 * CallBird AI — Custom Templates
 * 
 * Per-business template file. Each template is a full 1080×1350
 * HTML design matching CallBird's brand identity.
 * 
 * Two visual modes:
 *   Dark (#0a1628 navy) — narrative, story, comparison, feature posts
 *   Light (#ffffff white) — stat, data, CTA, urgency posts
 * 
 * Path: src/content-render/callbird-templates.js
 */

const LOGO_B64 = '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';

// ── Highlight words in gold ─────────────────────────────────────
function highlightText(text, highlights) {
  if (!text || !highlights?.length) return text || '';
  let result = text;
  highlights.forEach(word => {
    const regex = new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(regex, `<span class="hl">$1</span>`);
  });
  return result;
}

// ── Shared CSS ──────────────────────────────────────────────────
function baseCSS(mode = 'dark') {
  const isDark = mode === 'dark';
  return `
    @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&family=Inter:wght@400;500;600;700&display=swap');
    
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    .post {
      width: 1080px;
      height: 1350px;
      background: ${isDark ? 'linear-gradient(180deg, #0a1628 0%, #0d1f3c 40%, #0a1628 100%)' : '#ffffff'};
      color: ${isDark ? '#ffffff' : '#1a1a2e'};
      font-family: 'Inter', sans-serif;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
    }
    
    .hl { color: #F6B828; }
    
    .header {
      padding: 48px 64px 0;
      display: flex;
      align-items: center;
      gap: 16px;
      flex-shrink: 0;
    }
    
    .header-logo {
      width: 44px;
      height: 44px;
      border-radius: 10px;
      object-fit: contain;
    }
    
    .header-brand {
      font-family: 'Sora', sans-serif;
      font-size: 24px;
      font-weight: 700;
      color: ${isDark ? '#ffffff' : '#122092'};
      letter-spacing: -0.02em;
    }
    
    .content {
      flex: 1;
      padding: 40px 64px;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
    }
    
    .headline {
      font-family: 'Sora', sans-serif;
      font-weight: 800;
      line-height: 1.05;
      letter-spacing: -0.03em;
      margin-bottom: 24px;
    }
    
    .subtext {
      font-size: 26px;
      line-height: 1.5;
      color: ${isDark ? 'rgba(255,255,255,0.7)' : '#4a4a6a'};
      margin-bottom: 40px;
      font-weight: 400;
    }
    
    .footer {
      height: 88px;
      background: ${isDark ? 'linear-gradient(90deg, #122092, #0d1a5c)' : 'linear-gradient(90deg, #122092, #1a2eb0)'};
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 64px;
      flex-shrink: 0;
    }
    
    .footer-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    
    .footer-dot {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: rgba(255,255,255,0.15);
      border: 2px solid rgba(255,255,255,0.3);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .footer-dot-inner {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #F6B828;
    }
    
    .footer-text {
      font-size: 20px;
      font-weight: 600;
      color: rgba(255,255,255,0.9);
      font-family: 'Sora', sans-serif;
    }
    
    .footer-url {
      font-size: 20px;
      font-weight: 600;
      color: rgba(255,255,255,0.7);
      font-family: 'Inter', sans-serif;
    }
    
    .cta-bar {
      height: 80px;
      background: linear-gradient(90deg, #F6B828 0%, #e8a810 100%);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 64px;
      flex-shrink: 0;
    }
    
    .cta-left {
      font-size: 22px;
      font-weight: 700;
      color: #122092;
      font-family: 'Sora', sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    
    .cta-right {
      font-size: 28px;
      font-weight: 800;
      color: #122092;
      font-family: 'Sora', sans-serif;
      letter-spacing: 0.02em;
    }
  `;
}

// ── Header HTML ─────────────────────────────────────────────────
function headerHTML() {
  return `
    <div class="header">
      <img class="header-logo" src="data:image/png;base64,${LOGO_B64}" alt="CallBird"/>
      <span class="header-brand">CallBird AI</span>
    </div>
  `;
}

// ── Footer HTML ─────────────────────────────────────────────────
function footerHTML(insightText) {
  return `
    <div class="cta-bar">
      <span class="cta-left">Never miss another call</span>
      <span class="cta-right">(505) 594-5806</span>
    </div>
    <div class="footer">
      <div class="footer-left">
        <div class="footer-dot"><div class="footer-dot-inner"></div></div>
        <span class="footer-text">${insightText || 'Your calls. Answered. Always.'}</span>
      </div>
      <span class="footer-url">callbirdai.com</span>
    </div>
  `;
}

function wrapHTML(css, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: STAT CALLOUT (Light Mode)
// Big stat card at top, bold headline, body, 3 stat pills, footer
// ═══════════════════════════════════════════════════════════════════

function statCallout(content) {
  const statNum = content.headline || content.stat_number || '62%';
  const statLabel = content.subtext || 'of callers won\'t leave a voicemail.';
  const body = content.items?.[0] || content.body_text || '';
  const highlights = content.highlight_words || [];
  
  const items = content.items || ['24/7|Every call answered', '2s|Average pickup', '40%|More booked'];
  const statPills = items.slice(0, 3).map(item => {
    if (typeof item === 'string' && item.includes('|')) {
      const [num, label] = item.split('|');
      return { num, label };
    }
    return { num: '', label: item };
  });

  const css = baseCSS('light') + `
    .stat-card {
      margin: 48px 64px 0;
      background: linear-gradient(135deg, #122092, #1a35b8);
      border-radius: 24px;
      padding: 56px 48px;
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    .stat-card::before {
      content: '';
      position: absolute;
      top: -50%;
      right: -30%;
      width: 300px;
      height: 300px;
      background: rgba(246, 184, 40, 0.1);
      border-radius: 50%;
    }
    .stat-number {
      font-family: 'Sora', sans-serif;
      font-size: 128px;
      font-weight: 800;
      color: #ffffff;
      line-height: 1;
      letter-spacing: -0.04em;
      margin-bottom: 12px;
    }
    .stat-desc {
      font-size: 28px;
      color: rgba(255,255,255,0.85);
      line-height: 1.4;
      max-width: 600px;
      margin: 0 auto;
    }
    .body-section {
      padding: 48px 64px;
      flex: 1;
    }
    .body-headline {
      font-family: 'Sora', sans-serif;
      font-size: 52px;
      font-weight: 800;
      line-height: 1.1;
      letter-spacing: -0.03em;
      color: #1a1a2e;
      margin-bottom: 24px;
    }
    .body-text {
      font-size: 24px;
      line-height: 1.6;
      color: #4a4a6a;
    }
    .stat-pills {
      display: flex;
      gap: 16px;
      padding: 0 64px;
      margin-bottom: 0;
    }
    .stat-pill {
      flex: 1;
      background: #f0f4ff;
      border: 2px solid #e0e7ff;
      border-radius: 16px;
      padding: 24px 20px;
      text-align: center;
    }
    .pill-num {
      font-family: 'Sora', sans-serif;
      font-size: 40px;
      font-weight: 800;
      color: #122092;
      line-height: 1;
      margin-bottom: 6px;
    }
    .pill-label {
      font-size: 16px;
      color: #6b7280;
      font-weight: 500;
    }
    .mascot-float {
      position: absolute;
      top: 36px;
      right: 64px;
      width: 80px;
      height: 80px;
      object-fit: contain;
    }
  `;

  const secondHeadline = content.cta_line1 || 'Every missed call is revenue walking out your door.';

  const html = `
    <div class="post">
      <img class="mascot-float" src="data:image/png;base64,${LOGO_B64}" alt=""/>
      <div class="stat-card">
        <div class="stat-number">${statNum}</div>
        <div class="stat-desc">${statLabel}</div>
      </div>
      <div class="body-section">
        <div class="body-headline">${highlightText(secondHeadline, highlights)}</div>
        <div class="body-text">${body}</div>
      </div>
      <div class="stat-pills">
        ${statPills.map(p => `
          <div class="stat-pill">
            <div class="pill-num">${p.num}</div>
            <div class="pill-label">${p.label}</div>
          </div>
        `).join('')}
      </div>
      ${footerHTML(content.cta_line2 || 'Stop losing jobs to voicemail')}
    </div>
  `;

  return wrapHTML(css, html);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: CHECKLIST (Dark Mode)
// Headline + 4-6 items as styled cards with check icons
// ═══════════════════════════════════════════════════════════════════

function checklist(content) {
  const highlights = content.highlight_words || [];
  const items = content.items || ['Item 1', 'Item 2', 'Item 3', 'Item 4'];

  const css = baseCSS('dark') + `
    .content { padding: 44px 64px; }
    .headline {
      font-size: 64px;
      margin-bottom: 16px;
    }
    .subtext {
      font-size: 24px;
      margin-bottom: 36px;
    }
    .check-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
      flex: 1;
    }
    .check-item {
      display: flex;
      align-items: center;
      gap: 20px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 28px 32px;
    }
    .check-icon {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: linear-gradient(135deg, #122092, #1a35b8);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .check-svg {
      width: 24px;
      height: 24px;
    }
    .check-text {
      font-size: 26px;
      font-weight: 500;
      color: rgba(255,255,255,0.9);
      line-height: 1.3;
    }
    .callout-box {
      margin-top: 32px;
      background: linear-gradient(135deg, rgba(18,32,146,0.3), rgba(246,184,40,0.1));
      border: 1px solid rgba(246,184,40,0.3);
      border-radius: 16px;
      padding: 28px 36px;
      text-align: center;
    }
    .callout-text {
      font-family: 'Sora', sans-serif;
      font-size: 28px;
      font-weight: 700;
      color: #ffffff;
      line-height: 1.3;
    }
    .website-tag {
      position: absolute;
      bottom: 178px;
      left: 0;
      right: 0;
      text-align: center;
      font-size: 18px;
      color: rgba(255,255,255,0.3);
      letter-spacing: 0.15em;
      text-transform: uppercase;
    }
  `;

  const checkSVG = `<svg class="check-svg" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#F6B828" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const html = `
    <div class="post">
      ${headerHTML()}
      <div class="content">
        <div class="headline">${highlightText(content.headline || 'Checklist', highlights)}</div>
        <div class="subtext">${content.subtext || ''}</div>
        <div class="check-list">
          ${items.slice(0, 6).map(item => `
            <div class="check-item">
              <div class="check-icon">${checkSVG}</div>
              <span class="check-text">${item}</span>
            </div>
          `).join('')}
        </div>
        ${content.cta_line1 ? `
        <div class="callout-box">
          <div class="callout-text">${highlightText(content.cta_line1, highlights)}</div>
        </div>` : ''}
      </div>
      <div class="website-tag">● callbirdai.com</div>
      ${footerHTML(content.cta_line2 || 'Your calls. Answered. Always.')}
    </div>
  `;

  return wrapHTML(css, html);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: FULL GRAPHIC (Dark Mode)
// Narrative post with comparison grid or feature highlight
// ═══════════════════════════════════════════════════════════════════

function fullGraphic(content) {
  const highlights = content.highlight_words || [];
  const items = content.items || [];

  const css = baseCSS('dark') + `
    .content { padding: 44px 64px; }
    .headline {
      font-size: 68px;
      margin-bottom: 20px;
    }
    .subtext {
      font-size: 24px;
      margin-bottom: 40px;
      max-width: 900px;
    }
    .feature-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 32px;
    }
    .feature-card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 28px 24px;
      text-align: center;
    }
    .feature-card.highlighted {
      background: rgba(18,32,146,0.2);
      border-color: rgba(18,32,146,0.4);
    }
    .feature-icon {
      font-size: 32px;
      margin-bottom: 12px;
    }
    .feature-title {
      font-family: 'Sora', sans-serif;
      font-size: 22px;
      font-weight: 700;
      color: #ffffff;
      margin-bottom: 6px;
    }
    .feature-desc {
      font-size: 18px;
      color: rgba(255,255,255,0.5);
      line-height: 1.4;
    }
    .vs-divider {
      display: flex;
      align-items: center;
      justify-content: center;
      margin: -8px 0;
      position: relative;
      z-index: 2;
    }
    .vs-badge {
      background: #1a1a2e;
      border: 2px solid rgba(255,255,255,0.1);
      border-radius: 50%;
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Sora', sans-serif;
      font-size: 16px;
      font-weight: 700;
      color: rgba(255,255,255,0.5);
    }
    .highlight-box {
      background: linear-gradient(135deg, rgba(16,185,129,0.1), rgba(246,184,40,0.1));
      border: 1px solid rgba(246,184,40,0.25);
      border-radius: 16px;
      padding: 32px 40px;
      text-align: center;
      margin-top: auto;
    }
    .highlight-box-text {
      font-family: 'Sora', sans-serif;
      font-size: 30px;
      font-weight: 700;
      line-height: 1.3;
    }
    .highlight-box-sub {
      font-size: 20px;
      color: rgba(255,255,255,0.5);
      margin-top: 8px;
    }
    .website-tag {
      position: absolute;
      bottom: 178px;
      left: 0;
      right: 0;
      text-align: center;
      font-size: 18px;
      color: rgba(255,255,255,0.3);
      letter-spacing: 0.15em;
      text-transform: uppercase;
    }
  `;

  // Build comparison grid if we have 4 items, otherwise feature list
  let middleSection = '';
  if (items.length >= 4) {
    middleSection = `
      <div class="feature-grid">
        <div class="feature-card">
          <div class="feature-icon">📞</div>
          <div class="feature-title">${items[0]}</div>
        </div>
        <div class="feature-card highlighted">
          <div class="feature-icon">✅</div>
          <div class="feature-title">${items[1]}</div>
        </div>
      </div>
      <div class="vs-divider"><div class="vs-badge">VS</div></div>
      <div class="feature-grid">
        <div class="feature-card">
          <div class="feature-icon">📵</div>
          <div class="feature-title">${items[2]}</div>
        </div>
        <div class="feature-card highlighted">
          <div class="feature-icon">⚡</div>
          <div class="feature-title">${items[3]}</div>
        </div>
      </div>
    `;
  } else if (items.length > 0) {
    middleSection = `
      <div class="feature-grid">
        ${items.map((item, i) => `
          <div class="feature-card ${i % 2 === 1 ? 'highlighted' : ''}">
            <div class="feature-title">${item}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  const html = `
    <div class="post">
      ${headerHTML()}
      <div class="content">
        <div class="headline">${highlightText(content.headline || 'Full Graphic', highlights)}</div>
        <div class="subtext">${content.subtext || ''}</div>
        ${middleSection}
        <div class="highlight-box">
          <div class="highlight-box-text">${highlightText(content.cta_line1 || 'Professional service, every call, 24/7.', highlights)}</div>
          <div class="highlight-box-sub">${content.cta_line2 || 'Custom voice. Your brand. Your tone. Consistent.'}</div>
        </div>
      </div>
      <div class="website-tag">● callbirdai.com</div>
      ${footerHTML(content.cta_line2 || 'Sound professional. Always.')}
    </div>
  `;

  return wrapHTML(css, html);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: REVIEW SHOWCASE (Dark Mode)
// Testimonial card with star rating and result
// ═══════════════════════════════════════════════════════════════════

function reviewShowcase(content) {
  const highlights = content.highlight_words || [];
  const items = content.items || [];
  const reviewText = items[0] || content.review_text || 'The AI answered three calls while I was on a job site. Two of them booked appointments.';
  const reviewAuthor = items[1] || content.review_author || 'Mike R., HVAC Contractor';

  const css = baseCSS('dark') + `
    .badge {
      display: inline-block;
      background: rgba(246,184,40,0.15);
      border: 1px solid rgba(246,184,40,0.3);
      color: #F6B828;
      font-family: 'Sora', sans-serif;
      font-size: 16px;
      font-weight: 700;
      padding: 8px 20px;
      border-radius: 8px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 20px;
    }
    .content { padding: 44px 64px; }
    .headline {
      font-size: 62px;
      margin-bottom: 20px;
    }
    .subtext {
      margin-bottom: 36px;
    }
    .review-card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 20px;
      padding: 40px 44px;
      margin-bottom: 28px;
      position: relative;
    }
    .review-card::before {
      content: '"';
      position: absolute;
      top: 20px;
      left: 36px;
      font-size: 80px;
      color: rgba(246,184,40,0.2);
      font-family: Georgia, serif;
      line-height: 1;
    }
    .stars {
      display: flex;
      gap: 6px;
      margin-bottom: 20px;
    }
    .star {
      color: #F6B828;
      font-size: 28px;
    }
    .review-text {
      font-size: 28px;
      line-height: 1.5;
      color: rgba(255,255,255,0.9);
      font-style: italic;
      margin-bottom: 20px;
      padding-left: 8px;
    }
    .review-author {
      font-family: 'Sora', sans-serif;
      font-size: 20px;
      font-weight: 600;
      color: #F6B828;
    }
    .result-card {
      background: linear-gradient(135deg, rgba(18,32,146,0.3), rgba(18,32,146,0.1));
      border: 1px solid rgba(18,32,146,0.3);
      border-radius: 16px;
      padding: 28px 36px;
      display: flex;
      align-items: center;
      gap: 24px;
    }
    .result-number {
      font-family: 'Sora', sans-serif;
      font-size: 56px;
      font-weight: 800;
      color: #F6B828;
    }
    .result-label {
      font-size: 22px;
      color: rgba(255,255,255,0.7);
      line-height: 1.4;
    }
    .website-tag {
      position: absolute;
      bottom: 178px;
      left: 0;
      right: 0;
      text-align: center;
      font-size: 18px;
      color: rgba(255,255,255,0.3);
      letter-spacing: 0.15em;
      text-transform: uppercase;
    }
  `;

  const resultNum = items[2] || '3x';
  const resultLabel = items[3] || 'more appointments booked in the first week';

  const html = `
    <div class="post">
      ${headerHTML()}
      <div class="content">
        <div class="badge">Real Result</div>
        <div class="headline">${highlightText(content.headline || 'Review', highlights)}</div>
        <div class="subtext">${content.subtext || ''}</div>
        <div class="review-card">
          <div class="stars">${'<span class="star">★</span>'.repeat(5)}</div>
          <div class="review-text">${reviewText}</div>
          <div class="review-author">— ${reviewAuthor}</div>
        </div>
        <div class="result-card">
          <div class="result-number">${resultNum}</div>
          <div class="result-label">${resultLabel}</div>
        </div>
      </div>
      <div class="website-tag">● callbirdai.com</div>
      ${footerHTML(content.cta_line2 || 'Real businesses. Real results.')}
    </div>
  `;

  return wrapHTML(css, html);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: PROCESS STEPS (Dark Mode)
// Numbered steps as styled cards
// ═══════════════════════════════════════════════════════════════════

function processSteps(content) {
  const highlights = content.highlight_words || [];
  const items = content.items || ['Sign up in 60 seconds', 'Customize your greeting', 'Forward your calls', 'Never miss a lead'];

  const css = baseCSS('dark') + `
    .content { padding: 44px 64px; }
    .headline {
      font-size: 62px;
      margin-bottom: 16px;
    }
    .subtext {
      margin-bottom: 36px;
    }
    .steps {
      display: flex;
      flex-direction: column;
      gap: 16px;
      flex: 1;
    }
    .step {
      display: flex;
      align-items: center;
      gap: 24px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 16px;
      padding: 28px 32px;
    }
    .step-num {
      width: 52px;
      height: 52px;
      border-radius: 14px;
      background: linear-gradient(135deg, #122092, #F6B828);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Sora', sans-serif;
      font-size: 24px;
      font-weight: 800;
      color: #ffffff;
      flex-shrink: 0;
    }
    .step-text {
      font-size: 26px;
      font-weight: 500;
      color: rgba(255,255,255,0.9);
      line-height: 1.3;
    }
    .callout-box {
      margin-top: 32px;
      background: linear-gradient(135deg, rgba(246,184,40,0.1), rgba(18,32,146,0.15));
      border: 1px solid rgba(246,184,40,0.2);
      border-radius: 16px;
      padding: 28px 36px;
      text-align: center;
    }
    .callout-text {
      font-family: 'Sora', sans-serif;
      font-size: 28px;
      font-weight: 700;
    }
    .website-tag {
      position: absolute;
      bottom: 178px;
      left: 0;
      right: 0;
      text-align: center;
      font-size: 18px;
      color: rgba(255,255,255,0.3);
      letter-spacing: 0.15em;
      text-transform: uppercase;
    }
  `;

  const html = `
    <div class="post">
      ${headerHTML()}
      <div class="content">
        <div class="headline">${highlightText(content.headline || 'How It Works', highlights)}</div>
        <div class="subtext">${content.subtext || ''}</div>
        <div class="steps">
          ${items.slice(0, 5).map((item, i) => `
            <div class="step">
              <div class="step-num">${i + 1}</div>
              <span class="step-text">${item}</span>
            </div>
          `).join('')}
        </div>
        ${content.cta_line1 ? `
        <div class="callout-box">
          <div class="callout-text">${highlightText(content.cta_line1, highlights)}</div>
        </div>` : ''}
      </div>
      <div class="website-tag">● callbirdai.com</div>
      ${footerHTML(content.cta_line2 || 'Setup takes 5 minutes.')}
    </div>
  `;

  return wrapHTML(css, html);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: FAQ CARD (Dark Mode)
// Question headline, answer body, supporting element
// ═══════════════════════════════════════════════════════════════════

function faqCard(content) {
  const highlights = content.highlight_words || [];

  const css = baseCSS('dark') + `
    .content { padding: 44px 64px; justify-content: center; }
    .question-badge {
      display: inline-block;
      background: rgba(18,32,146,0.3);
      border: 1px solid rgba(18,32,146,0.5);
      color: #7b93db;
      font-family: 'Sora', sans-serif;
      font-size: 18px;
      font-weight: 700;
      padding: 10px 24px;
      border-radius: 10px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 28px;
    }
    .headline {
      font-size: 60px;
      margin-bottom: 32px;
    }
    .answer-card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px;
      padding: 40px 44px;
      margin-bottom: 32px;
    }
    .answer-text {
      font-size: 26px;
      line-height: 1.6;
      color: rgba(255,255,255,0.8);
    }
    .highlight-box {
      background: linear-gradient(135deg, rgba(246,184,40,0.1), rgba(18,32,146,0.15));
      border: 1px solid rgba(246,184,40,0.25);
      border-radius: 16px;
      padding: 32px 40px;
      text-align: center;
    }
    .highlight-text {
      font-family: 'Sora', sans-serif;
      font-size: 30px;
      font-weight: 700;
    }
    .website-tag {
      position: absolute;
      bottom: 178px;
      left: 0;
      right: 0;
      text-align: center;
      font-size: 18px;
      color: rgba(255,255,255,0.3);
      letter-spacing: 0.15em;
      text-transform: uppercase;
    }
  `;

  const html = `
    <div class="post">
      ${headerHTML()}
      <div class="content">
        <div class="question-badge">FAQ</div>
        <div class="headline">${highlightText(content.headline || 'Question?', highlights)}</div>
        <div class="answer-card">
          <div class="answer-text">${content.subtext || ''}</div>
        </div>
        <div class="highlight-box">
          <div class="highlight-text">${highlightText(content.cta_line1 || 'Try it yourself — call now.', highlights)}</div>
        </div>
      </div>
      <div class="website-tag">● callbirdai.com</div>
      ${footerHTML(content.cta_line2 || 'Questions answered. Calls answered.')}
    </div>
  `;

  return wrapHTML(css, html);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: CTA CARD (Light Mode)
// Demo/CTA post with mascot, phone number, features
// ═══════════════════════════════════════════════════════════════════

function ctaCard(content) {
  const highlights = content.highlight_words || [];
  const items = content.items || ['Learns your business in 30 seconds', 'Works as your own receptionist', 'Books real appointments'];

  const css = baseCSS('light') + `
    .post {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 64px;
    }
    .mascot {
      width: 200px;
      height: 200px;
      object-fit: contain;
      margin-bottom: 40px;
    }
    .headline {
      font-size: 72px;
      text-align: center;
      color: #122092;
      margin-bottom: 32px;
    }
    .phone-box {
      background: #122092;
      border-radius: 16px;
      padding: 24px 64px;
      margin-bottom: 40px;
    }
    .phone-number {
      font-family: 'Sora', sans-serif;
      font-size: 48px;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: 0.02em;
    }
    .features-box {
      border: 2px solid #122092;
      border-radius: 20px;
      padding: 36px 48px;
      text-align: left;
      width: 100%;
      max-width: 700px;
      margin-bottom: 36px;
    }
    .features-title {
      font-family: 'Sora', sans-serif;
      font-size: 28px;
      font-weight: 700;
      color: #122092;
      margin-bottom: 20px;
    }
    .feature-item {
      font-size: 24px;
      color: #4a4a6a;
      line-height: 1.6;
      padding-left: 28px;
      position: relative;
      margin-bottom: 8px;
    }
    .feature-item::before {
      content: '•';
      position: absolute;
      left: 0;
      color: #122092;
      font-size: 28px;
    }
    .cta-button {
      background: #F6B828;
      border-radius: 12px;
      padding: 20px 48px;
      margin-bottom: 16px;
    }
    .cta-button-text {
      font-family: 'Sora', sans-serif;
      font-size: 28px;
      font-weight: 700;
      color: #122092;
    }
    .cta-sub {
      font-size: 22px;
      color: #6b7280;
    }
    .footer {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
    }
    .cta-bar {
      position: absolute;
      bottom: 88px;
      left: 0;
      right: 0;
    }
  `;

  const html = `
    <div class="post">
      <img class="mascot" src="data:image/png;base64,${LOGO_B64}" alt="CallBird"/>
      <div class="headline">${highlightText(content.headline || 'Call Our Demo Now', highlights)}</div>
      <div class="phone-box">
        <span class="phone-number">(505) 594-5806</span>
      </div>
      <div class="features-box">
        <div class="features-title">${content.cta_line1 || 'Our Demo—'}</div>
        ${items.slice(0, 4).map(item => `<div class="feature-item">${item}</div>`).join('')}
      </div>
      <div class="cta-button"><span class="cta-button-text">See for yourself today</span></div>
      <div class="cta-sub">(Call number above)</div>
      ${footerHTML(content.cta_line2 || 'Hear the difference.')}
    </div>
  `;

  return wrapHTML(css, html);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: educate_stat_dark_01
// Dark navy. Massive stat number with gold gradient, supporting headline,
// 3 stat pills row, dense visual zones.
// ═══════════════════════════════════════════════════════════════════

function educateStatDark01(content) {
  const highlights = content.highlight_words || [];
  const statNum = content.headline || '62%';
  const statLabel = content.subtext || "of callers won't leave a voicemail.";
  const followUpHeadline = content.cta_line1 || 'They just call the next business.';
  const bodyText = content.body_text || content.cta_line2_full || '';

  const items = content.items || ['24/7|Every call answered', '2s|Average pickup', '40%|More booked'];
  const statPills = items.slice(0, 3).map(item => {
    if (typeof item === 'string' && item.includes('|')) {
      const [num, label] = item.split('|');
      return { num: num.trim(), label: label.trim() };
    }
    return { num: '', label: item };
  });

  const css = baseCSS('dark') + `
    .post::before {
      content: '';
      position: absolute;
      top: -200px;
      right: -200px;
      width: 600px;
      height: 600px;
      background: radial-gradient(circle, rgba(246,184,40,0.08) 0%, transparent 60%);
      border-radius: 50%;
      pointer-events: none;
    }
    .post::after {
      content: '';
      position: absolute;
      bottom: 220px;
      left: -150px;
      width: 400px;
      height: 400px;
      background: radial-gradient(circle, rgba(18,32,146,0.4) 0%, transparent 60%);
      border-radius: 50%;
      pointer-events: none;
    }
    .badge {
      display: inline-block;
      background: rgba(246,184,40,0.12);
      border: 1px solid rgba(246,184,40,0.35);
      color: #F6B828;
      font-family: 'Sora', sans-serif;
      font-size: 16px;
      font-weight: 700;
      padding: 10px 20px;
      border-radius: 8px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .stat-zone {
      padding: 36px 64px 0;
      text-align: center;
      position: relative;
      z-index: 1;
    }
    .stat-zone .badge { margin-bottom: 32px; }
    .stat-mega {
      font-family: 'Sora', sans-serif;
      font-size: 280px;
      font-weight: 800;
      line-height: 0.92;
      letter-spacing: -0.05em;
      background: linear-gradient(135deg, #F6B828 0%, #FFD96A 50%, #F6B828 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 18px;
    }
    .stat-mega-label {
      font-family: 'Sora', sans-serif;
      font-size: 28px;
      font-weight: 500;
      color: rgba(255,255,255,0.7);
      letter-spacing: 0.01em;
      max-width: 760px;
      margin: 0 auto;
      line-height: 1.4;
    }
    .followup {
      padding: 44px 64px 0;
      position: relative;
      z-index: 1;
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .followup-headline {
      font-family: 'Sora', sans-serif;
      font-size: 60px;
      font-weight: 800;
      line-height: 1.05;
      letter-spacing: -0.03em;
      color: #ffffff;
      margin-bottom: 20px;
    }
    .followup-body {
      font-size: 23px;
      line-height: 1.5;
      color: rgba(255,255,255,0.65);
      max-width: 880px;
    }
    .insight-quote {
      margin-top: 20px;
      padding: 22px 28px;
      background: rgba(18,32,146,0.35);
      border-left: 4px solid #F6B828;
      border-radius: 4px 14px 14px 4px;
      font-family: 'Sora', sans-serif;
      font-size: 20px;
      font-weight: 600;
      color: rgba(255,255,255,0.92);
      line-height: 1.4;
    }
    .stat-pills {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      padding: 32px 64px 36px;
      position: relative;
      z-index: 1;
    }
    .stat-pill {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 24px 18px;
      text-align: center;
    }
    .pill-num {
      font-family: 'Sora', sans-serif;
      font-size: 40px;
      font-weight: 800;
      color: #F6B828;
      line-height: 1;
      margin-bottom: 8px;
      letter-spacing: -0.02em;
    }
    .pill-label {
      font-size: 15px;
      color: rgba(255,255,255,0.6);
      font-weight: 500;
      line-height: 1.3;
    }
  `;

  const insightLine = bodyText || 'Voicemail used to be polite. Now it costs you the job.';

  const html = `
    <div class="post">
      ${headerHTML()}
      <div class="stat-zone">
        <div class="badge">Did You Know?</div>
        <div class="stat-mega">${statNum}</div>
        <div class="stat-mega-label">${statLabel}</div>
      </div>
      <div class="followup">
        <div class="followup-headline">${highlightText(followUpHeadline, highlights)}</div>
        <div class="insight-quote">${insightLine}</div>
      </div>
      <div class="stat-pills">
        ${statPills.map(p => `
          <div class="stat-pill">
            <div class="pill-num">${p.num}</div>
            <div class="pill-label">${p.label}</div>
          </div>
        `).join('')}
      </div>
      ${footerHTML(content.cta_line2 || 'Stop losing jobs to voicemail')}
    </div>
  `;

  return wrapHTML(css, html);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: educate_stat_light_01
// White bg. Big blue stat card up top, bold dark headline, body text,
// 3 stat pills row at bottom.
// ═══════════════════════════════════════════════════════════════════

function educateStatLight01(content) {
  const highlights = content.highlight_words || [];
  const statNum = content.headline || '62%';
  const statLabel = content.subtext || "of callers won't leave a voicemail.";
  const followUp = content.cta_line1 || 'They just call the next business.';
  const insight = content.body_text || 'Voicemail used to be polite. Now it costs you the job.';

  const items = content.items || ['24/7|Every call answered', '2s|Average pickup', '40%|More booked'];
  const statPills = items.slice(0, 3).map(item => {
    if (typeof item === 'string' && item.includes('|')) {
      const [num, label] = item.split('|');
      return { num: num.trim(), label: label.trim() };
    }
    return { num: '', label: item };
  });

  const css = baseCSS('light') + `
    .header { padding: 36px 64px 0; }
    .header-brand { color: #122092; }
    .stat-card {
      margin: 28px 64px 0;
      background: linear-gradient(135deg, #122092 0%, #1a35b8 100%);
      border-radius: 28px;
      padding: 48px 48px;
      position: relative;
      overflow: hidden;
      box-shadow: 0 30px 60px rgba(18,32,146,0.25);
    }
    .stat-card::before {
      content: '';
      position: absolute;
      top: -30%;
      right: -10%;
      width: 380px;
      height: 380px;
      background: radial-gradient(circle, rgba(246,184,40,0.18) 0%, transparent 65%);
      border-radius: 50%;
      pointer-events: none;
    }
    .stat-card::after {
      content: '';
      position: absolute;
      bottom: -50%;
      left: -20%;
      width: 300px;
      height: 300px;
      background: radial-gradient(circle, rgba(255,255,255,0.08) 0%, transparent 60%);
      border-radius: 50%;
      pointer-events: none;
    }
    .stat-card-inner {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 48px;
    }
    .stat-number {
      font-family: 'Sora', sans-serif;
      font-size: 180px;
      font-weight: 800;
      color: #F6B828;
      line-height: 0.92;
      letter-spacing: -0.04em;
      flex-shrink: 0;
    }
    .stat-text {
      flex: 1;
    }
    .stat-eyebrow {
      font-family: 'Sora', sans-serif;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: rgba(246,184,40,0.85);
      margin-bottom: 10px;
    }
    .stat-desc {
      font-family: 'Sora', sans-serif;
      font-size: 26px;
      font-weight: 600;
      color: #ffffff;
      line-height: 1.25;
      letter-spacing: -0.01em;
    }
    .body-section {
      padding: 36px 64px 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 22px;
    }
    .body-extras {
      margin-top: auto;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
    }
    .insight-tile {
      background: #ffffff;
      border: 1px solid #e0e7ff;
      border-radius: 16px;
      padding: 20px 22px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-shadow: 0 4px 12px rgba(18,32,146,0.05);
    }
    .insight-tile-icon {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: #122092;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #F6B828;
      font-family: 'Sora', sans-serif;
      font-size: 18px;
      font-weight: 800;
    }
    .insight-tile-text {
      font-family: 'Sora', sans-serif;
      font-size: 15px;
      font-weight: 600;
      color: #1a1a2e;
      line-height: 1.35;
    }
    .body-headline {
      font-family: 'Sora', sans-serif;
      font-size: 60px;
      font-weight: 800;
      line-height: 1.05;
      letter-spacing: -0.03em;
      color: #1a1a2e;
      margin-bottom: 16px;
    }
    .body-headline .hl {
      background: linear-gradient(180deg, transparent 60%, rgba(246,184,40,0.4) 60%, rgba(246,184,40,0.4) 92%, transparent 92%);
      color: #1a1a2e;
      padding: 0 4px;
    }
    .body-quote {
      padding: 18px 26px;
      background: #f0f4ff;
      border-left: 4px solid #122092;
      border-radius: 4px 14px 14px 4px;
      font-family: 'Sora', sans-serif;
      font-size: 22px;
      font-weight: 600;
      color: #2a3050;
      line-height: 1.4;
    }
    .stat-pills {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      padding: 32px 64px 36px;
    }
    .stat-pill {
      background: linear-gradient(180deg, #f0f4ff 0%, #e6edff 100%);
      border: 1px solid #d4ddff;
      border-radius: 18px;
      padding: 22px 16px;
      text-align: center;
    }
    .pill-num {
      font-family: 'Sora', sans-serif;
      font-size: 38px;
      font-weight: 800;
      color: #122092;
      line-height: 1;
      margin-bottom: 6px;
      letter-spacing: -0.02em;
    }
    .pill-label {
      font-size: 14px;
      color: #6b7280;
      font-weight: 500;
      line-height: 1.3;
    }
  `;

  const html = `
    <div class="post">
      ${headerHTML()}
      <div class="stat-card">
        <div class="stat-card-inner">
          <div class="stat-number">${statNum}</div>
          <div class="stat-text">
            <div class="stat-eyebrow">Did You Know</div>
            <div class="stat-desc">${statLabel}</div>
          </div>
        </div>
      </div>
      <div class="body-section">
        <div class="body-headline">${highlightText(followUp, highlights)}</div>
        <div class="body-quote">${insight}</div>
        <div class="body-extras">
          <div class="insight-tile">
            <div class="insight-tile-icon">$</div>
            <div class="insight-tile-text">$8,400 in lost jobs every month</div>
          </div>
          <div class="insight-tile">
            <div class="insight-tile-icon">⚠</div>
            <div class="insight-tile-text">12 missed calls per week, on average</div>
          </div>
          <div class="insight-tile">
            <div class="insight-tile-icon">→</div>
            <div class="insight-tile-text">87% of callers go to a competitor</div>
          </div>
        </div>
      </div>
      <div class="stat-pills">
        ${statPills.map(p => `
          <div class="stat-pill">
            <div class="pill-num">${p.num}</div>
            <div class="pill-label">${p.label}</div>
          </div>
        `).join('')}
      </div>
      ${footerHTML(content.cta_line2 || 'Stop losing jobs to voicemail')}
    </div>
  `;

  return wrapHTML(css, html);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: educate_comparison_dark_01
// 2-column "Without CallBird vs With CallBird" comparison with cards.
// ═══════════════════════════════════════════════════════════════════

function educateComparisonDark01(content) {
  const highlights = content.highlight_words || [];
  const headline = content.headline || 'Without vs With CallBird';
  const subtext = content.subtext || '';

  const items = content.items || [];
  // Items expected as alternating "without|with" pairs OR 4 bullets (first 2 = without, last 2 = with)
  let withoutItems = [];
  let withItems = [];

  items.forEach((item) => {
    if (typeof item === 'string' && item.startsWith('without:')) {
      withoutItems.push(item.replace(/^without:\s*/i, ''));
    } else if (typeof item === 'string' && item.startsWith('with:')) {
      withItems.push(item.replace(/^with:\s*/i, ''));
    }
  });
  if (withoutItems.length === 0 && withItems.length === 0) {
    const half = Math.ceil(items.length / 2);
    withoutItems = items.slice(0, half);
    withItems = items.slice(half);
  }
  if (withoutItems.length === 0) withoutItems = ['Calls go to voicemail', '62% of callers hang up', 'Lost revenue daily'];
  if (withItems.length === 0) withItems = ['Every call answered', 'Booked in 60 seconds', 'More jobs per week'];

  const css = baseCSS('dark') + `
    .content {
      padding: 32px 64px 24px;
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .headline {
      font-size: 60px;
      margin-bottom: 14px;
    }
    .subtext {
      font-size: 22px;
      margin-bottom: 28px;
    }
    .compare-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
      flex: 1;
    }
    .compare-card {
      border-radius: 20px;
      padding: 32px 28px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .compare-card.bad {
      background: linear-gradient(180deg, rgba(180,40,40,0.12), rgba(180,40,40,0.04));
      border: 1px solid rgba(220,80,80,0.25);
    }
    .compare-card.good {
      background: linear-gradient(180deg, rgba(246,184,40,0.12), rgba(18,32,146,0.18));
      border: 1px solid rgba(246,184,40,0.35);
    }
    .compare-label {
      font-family: 'Sora', sans-serif;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.15em;
      text-transform: uppercase;
    }
    .compare-card.bad .compare-label { color: rgba(255,140,140,0.85); }
    .compare-card.good .compare-label { color: #F6B828; }
    .compare-title {
      font-family: 'Sora', sans-serif;
      font-size: 32px;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #ffffff;
      line-height: 1.1;
      margin-bottom: 6px;
    }
    .compare-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 16px;
      flex: 1;
    }
    .compare-item {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      font-size: 20px;
      line-height: 1.4;
      color: rgba(255,255,255,0.88);
    }
    .compare-icon {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Sora', sans-serif;
      font-size: 15px;
      font-weight: 800;
      margin-top: 2px;
    }
    .compare-stat {
      margin-top: auto;
      padding-top: 16px;
      border-top: 1px solid rgba(255,255,255,0.08);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .compare-stat-num {
      font-family: 'Sora', sans-serif;
      font-size: 36px;
      font-weight: 800;
      letter-spacing: -0.02em;
      line-height: 1;
    }
    .compare-card.bad .compare-stat-num { color: #ff8888; }
    .compare-card.good .compare-stat-num { color: #F6B828; }
    .compare-stat-label {
      font-size: 14px;
      letter-spacing: 0.06em;
      color: rgba(255,255,255,0.55);
      font-weight: 500;
      text-transform: uppercase;
    }
    .compare-card.bad .compare-icon {
      background: rgba(220,80,80,0.2);
      color: #ff8888;
    }
    .compare-card.good .compare-icon {
      background: rgba(246,184,40,0.25);
      color: #F6B828;
    }
    .conclusion {
      margin-top: 20px;
      background: linear-gradient(90deg, rgba(18,32,146,0.6), rgba(18,32,146,0.3));
      border: 1px solid rgba(246,184,40,0.3);
      border-radius: 14px;
      padding: 20px 28px;
      display: flex;
      align-items: center;
      gap: 18px;
    }
    .conclusion-icon {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: #F6B828;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .conclusion-text {
      font-family: 'Sora', sans-serif;
      font-size: 22px;
      font-weight: 700;
      color: #ffffff;
      line-height: 1.3;
    }
  `;

  const conclusionLine = content.cta_line1 || 'Same calls. Different outcomes.';

  const html = `
    <div class="post">
      ${headerHTML()}
      <div class="content">
        <div class="headline">${highlightText(headline, highlights)}</div>
        ${subtext ? `<div class="subtext">${subtext}</div>` : ''}
        <div class="compare-grid">
          <div class="compare-card bad">
            <div class="compare-label">Without CallBird</div>
            <div class="compare-title">Calls slip through</div>
            <ul class="compare-list">
              ${withoutItems.slice(0, 4).map(item => `
                <li class="compare-item">
                  <span class="compare-icon">✕</span>
                  <span>${item}</span>
                </li>`).join('')}
            </ul>
            <div class="compare-stat">
              <div class="compare-stat-num">$8,400</div>
              <div class="compare-stat-label">Lost per month</div>
            </div>
          </div>
          <div class="compare-card good">
            <div class="compare-label">With CallBird</div>
            <div class="compare-title">Every call captured</div>
            <ul class="compare-list">
              ${withItems.slice(0, 4).map(item => `
                <li class="compare-item">
                  <span class="compare-icon">✓</span>
                  <span>${item}</span>
                </li>`).join('')}
            </ul>
            <div class="compare-stat">
              <div class="compare-stat-num">$8,400</div>
              <div class="compare-stat-label">Recovered per month</div>
            </div>
          </div>
        </div>
        <div class="conclusion">
          <div class="conclusion-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M5 13l4 4L19 7" stroke="#122092" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="conclusion-text">${highlightText(conclusionLine, highlights)}</div>
        </div>
      </div>
      ${footerHTML(content.cta_line2 || 'Same calls. Better outcomes.')}
    </div>
  `;

  return wrapHTML(css, html);
}


// ═══════════════════════════════════════════════════════════════════
// TEMPLATE: educate_feature_dark_01
// Mock product UI: realistic call summary card showing what CallBird
// captures. Feels like a real product screenshot.
// ═══════════════════════════════════════════════════════════════════

function educateFeatureDark01(content) {
  const highlights = content.highlight_words || [];
  const headline = content.headline || 'Every call. Captured.';
  const subtext = content.subtext || 'Caller details, intent, and booking — sent to your phone in 30 seconds.';
  const items = content.items || [];

  // Sensible defaults for the mock card
  const callerName = items[0] || 'Sarah Mitchell';
  const callerPhone = items[1] || '+1 (505) 555-0142';
  const callerNeed = items[2] || 'AC unit not cooling. Wants service today.';
  const bookingTime = items[3] || 'Tomorrow, 2:00 PM';

  const css = baseCSS('dark') + `
    .content {
      padding: 32px 64px 20px;
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .headline {
      font-size: 64px;
      margin-bottom: 14px;
    }
    .subtext {
      font-size: 22px;
      margin-bottom: 28px;
      max-width: 880px;
    }
    .call-card {
      background: linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 22px;
      padding: 28px 30px;
      box-shadow: 0 30px 80px rgba(0,0,0,0.4);
      flex: 1;
    }
    .call-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 18px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      margin-bottom: 20px;
    }
    .call-tag {
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: 'Sora', sans-serif;
      font-size: 14px;
      font-weight: 700;
      color: rgba(246,184,40,0.95);
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .live-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #F6B828;
      box-shadow: 0 0 0 4px rgba(246,184,40,0.2);
    }
    .call-time {
      font-size: 14px;
      color: rgba(255,255,255,0.5);
      font-family: 'Inter', sans-serif;
      font-weight: 500;
    }
    .caller-row {
      display: flex;
      align-items: center;
      gap: 18px;
      margin-bottom: 22px;
    }
    .avatar {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: linear-gradient(135deg, #F6B828, #e8a810);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Sora', sans-serif;
      font-size: 26px;
      font-weight: 800;
      color: #122092;
      flex-shrink: 0;
    }
    .caller-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .caller-name {
      font-family: 'Sora', sans-serif;
      font-size: 26px;
      font-weight: 700;
      color: #ffffff;
    }
    .caller-phone {
      font-size: 17px;
      color: rgba(255,255,255,0.6);
      font-family: 'Inter', sans-serif;
    }
    .field {
      margin-bottom: 18px;
    }
    .field-label {
      font-family: 'Sora', sans-serif;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.4);
      margin-bottom: 6px;
    }
    .field-value {
      font-size: 21px;
      line-height: 1.4;
      color: rgba(255,255,255,0.92);
      font-weight: 500;
    }
    .booking-row {
      display: flex;
      align-items: center;
      gap: 14px;
      background: rgba(246,184,40,0.08);
      border: 1px solid rgba(246,184,40,0.25);
      border-radius: 14px;
      padding: 18px 22px;
      margin-top: 6px;
    }
    .booking-icon {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: rgba(246,184,40,0.18);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .booking-info {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .booking-label {
      font-family: 'Sora', sans-serif;
      font-size: 13px;
      font-weight: 700;
      color: #F6B828;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .booking-time {
      font-family: 'Sora', sans-serif;
      font-size: 22px;
      font-weight: 700;
      color: #ffffff;
    }
    .tags-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 22px;
    }
    .tag {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 999px;
      padding: 6px 14px;
      font-family: 'Inter', sans-serif;
      font-size: 14px;
      font-weight: 500;
      color: rgba(255,255,255,0.75);
      letter-spacing: 0.02em;
    }
    .tag.priority {
      background: rgba(246,184,40,0.12);
      border-color: rgba(246,184,40,0.35);
      color: #F6B828;
      font-weight: 600;
    }
    .actions-row {
      margin-top: 20px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .action {
      display: flex;
      align-items: center;
      gap: 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      padding: 12px 16px;
      font-family: 'Sora', sans-serif;
      font-size: 15px;
      font-weight: 600;
      color: rgba(255,255,255,0.85);
    }
    .action-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
      flex-shrink: 0;
    }
  `;

  const html = `
    <div class="post">
      ${headerHTML()}
      <div class="content">
        <div class="headline">${highlightText(headline, highlights)}</div>
        <div class="subtext">${subtext}</div>
        <div class="call-card">
          <div class="call-header">
            <div class="call-tag">
              <span class="live-dot"></span>
              <span>Call Summary</span>
            </div>
            <div class="call-time">Just now · 1m 42s</div>
          </div>
          <div class="caller-row">
            <div class="avatar">${callerName.split(' ').map(p => p[0]).join('').slice(0,2).toUpperCase()}</div>
            <div class="caller-info">
              <div class="caller-name">${callerName}</div>
              <div class="caller-phone">${callerPhone}</div>
            </div>
          </div>
          <div class="tags-row">
            <span class="tag priority">High Priority</span>
            <span class="tag">New Customer</span>
            <span class="tag">Service Request</span>
          </div>
          <div class="field">
            <div class="field-label">Reason for call</div>
            <div class="field-value">${callerNeed}</div>
          </div>
          <div class="field">
            <div class="field-label">Booking confirmed</div>
            <div class="booking-row">
              <div class="booking-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="5" width="18" height="16" rx="2" stroke="#F6B828" stroke-width="2"/>
                  <path d="M3 10h18" stroke="#F6B828" stroke-width="2"/>
                  <path d="M8 3v4M16 3v4" stroke="#F6B828" stroke-width="2" stroke-linecap="round"/>
                </svg>
              </div>
              <div class="booking-info">
                <div class="booking-label">Appointment</div>
                <div class="booking-time">${bookingTime}</div>
              </div>
            </div>
          </div>
          <div class="actions-row">
            <div class="action">
              <span class="action-dot"></span>
              <span>Text summary sent</span>
            </div>
            <div class="action">
              <span class="action-dot"></span>
              <span>Calendar updated</span>
            </div>
          </div>
        </div>
      </div>
      ${footerHTML(content.cta_line2 || 'Every detail. Captured.')}
    </div>
  `;

  return wrapHTML(css, html);
}


// ═══════════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════════

const TEMPLATES = {
  // Legacy generic IDs (kept for backwards compatibility)
  stat_callout: statCallout,
  checklist: checklist,
  full_graphic: fullGraphic,
  review_showcase: reviewShowcase,
  process_steps: processSteps,
  faq_card: faqCard,
  cta_card: ctaCard,

  // Pillar-based IDs
  // EDUCATE
  educate_stat_dark_01: educateStatDark01,
  educate_stat_light_01: educateStatLight01,
  educate_checklist_dark_01: checklist,
  educate_comparison_dark_01: educateComparisonDark01,
  educate_comparison_dark_02: fullGraphic,
  educate_process_dark_01: processSteps,
  educate_faq_dark_01: faqCard,
  educate_didyouknow_dark_01: educateStatDark01,
  educate_feature_dark_01: educateFeatureDark01,

  // INSPIRE
  inspire_review_dark_01: reviewShowcase,
  inspire_review_dark_02: reviewShowcase,

  // PROMOTE
  promote_demo_light_01: ctaCard,
  promote_cta_light_01: ctaCard,
};

function render(templateId, content, business, photoDataUrl, options) {
  const fn = TEMPLATES[templateId] || fullGraphic;
  return fn(content);
}

module.exports = { render, TEMPLATES };