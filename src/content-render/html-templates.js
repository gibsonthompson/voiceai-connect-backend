/**
 * Template Router
 * Delegates to per-business template files based on business.slug.
 * Falls back to generic templates for businesses without custom files.
 * 
 * SAVE AS: src/content-render/html-templates.js
 */

function renderTemplate(templateId, content, business, photoDataUrl, options) {
  const slug = (business.slug || '').toLowerCase();

  try {
    if (slug === 'callbird') {
      return require('./callbird-templates').render(templateId, content, business, photoDataUrl, options);
    }
    // Future:
    // if (slug === 'voiceai-connect') return require('./voiceai-templates').render(...);
    // if (slug === 'gtc') return require('./gtc-templates').render(...);
    // if (slug === 'rsa') return require('./rsa-templates').render(...);
  } catch (e) {
    console.error(`[TEMPLATES] Custom template error for ${slug}: ${e.message}`);
  }

  // Fallback to generic unified engine
  const generic = require('./generic-templates');
  return generic.renderTemplate(templateId, content, business, photoDataUrl, options);
}

module.exports = { renderTemplate };