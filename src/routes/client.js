// ============================================================================
// CLIENT ROUTES - Dashboard Settings & AI Agent Configuration
// VoiceAI Connect Multi-Tenant
// UPDATED: Branding now uses flat columns instead of broken branding_overrides JSONB
// UPDATED: 2026-05-18 — Phase 1: ai-settings endpoints (tone, booking mode,
//          service areas, priority rules, dashboard access)
// UPDATED: 2026-05-22 — Added allow_client_branding to agency select
// ============================================================================
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { supabase, getClientById } = require('../lib/supabase');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// ============================================================================
// VOICE OPTIONS
// ============================================================================
const VOICE_OPTIONS = [
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', gender: 'female', accent: 'American', style: 'Soft', description: 'Mature, reassuring, and confident. Great for medical and professional services.', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/01a3e33c-6e99-4ee7-8543-ff2216a32186.mp3', recommended: true },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', gender: 'female', accent: 'American', style: 'Warm', description: 'Knowledgeable and professional. Perfect for retail and hospitality.', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b930e18d-6b4d-466e-bab2-0ae97c6d8535.mp3', recommended: true },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', gender: 'female', accent: 'British', style: 'Raspy', description: 'Velvety actress voice. Sophisticated British accent for upscale businesses.', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/pFZP5JQG7iQjIQuC4Bku/89b68b35-b3dd-4348-a84a-a3c13a3c2b30.mp3' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', gender: 'female', accent: 'British', style: 'Confident', description: 'Clear, engaging educator voice. Great for corporate environments.', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/d10f7534-11f6-41fe-a012-2de1e482d336.mp3' },
  { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', gender: 'male', accent: 'Australian', style: 'Casual', description: 'Deep, confident, and energetic. Officially tagged for conversational AI.', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/IKne3meq5aSn9XLyUdCD/102de6f2-22ed-43e0-a1f1-111fa75c5481.mp3' },
  { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris', gender: 'male', accent: 'American', style: 'Casual', description: 'Charming and down-to-earth. Officially tagged for conversational AI.', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/iP95p4xoKVk53GoZ742B/3f4bde72-cc48-40dd-829f-57fbf906f4d7.mp3', recommended: true },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', gender: 'male', accent: 'American', style: 'Deep', description: 'Deep, resonant, and comforting. Great for professional and corporate.', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/nPczCjzI2devNBz1zQrb/2dd3e72c-4fd3-42f1-93ea-abc5d4e5aa1d.mp3' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', gender: 'male', accent: 'American', style: 'Deep', description: 'Dominant and firm. Excellent for narration and professional use.', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/pNInz6obpgDQGcFmaJgB/d6905d7a-dd26-4187-bfff-1bd3a5ea7cac.mp3' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', gender: 'male', accent: 'British', style: 'Deep', description: 'Steady broadcaster voice. Sophisticated British for premium businesses.', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/onwK4e9ZLuTAKqWW03F9/7eee0236-1a72-4b86-b303-5dcadc007ba9.mp3' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam', gender: 'male', accent: 'American', style: 'Young', description: 'Energetic social media creator voice. Perfect for trendy businesses.', previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/63148076-6363-42db-aea8-31424308b92c.mp3' },
];

