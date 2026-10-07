// ============================================================================
// CLIENT PROMPT ROUTES - Agency-level editing of individual client AI config
// PUT handles: system_prompt, first_message, voice_id, model, temperature,
//              call_mode (Supabase-only), transfer_phone (VAPI transferCall tool)
//
// UPDATED: 2026-09-17 — SECURITY: added a top-of-router ownership guard. Every
//          route is scoped by :agencyId/:clientId but had no ownership check, so
//          an authenticated agency could read/edit/reset another agency's
//          client's AI config, including the transfer_phone (which redirects
//          call transfers). requireAgencyAccess('clients') enforces valid token
//          + caller owns :agencyId. The per-query `.eq('agency_id', agencyId)`
//          scoping stays as defense in depth.
// UPDATED: 2026-10-07 — VOICE PIPELINE OPTIONS: the PUT now also accepts and
//          persists the per-client pipeline choices surfaced in the AI Lab:
//            - llm_model      -> clients.llm_model      (+ VAPI model.model)
//            - temperature    -> clients.temperature    (+ VAPI model.temperature)
//            - voice_provider -> clients.voice_provider (+ VAPI voice.provider)
//            - transcriber_mode / flux_language / flux_eot_threshold /
//              flux_eot_timeout_ms / endpointing_provider -> clients columns
//            - background_denoising -> clients.tool_config.backgroundDenoising
//          These columns are what buildDynamicAssistantConfig reads at call time,
//          so this is the write side of the live-call pipeline. The same values
//          are also PATCHed onto the STATIC assistant (via the exported builder
//          helpers) so the AI Lab "Start Test Call" matches live calls exactly.
//          model + temperature previously went to VAPI only; they now also land
//          in clients columns so live calls honor the per-client choice.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { INDUSTRY_MAPPING, INDUSTRY_CONFIGS } = require('../lib/vapi');
const { requireAgencyAccess } = require('./auth');
const {
  buildTranscriber,
  buildVoice,
  buildStartSpeakingPlan,
} = require('../lib/assistant-config-builder');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// Allowed values for the pipeline enums (mirror the AI Lab dropdowns + the
// buildDynamicAssistantConfig expectations). Kept permissive for llm_model so a
// newly enabled model id is not rejected before the dropdown is updated.
const ALLOWED_VOICE_PROVIDERS = ['11labs', 'cartesia'];
const ALLOWED_TRANSCRIBER_MODES = ['nova', 'flux'];
const ALLOWED_FLUX_LANGUAGES = ['en', 'multi'];
const ALLOWED_ENDPOINTING = ['vapi', 'livekit'];

// ----------------------------------------------------------------------------
// OWNERSHIP GUARD — covers GET/PUT /:agencyId/clients/:clientId/prompt and
// POST /:agencyId/clients/:clientId/prompt/reset (prefix match).
// ----------------------------------------------------------------------------
router.use('/:agencyId/clients/:clientId/prompt', requireAgencyAccess('clients'));