// ============================================================================
// GET /api/client/:id - Full client data with agency
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: client, error } = await supabase
      .from('clients')
      .select(`*, agency:agencies!clients_agency_id_fkey ( id, name, slug, primary_color, secondary_color, accent_color, logo_url, support_email, support_phone, website_theme, client_header_mode, price_starter, price_pro, price_growth, limit_starter, limit_pro, limit_growth, plan_features, allow_client_branding )`)
      .eq('id', id)
      .single();
    if (error || !client) return res.status(404).json({ error: 'Client not found' });
    res.json({ client, agency: client.agency });
  } catch (error) {
    console.error('Error fetching client:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/settings - Update client settings
// ============================================================================
router.put('/:id/settings', async (req, res) => {
  try {
    const { id } = req.params;
    const { email, owner_phone, business_name, hipaa_mode } = req.body;
    const updates = {};
    if (email) updates.email = email;
    if (owner_phone) updates.owner_phone = owner_phone;
    if (business_name !== undefined && business_name.trim()) updates.business_name = business_name.trim();
    if (hipaa_mode !== undefined) updates.hipaa_mode = hipaa_mode === true;    const { data, error } = await supabase.from('clients').update(updates).eq('id', id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, client: data });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/branding - Update client-level branding
// ============================================================================
router.put('/:id/branding', async (req, res) => {
  try {
    const { id } = req.params;
    const { logo_url, business_name, primary_color, secondary_color, accent_color, nav_bg, nav_text, button_text, page_bg, card_bg, card_border, theme_mode } = req.body;
    const updates = {};
    if (logo_url !== undefined) updates.logo_url = logo_url || null;
    if (primary_color !== undefined) updates.primary_color = primary_color || null;
    if (secondary_color !== undefined) updates.secondary_color = secondary_color || null;
    if (accent_color !== undefined) updates.accent_color = accent_color || null;
    if (business_name !== undefined && business_name.trim()) updates.business_name = business_name.trim();
    if (hipaa_mode !== undefined) updates.hipaa_mode = hipaa_mode === true;    if (nav_bg !== undefined) updates.nav_bg = nav_bg || null;
    if (nav_text !== undefined) updates.nav_text = nav_text || null;
    if (button_text !== undefined) updates.button_text = button_text || null;
    if (page_bg !== undefined) updates.page_bg = page_bg || null;
    if (card_bg !== undefined) updates.card_bg = card_bg || null;
    if (card_border !== undefined) updates.card_border = card_border || null;
    if (theme_mode !== undefined) updates.theme_mode = theme_mode || null;
    if (Object.keys(updates).length === 0) return res.status(400).json({ success: false, error: 'No fields to update' });
    const { data, error } = await supabase.from('clients').update(updates).eq('id', id).select('*').single();
    if (error) { console.error('Supabase branding update error:', error); return res.status(400).json({ success: false, error: error.message }); }
    console.log(`✅ Client branding updated for ${id}: ${Object.keys(updates).join(', ')}`);
    res.json({ success: true, client: data });
  } catch (error) {
    console.error('Error updating client branding:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// GET /api/client/:id/voice - Get current voice
// ============================================================================
router.get('/:id/voice', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: client } = await supabase.from('clients').select('vapi_assistant_id, voice_id').eq('id', id).single();
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });
    if (client.voice_id) {
      const voice = VOICE_OPTIONS.find(v => v.id === client.voice_id);
      return res.json({ success: true, voice_id: client.voice_id, voice });
    }
    if (client.vapi_assistant_id) {
      const response = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, { headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` } });
      if (response.ok) { const assistant = await response.json(); const voiceId = assistant.voice?.voiceId; const voice = VOICE_OPTIONS.find(v => v.id === voiceId); return res.json({ success: true, voice_id: voiceId, voice }); }
    }
    res.json({ success: true, voice_id: null, voice: null });
  } catch (error) { console.error('Error fetching voice:', error); res.status(500).json({ success: false, error: 'Server error' }); }
});

// ============================================================================
// PUT /api/client/:id/voice - Update voice
// ============================================================================
router.put('/:id/voice', async (req, res) => {
  try {
    const { id } = req.params;
    const voiceId = req.body.voice_id || req.body.voiceId;
    if (!voiceId) return res.status(400).json({ success: false, error: 'voice_id required' });
    const validVoice = VOICE_OPTIONS.find(v => v.id === voiceId);
    if (!validVoice) return res.status(400).json({ success: false, error: 'Invalid voice ID' });
    const { data: client } = await supabase.from('clients').select('vapi_assistant_id').eq('id', id).single();
    if (!client?.vapi_assistant_id) return res.status(404).json({ success: false, error: 'Client or assistant not found' });
    const vapiResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, { method: 'PATCH', headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: { provider: '11labs', voiceId: voiceId } }) });
    if (!vapiResponse.ok) { const errorText = await vapiResponse.text(); console.error('VAPI voice update failed:', errorText); return res.status(500).json({ success: false, error: 'Failed to update voice in VAPI' }); }
    await supabase.from('clients').update({ voice_id: voiceId }).eq('id', id);
    console.log(`✅ Voice updated for client ${id}: ${validVoice.name}`);
    res.json({ success: true, voice: validVoice });
  } catch (error) { console.error('Error updating voice:', error); res.status(500).json({ success: false, error: 'Server error' }); }
});

// ============================================================================
// GET /api/client/:id/greeting
// ============================================================================
router.get('/:id/greeting', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: client } = await supabase.from('clients').select('vapi_assistant_id, greeting_message, business_name').eq('id', id).single();
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });
    const defaultGreeting = `Hi, you've reached ${client.business_name}. This call may be recorded for quality and training purposes. How can I help you today?`;
    if (client.greeting_message) return res.json({ success: true, greeting_message: client.greeting_message, default_greeting: defaultGreeting });
    if (client.vapi_assistant_id) {
      const response = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, { headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` } });
      if (response.ok) { const assistant = await response.json(); return res.json({ success: true, greeting_message: assistant.firstMessage || defaultGreeting, default_greeting: defaultGreeting }); }
    }
    res.json({ success: true, greeting_message: defaultGreeting, default_greeting: defaultGreeting });
  } catch (error) { console.error('Error fetching greeting:', error); res.status(500).json({ success: false, error: 'Server error' }); }
});

// ============================================================================
// PUT /api/client/:id/greeting
// ============================================================================
router.put('/:id/greeting', async (req, res) => {
  try {
    const { id } = req.params;
    const greeting = req.body.greeting_message || req.body.greeting;
    if (!greeting) return res.status(400).json({ success: false, error: 'greeting_message required' });
    const { data: client } = await supabase.from('clients').select('vapi_assistant_id').eq('id', id).single();
    if (!client?.vapi_assistant_id) return res.status(404).json({ success: false, error: 'Client or assistant not found' });
    const vapiResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, { method: 'PATCH', headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ firstMessage: greeting }) });
    if (!vapiResponse.ok) { const errorText = await vapiResponse.text(); console.error('VAPI greeting update failed:', errorText); return res.status(500).json({ success: false, error: 'Failed to update greeting in VAPI' }); }
    await supabase.from('clients').update({ greeting_message: greeting }).eq('id', id);
    console.log(`✅ Greeting updated for client ${id}`);
    res.json({ success: true, greeting_message: greeting });
  } catch (error) { console.error('Error updating greeting:', error); res.status(500).json({ success: false, error: 'Server error' }); }
});

// ============================================================================
// PUT /api/client/:id/business-hours
// ============================================================================
router.put('/:id/business-hours', async (req, res) => {
  try {
    const { id } = req.params;
    const businessHours = req.body.business_hours || req.body.businessHours;
    if (!businessHours) return res.status(400).json({ success: false, error: 'business_hours required' });
    const { error } = await supabase.from('clients').update({ business_hours: businessHours }).eq('id', id);
    if (error) return res.status(400).json({ success: false, error: error.message });
    console.log(`✅ Business hours updated for client ${id}`);
    res.json({ success: true });
  } catch (error) { console.error('Error updating business hours:', error); res.status(500).json({ success: false, error: 'Server error' }); }
});

// ============================================================================
// GET /api/client/:id/knowledge-base
// ============================================================================
router.get('/:id/knowledge-base', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: client } = await supabase.from('clients').select('knowledge_base_data, knowledge_base_id, knowledge_base_updated_at, business_website').eq('id', id).single();
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });
    let data = {};
    if (client.knowledge_base_data) {
      if (typeof client.knowledge_base_data === 'string') { data = { additionalInfo: client.knowledge_base_data }; }
      else if (client.knowledge_base_data.content && typeof client.knowledge_base_data.content === 'string') { data = { additionalInfo: client.knowledge_base_data.content }; }
      else { data = { services: client.knowledge_base_data.services || '', faqs: client.knowledge_base_data.faqs || '', businessHours: client.knowledge_base_data.businessHours || '', additionalInfo: client.knowledge_base_data.additionalInfo || '' }; }
    }
    res.json({ success: true, data, websiteUrl: client.business_website || '', knowledge_base_id: client.knowledge_base_id, updated_at: client.knowledge_base_updated_at });
  } catch (error) { console.error('Error fetching knowledge base:', error); res.status(500).json({ success: false, error: 'Server error' }); }
});

// ============================================================================
// PUT /api/client/:id/knowledge-base
// ============================================================================
router.put('/:id/knowledge-base', async (req, res) => {
  try {
    const { id } = req.params;
    const { content, services, faqs, businessHours, additionalInfo } = req.body;
    let knowledgeBaseData;
    if (content !== undefined) { knowledgeBaseData = { content }; }
    else { knowledgeBaseData = { services: services || '', faqs: faqs || '', businessHours: businessHours || '', additionalInfo: additionalInfo || '' }; }
    const { error } = await supabase.from('clients').update({ knowledge_base_data: knowledgeBaseData, knowledge_base_updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return res.status(400).json({ success: false, error: error.message });
    console.log(`✅ Knowledge base updated for client ${id}`);
    res.json({ success: true });
  } catch (error) { console.error('Error updating knowledge base:', error); res.status(500).json({ success: false, error: 'Server error' }); }
});

// ============================================================================
// GET /api/client/:id/calls/:callId - Single call detail
// ============================================================================
router.get('/:id/calls/:callId', async (req, res) => {
  try {
    const { id, callId } = req.params;
    const { data: call, error } = await supabase.from('calls').select('*').eq('id', callId).eq('client_id', id).single();
    if (error || !call) return res.status(404).json({ error: 'Call not found' });
    res.json({ call });
  } catch (error) { console.error('Error fetching call:', error); res.status(500).json({ error: 'Server error' }); }
});

// ============================================================================
// GET /api/client/:id/calls - Client calls with stats
// ============================================================================
router.get('/:id/calls', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: calls, error } = await supabase.from('calls').select('*').eq('client_id', id).order('created_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
    const callsThisMonth = (calls || []).filter(c => new Date(c.created_at) >= startOfMonth).length;
    const highUrgency = (calls || []).filter(c => c.urgency_level === 'high' || c.urgency_level === 'emergency').length;
    res.json({ calls: calls || [], stats: { callsThisMonth, highUrgency, total: (calls || []).length } });
  } catch (error) { console.error('Error fetching calls:', error); res.status(500).json({ error: 'Server error' }); }
});

// ============================================================================
// PHASE 1: AI SETTINGS ENDPOINTS
// ============================================================================

// GET /api/client/:id/ai-settings
router.get('/:id/ai-settings', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: client, error } = await supabase
      .from('clients')
      .select('ai_tone, booking_mode, dashboard_access, service_areas, priority_rules')
      .eq('id', id)
      .single();
    if (error || !client) return res.status(404).json({ error: 'Client not found' });
    res.json({
      success: true,
      settings: {
        ai_tone: client.ai_tone || 'professional',
        booking_mode: client.booking_mode || 'auto_book',
        dashboard_access: client.dashboard_access || 'full',
        service_areas: client.service_areas || [],
        priority_rules: client.priority_rules || {},
      }
    });
  } catch (error) { console.error('Error fetching AI settings:', error); res.status(500).json({ error: 'Server error' }); }
});

// PUT /api/client/:id/ai-settings
router.put('/:id/ai-settings', async (req, res) => {
  try {
    const { id } = req.params;
    const { ai_tone, booking_mode, service_areas, priority_rules } = req.body;
    const updates = {};

    if (ai_tone !== undefined) {
      if (!['professional', 'friendly', 'casual', 'clinical'].includes(ai_tone)) return res.status(400).json({ error: 'Invalid ai_tone. Must be: professional, friendly, casual, or clinical' });
      updates.ai_tone = ai_tone;
    }
    if (booking_mode !== undefined) {
      if (!['auto_book', 'collect_request', 'disabled'].includes(booking_mode)) return res.status(400).json({ error: 'Invalid booking_mode. Must be: auto_book, collect_request, or disabled' });
      updates.booking_mode = booking_mode;
    }
    if (service_areas !== undefined) {
      if (!Array.isArray(service_areas)) return res.status(400).json({ error: 'service_areas must be an array' });
      updates.service_areas = service_areas;
    }
    if (priority_rules !== undefined) {
      if (typeof priority_rules !== 'object' || Array.isArray(priority_rules)) return res.status(400).json({ error: 'priority_rules must be an object' });
      updates.priority_rules = priority_rules;
    }

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from('clients').update(updates).eq('id', id).select('id, ai_tone, booking_mode, service_areas, priority_rules').single();
    if (error) { console.error('AI settings update error:', error); return res.status(400).json({ error: error.message }); }
    console.log(`✅ AI settings updated for client ${id}: ${Object.keys(updates).filter(k => k !== 'updated_at').join(', ')}`);
    res.json({ success: true, settings: data });
  } catch (error) { console.error('Error updating AI settings:', error); res.status(500).json({ error: 'Server error' }); }
});

// PUT /api/client/:id/dashboard-access — Agency sets client access level
router.put('/:id/dashboard-access', async (req, res) => {
  try {
    const { id } = req.params;
    const { dashboard_access } = req.body;
    if (!dashboard_access || !['full', 'read_only', 'none'].includes(dashboard_access)) {
      return res.status(400).json({ error: 'Invalid dashboard_access. Must be: full, read_only, or none' });
    }
    const { data, error } = await supabase.from('clients').update({ dashboard_access, updated_at: new Date().toISOString() }).eq('id', id).select('id, business_name, dashboard_access').single();
    if (error) return res.status(400).json({ error: error.message });
    console.log(`✅ Dashboard access set to '${dashboard_access}' for client ${data.business_name}`);
    res.json({ success: true, client: data });
  } catch (error) { console.error('Error updating dashboard access:', error); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
module.exports.VOICE_OPTIONS = VOICE_OPTIONS;