// ============================================================================
// GET /api/agency/:agencyId/clients/:clientId/prompt
// ============================================================================
router.get('/:agencyId/clients/:clientId/prompt', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select('id, vapi_assistant_id, system_prompt, industry, business_name')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (error || !client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    if (!client.vapi_assistant_id) {
      return res.status(400).json({ success: false, error: 'Client has no AI assistant configured' });
    }

    const industryKey = INDUSTRY_MAPPING[client.industry] || 'professional_services';

    if (client.system_prompt) {
      return res.json({ success: true, system_prompt: client.system_prompt, industry: industryKey, business_name: client.business_name, source: 'cache' });
    }

    const vapiResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });

    if (!vapiResponse.ok) {
      return res.status(500).json({ success: false, error: 'Failed to fetch assistant from VAPI' });
    }

    const assistant = await vapiResponse.json();
    const systemPrompt = assistant.model?.messages?.[0]?.content || '';

    await supabase.from('clients').update({ system_prompt: systemPrompt }).eq('id', clientId);

    return res.json({ success: true, system_prompt: systemPrompt, industry: industryKey, business_name: client.business_name, source: 'vapi' });
  } catch (error) {
    console.error('Error fetching client prompt:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/agency/:agencyId/clients/:clientId/prompt
// All fields optional. Only provided fields are updated. Backwards compatible.
// ============================================================================
router.put('/:agencyId/clients/:clientId/prompt', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const {
      system_prompt, first_message, voice_id, model, temperature, call_mode, transfer_phone, speed,
      // ── voice pipeline (added 2026-10-07) ──
      voice_provider, transcriber_mode, flux_language, flux_eot_threshold,
      flux_eot_timeout_ms, endpointing_provider, background_denoising,
    } = req.body;

    // Detect which fields were provided
    const hasPrompt = typeof system_prompt === 'string' && system_prompt.trim().length >= 10;
    const hasGreeting = typeof first_message === 'string';
    const hasVoice = typeof voice_id === 'string' && voice_id.trim().length > 0;
    const hasModel = typeof model === 'string' && model.trim().length > 0;
    const hasTemp = typeof temperature === 'number' && temperature >= 0 && temperature <= 1;
    const hasCallMode = typeof call_mode === 'string' && (call_mode === 'primary' || call_mode === 'secondary');
    const hasTransferPhone = typeof transfer_phone === 'string' && transfer_phone.trim().length > 0;
    const hasSpeed = typeof speed === 'number' && speed >= 0.7 && speed <= 1.2;

    // ── voice pipeline field detection + validation ──
    const hasVoiceProvider = typeof voice_provider === 'string' && voice_provider.length > 0;
    if (hasVoiceProvider && !ALLOWED_VOICE_PROVIDERS.includes(voice_provider)) {
      return res.status(400).json({ success: false, error: `Invalid voice_provider. Allowed: ${ALLOWED_VOICE_PROVIDERS.join(', ')}` });
    }
    const hasTranscriberMode = typeof transcriber_mode === 'string' && transcriber_mode.length > 0;
    if (hasTranscriberMode && !ALLOWED_TRANSCRIBER_MODES.includes(transcriber_mode)) {
      return res.status(400).json({ success: false, error: `Invalid transcriber_mode. Allowed: ${ALLOWED_TRANSCRIBER_MODES.join(', ')}` });
    }
    const hasFluxLang = typeof flux_language === 'string' && flux_language.length > 0;
    if (hasFluxLang && !ALLOWED_FLUX_LANGUAGES.includes(flux_language)) {
      return res.status(400).json({ success: false, error: `Invalid flux_language. Allowed: ${ALLOWED_FLUX_LANGUAGES.join(', ')}` });
    }
    const hasFluxEot = flux_eot_threshold !== undefined && flux_eot_threshold !== null && flux_eot_threshold !== '';
    let fluxEotVal = null;
    if (hasFluxEot) {
      fluxEotVal = Number(flux_eot_threshold);
      if (isNaN(fluxEotVal) || fluxEotVal < 0.5 || fluxEotVal > 1.0) {
        return res.status(400).json({ success: false, error: 'flux_eot_threshold must be between 0.5 and 1.0' });
      }
    }
    const hasFluxEotMs = flux_eot_timeout_ms !== undefined && flux_eot_timeout_ms !== null && flux_eot_timeout_ms !== '';
    let fluxEotMsVal = null;
    if (hasFluxEotMs) {
      fluxEotMsVal = Number(flux_eot_timeout_ms);
      if (isNaN(fluxEotMsVal) || fluxEotMsVal < 500 || fluxEotMsVal > 30000) {
        return res.status(400).json({ success: false, error: 'flux_eot_timeout_ms must be between 500 and 30000' });
      }
    }
    const hasEndpointing = typeof endpointing_provider === 'string' && endpointing_provider.length > 0;
    if (hasEndpointing && !ALLOWED_ENDPOINTING.includes(endpointing_provider)) {
      return res.status(400).json({ success: false, error: `Invalid endpointing_provider. Allowed: ${ALLOWED_ENDPOINTING.join(', ')}` });
    }
    const hasDenoising = typeof background_denoising === 'boolean';

    const needsPipelinePatch = hasVoiceProvider || hasTranscriberMode || hasFluxLang || hasFluxEot || hasFluxEotMs || hasEndpointing || hasDenoising;

    // Validate prompt length
    if (typeof system_prompt === 'string' && system_prompt.trim().length > 0 && system_prompt.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'system_prompt must be at least 10 characters' });
    }

    if (!hasPrompt && !hasGreeting && !hasVoice && !hasModel && !hasTemp && !hasCallMode && !hasTransferPhone && !hasSpeed && !needsPipelinePatch) {
      return res.status(400).json({ success: false, error: 'At least one field required' });
    }

    // Fetch client (incl. current pipeline state so partial updates merge
    // correctly for the static-assistant PATCH + the tool_config merge).
    const { data: client, error } = await supabase
      .from('clients')
      .select('id, vapi_assistant_id, business_name, voice_id, voice_speed, voice_provider, transcriber_mode, flux_language, flux_eot_threshold, flux_eot_timeout_ms, endpointing_provider, tool_config')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (error || !client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    // Merge incoming changes over the current client row so helper-built blocks
    // (transcriber/voice/endpointing) reflect the full post-update state even on
    // a partial PUT. Denoising state is resolved separately below.
    const mergedClient = {
      voice_id: hasVoice ? voice_id.trim() : client.voice_id,
      voice_speed: hasSpeed ? speed : client.voice_speed,
      voice_provider: hasVoiceProvider ? voice_provider : client.voice_provider,
      transcriber_mode: hasTranscriberMode ? transcriber_mode : client.transcriber_mode,
      flux_language: hasFluxLang ? flux_language : client.flux_language,
      flux_eot_threshold: hasFluxEot ? fluxEotVal : client.flux_eot_threshold,
      flux_eot_timeout_ms: hasFluxEotMs ? fluxEotMsVal : client.flux_eot_timeout_ms,
      endpointing_provider: hasEndpointing ? endpointing_provider : client.endpointing_provider,
    };
    const finalVoiceId = mergedClient.voice_id || '';
    const finalSpeed = mergedClient.voice_speed;
    // Resolved denoising on/off (default ON when never set).
    const denoisingOn = hasDenoising
      ? background_denoising === true
      : ((client.tool_config && client.tool_config.backgroundDenoising) !== false);

    // ====================================================================
    // VAPI PATCH (static assistant — used by the AI Lab test call + crash
    // fallback). Live calls are built fresh by buildDynamicAssistantConfig,
    // but we keep the static assistant in sync so a test call is faithful.
    // ====================================================================
    const needsVoicePatch = hasVoice || hasSpeed || hasVoiceProvider;
    const needsVapiPatch = hasPrompt || hasGreeting || needsVoicePatch || hasModel || hasTemp || hasTransferPhone || needsPipelinePatch;

    if (needsVapiPatch) {
      if (!client.vapi_assistant_id) {
        return res.status(400).json({ success: false, error: 'Client has no AI assistant configured' });
      }

      // GET current config
      const getResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
      });

      if (!getResponse.ok) {
        return res.status(500).json({ success: false, error: 'Failed to fetch current assistant config from VAPI' });
      }

      const currentAssistant = await getResponse.json();
      const currentModel = currentAssistant.model || {};

      const patchPayload = {};

      // --- model object (prompt, model name, temperature, transfer phone) ---
      if (hasPrompt || hasModel || hasTemp || hasTransferPhone) {
        patchPayload.model = { ...currentModel };

        if (hasPrompt) {
          patchPayload.model.messages = [{ role: 'system', content: system_prompt.trim() }];
        }
        if (hasModel) {
          patchPayload.model.model = model.trim();
        }
        if (hasTemp) {
          patchPayload.model.temperature = temperature;
        }

        // --- Transfer phone: update transferCall tool destination ---
        if (hasTransferPhone) {
          const tools = patchPayload.model.tools || currentModel.tools || [];
          const formattedPhone = formatPhoneForTransfer(transfer_phone.trim());

          if (formattedPhone) {
            const transferIdx = tools.findIndex(t => t.type === 'transferCall');
            if (transferIdx !== -1) {
              // Update existing transferCall tool destination
              const existingTool = { ...tools[transferIdx] };
              if (existingTool.destinations && existingTool.destinations.length > 0) {
                existingTool.destinations = existingTool.destinations.map(d => ({
                  ...d,
                  number: formattedPhone,
                }));
              } else {
                existingTool.destinations = [{
                  type: 'number',
                  number: formattedPhone,
                  description: 'Transfer to business owner',
                  message: 'One moment, let me connect you.',
                }];
              }
              tools[transferIdx] = existingTool;
            } else {
              // No transferCall tool exists — add one
              tools.push({
                type: 'transferCall',
                destinations: [{
                  type: 'number',
                  number: formattedPhone,
                  description: 'Transfer to business owner',
                  message: 'One moment, let me connect you.',
                }],
              });
            }
            patchPayload.model.tools = tools;
          }
        }
      }

      // --- firstMessage ---
      if (hasGreeting) {
        patchPayload.firstMessage = first_message.trim();
      }

      // --- voice (provider / voiceId / speed) ---
      // Rebuilt from the merged state via the shared builder helper so a provider
      // switch (e.g. to Cartesia) replaces the whole voice block rather than
      // leaving stale ElevenLabs fields behind.
      if (needsVoicePatch) {
        patchPayload.voice = buildVoice(mergedClient, finalVoiceId, finalSpeed);
      }

      // --- transcriber + endpointing (rebuilt together from merged state) ---
      if (needsPipelinePatch) {
        patchPayload.transcriber = buildTranscriber(mergedClient);
        patchPayload.startSpeakingPlan = buildStartSpeakingPlan(mergedClient);
        patchPayload.backgroundSpeechDenoisingPlan = { smartDenoisingPlan: { enabled: denoisingOn } };
      }

      // PATCH VAPI
      const patchResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(patchPayload),
      });

      if (!patchResponse.ok) {
        const errorText = await patchResponse.text();
        console.error('VAPI update failed:', patchResponse.status, errorText);
        return res.status(500).json({ success: false, error: 'Failed to update assistant in VAPI', details: errorText });
      }
    }

    // ====================================================================
    // SUPABASE — persist everything the live-call builder reads. model +
    // temperature now land here too (previously VAPI-only) so live calls honor
    // the per-client choice, not just the test call.
    // ====================================================================
    const supabaseUpdate = {};
    if (hasPrompt) supabaseUpdate.system_prompt = system_prompt.trim();
    if (hasCallMode) supabaseUpdate.call_mode = call_mode;
    if (hasVoice) supabaseUpdate.voice_id = voice_id.trim();
    if (hasSpeed) supabaseUpdate.voice_speed = speed;
    if (hasModel) supabaseUpdate.llm_model = model.trim();
    if (hasTemp) supabaseUpdate.temperature = temperature;
    if (hasVoiceProvider) supabaseUpdate.voice_provider = voice_provider;
    if (hasTranscriberMode) supabaseUpdate.transcriber_mode = transcriber_mode;
    if (hasFluxLang) supabaseUpdate.flux_language = flux_language;
    if (hasFluxEot) supabaseUpdate.flux_eot_threshold = fluxEotVal;
    if (hasFluxEotMs) supabaseUpdate.flux_eot_timeout_ms = fluxEotMsVal;
    if (hasEndpointing) supabaseUpdate.endpointing_provider = endpointing_provider;

    // Background denoising is a key inside the tool_config jsonb, not a column.
    // Read-merge-write so other tool_config keys are preserved.
    if (hasDenoising) {
      const mergedToolConfig = { ...(client.tool_config || {}), backgroundDenoising: background_denoising === true };
      supabaseUpdate.tool_config = mergedToolConfig;
    }

    if (Object.keys(supabaseUpdate).length > 0) {
      await supabase.from('clients').update(supabaseUpdate).eq('id', clientId);
    }

    // Build response
    const updated = {};
    if (hasPrompt) updated.system_prompt = system_prompt.trim();
    if (hasGreeting) updated.first_message = first_message.trim();
    if (hasVoice) updated.voice_id = voice_id.trim();
    if (hasModel) updated.model = model.trim();
    if (hasTemp) updated.temperature = temperature;
    if (hasCallMode) updated.call_mode = call_mode;
    if (hasTransferPhone) updated.transfer_phone = transfer_phone.trim();
    if (hasSpeed) updated.speed = speed;
    if (hasVoiceProvider) updated.voice_provider = voice_provider;
    if (hasTranscriberMode) updated.transcriber_mode = transcriber_mode;
    if (hasFluxLang) updated.flux_language = flux_language;
    if (hasFluxEot) updated.flux_eot_threshold = fluxEotVal;
    if (hasFluxEotMs) updated.flux_eot_timeout_ms = fluxEotMsVal;
    if (hasEndpointing) updated.endpointing_provider = endpointing_provider;
    if (hasDenoising) updated.background_denoising = background_denoising === true;

    console.log(`✅ AI config updated for ${client.business_name} (${clientId}): ${Object.keys(updated).join(', ')}`);
    res.json({ success: true, updated });
  } catch (error) {
    console.error('Error updating client AI config:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/clients/:clientId/prompt/reset
// ============================================================================
router.post('/:agencyId/clients/:clientId/prompt/reset', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select('id, vapi_assistant_id, industry, business_name')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (error || !client) return res.status(404).json({ success: false, error: 'Client not found' });
    if (!client.vapi_assistant_id) return res.status(400).json({ success: false, error: 'Client has no AI assistant configured' });

    const industryKey = INDUSTRY_MAPPING[client.industry] || 'professional_services';
    const config = INDUSTRY_CONFIGS[industryKey] || INDUSTRY_CONFIGS['professional_services'];
    const defaultPrompt = config.systemPrompt(client.business_name);

    const getResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });

    if (!getResponse.ok) return res.status(500).json({ success: false, error: 'Failed to fetch current assistant config' });

    const currentAssistant = await getResponse.json();
    const updatedModel = { ...currentAssistant.model, messages: [{ role: 'system', content: defaultPrompt }] };

    const patchResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: updatedModel }),
    });

    if (!patchResponse.ok) {
      const errorText = await patchResponse.text();
      return res.status(500).json({ success: false, error: 'Failed to reset prompt in VAPI' });
    }

    await supabase.from('clients').update({ system_prompt: defaultPrompt }).eq('id', clientId);

    console.log(`✅ Prompt reset to ${industryKey} default for ${client.business_name}`);
    res.json({ success: true, system_prompt: defaultPrompt, industry: industryKey });
  } catch (error) {
    console.error('Error resetting client prompt:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// HELPER: Format phone for VAPI transferCall (E.164)
// ============================================================================
function formatPhoneForTransfer(phone) {
  if (!phone) return null;
  // Already E.164
  if (phone.startsWith('+') && phone.length >= 11) return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

module.exports = router;