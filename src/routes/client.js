// ============================================================================
// CLIENT ROUTES - Dashboard Settings & AI Agent Configuration
// VoiceAI Connect Multi-Tenant
// ============================================================================
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { supabase, getClientById } = require('../lib/supabase');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// ============================================================================
// VOICE OPTIONS - For frontend voice selector
// ============================================================================
const VOICE_OPTIONS = [
  // Female voices
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', gender: 'female', description: 'Warm and friendly' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', gender: 'female', description: 'Soft and professional' },
  { id: 'pMsXgVXv3BLzUgSXRplE', name: 'Serena', gender: 'female', description: 'Calm and reassuring' },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', gender: 'female', description: 'Bright and energetic' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', gender: 'female', description: 'Young and cheerful' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', gender: 'female', description: 'Clear and articulate' },
  { id: 'LcfcDJNUP1GQjkzn1xUU', name: 'Emily', gender: 'female', description: 'Warm and welcoming' },
  // Male voices
  { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', gender: 'male', description: 'Friendly and casual' },
  { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris', gender: 'male', description: 'Professional and confident' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', gender: 'male', description: 'Authoritative and clear' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', gender: 'male', description: 'Deep and trustworthy' },
  { id: '29vD33N1CtxCmqQRPOHJ', name: 'Drew', gender: 'male', description: 'Warm and approachable' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', gender: 'male', description: 'Calm and measured' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh', gender: 'male', description: 'Energetic and upbeat' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', gender: 'male', description: 'Mature and refined' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam', gender: 'male', description: 'Young and dynamic' },
];

// ============================================================================
// GET /api/client/:id - Full client data with agency
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: client, error } = await supabase
      .from('clients')
      .select(`
        *,
        agency:agencies (
          id, name, slug, 
          primary_color, secondary_color, accent_color,
          logo_url, support_email, support_phone
        )
      `)
      .eq('id', id)
      .single();

    if (error || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({ client });
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
    const { email, owner_phone } = req.body;

    const updates = {};
    if (email) updates.email = email;
    if (owner_phone) updates.owner_phone = owner_phone;

    const { data, error } = await supabase
      .from('clients')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, client: data });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/voices - List available voices
// ============================================================================
router.get('/voices', async (req, res) => {
  res.json(VOICE_OPTIONS);
});

// ============================================================================
// GET /api/client/:id/voice - Get current voice
// ============================================================================
router.get('/:id/voice', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: client } = await supabase
      .from('clients')
      .select('vapi_assistant_id, voice_id')
      .eq('id', id)
      .single();

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // If we have cached voice_id, return it
    if (client.voice_id) {
      const voice = VOICE_OPTIONS.find(v => v.id === client.voice_id);
      return res.json({ voiceId: client.voice_id, voice });
    }

    // Otherwise fetch from VAPI
    if (client.vapi_assistant_id) {
      const response = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
      });

      if (response.ok) {
        const assistant = await response.json();
        const voiceId = assistant.voice?.voiceId;
        const voice = VOICE_OPTIONS.find(v => v.id === voiceId);
        return res.json({ voiceId, voice });
      }
    }

    res.json({ voiceId: null, voice: null });
  } catch (error) {
    console.error('Error fetching voice:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/voice - Update voice
// ============================================================================
router.put('/:id/voice', async (req, res) => {
  try {
    const { id } = req.params;
    const { voiceId } = req.body;

    if (!voiceId) {
      return res.status(400).json({ error: 'voiceId required' });
    }

    // Validate voice ID
    const validVoice = VOICE_OPTIONS.find(v => v.id === voiceId);
    if (!validVoice) {
      return res.status(400).json({ error: 'Invalid voice ID' });
    }

    const { data: client } = await supabase
      .from('clients')
      .select('vapi_assistant_id')
      .eq('id', id)
      .single();

    if (!client?.vapi_assistant_id) {
      return res.status(404).json({ error: 'Client or assistant not found' });
    }

    // Update VAPI assistant
    const vapiResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        voice: {
          provider: '11labs',
          voiceId: voiceId
        }
      })
    });

    if (!vapiResponse.ok) {
      const errorText = await vapiResponse.text();
      console.error('VAPI voice update failed:', errorText);
      return res.status(500).json({ error: 'Failed to update voice in VAPI' });
    }

    // Cache in database
    await supabase
      .from('clients')
      .update({ voice_id: voiceId })
      .eq('id', id);

    console.log(`✅ Voice updated for client ${id}: ${validVoice.name}`);
    res.json({ success: true, voice: validVoice });
  } catch (error) {
    console.error('Error updating voice:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/client/:id/greeting - Get greeting message
// ============================================================================
router.get('/:id/greeting', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: client } = await supabase
      .from('clients')
      .select('vapi_assistant_id, greeting_message, business_name')
      .eq('id', id)
      .single();

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Return cached greeting or fetch from VAPI
    if (client.greeting_message) {
      return res.json({ greeting: client.greeting_message });
    }

    if (client.vapi_assistant_id) {
      const response = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
      });

      if (response.ok) {
        const assistant = await response.json();
        return res.json({ 
          greeting: assistant.firstMessage,
          default: `Hi, you've reached ${client.business_name}. This call may be recorded. How can I help you today?`
        });
      }
    }

    res.json({ 
      greeting: null,
      default: `Hi, you've reached ${client.business_name}. This call may be recorded. How can I help you today?`
    });
  } catch (error) {
    console.error('Error fetching greeting:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/greeting - Update greeting message
// ============================================================================
router.put('/:id/greeting', async (req, res) => {
  try {
    const { id } = req.params;
    const { greeting } = req.body;

    if (!greeting) {
      return res.status(400).json({ error: 'greeting required' });
    }

    const { data: client } = await supabase
      .from('clients')
      .select('vapi_assistant_id')
      .eq('id', id)
      .single();

    if (!client?.vapi_assistant_id) {
      return res.status(404).json({ error: 'Client or assistant not found' });
    }

    // Update VAPI assistant
    const vapiResponse = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        firstMessage: greeting
      })
    });

    if (!vapiResponse.ok) {
      const errorText = await vapiResponse.text();
      console.error('VAPI greeting update failed:', errorText);
      return res.status(500).json({ error: 'Failed to update greeting in VAPI' });
    }

    // Cache in database
    await supabase
      .from('clients')
      .update({ greeting_message: greeting })
      .eq('id', id);

    console.log(`✅ Greeting updated for client ${id}`);
    res.json({ success: true, greeting });
  } catch (error) {
    console.error('Error updating greeting:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/business-hours - Update business hours
// ============================================================================
router.put('/:id/business-hours', async (req, res) => {
  try {
    const { id } = req.params;
    const { businessHours } = req.body;

    // businessHours is an object like:
    // { monday: { enabled: true, open: '9:00 AM', close: '5:00 PM' }, ... }

    const { error } = await supabase
      .from('clients')
      .update({ business_hours: businessHours })
      .eq('id', id);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    console.log(`✅ Business hours updated for client ${id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating business hours:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/client/:id/knowledge-base - Get knowledge base content
// ============================================================================
router.get('/:id/knowledge-base', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: client } = await supabase
      .from('clients')
      .select('knowledge_base_data, knowledge_base_id, knowledge_base_updated_at')
      .eq('id', id)
      .single();

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({
      data: client.knowledge_base_data || {},
      knowledgeBaseId: client.knowledge_base_id,
      updatedAt: client.knowledge_base_updated_at
    });
  } catch (error) {
    console.error('Error fetching knowledge base:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/knowledge-base - Update knowledge base
// Uses existing updateKnowledgeBase logic
// ============================================================================
router.put('/:id/knowledge-base', async (req, res) => {
  const { updateKnowledgeBase } = require('./knowledge-base');
  
  // Add clientId to body from params
  req.body.clientId = req.params.id;
  
  return updateKnowledgeBase(req, res);
});

// ============================================================================
// GET /api/client/:id/calls - Get client calls with stats
// ============================================================================
router.get('/:id/calls', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: calls, error } = await supabase
      .from('calls')
      .select('*')
      .eq('client_id', id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Calculate stats
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const callsThisMonth = (calls || []).filter(
      c => new Date(c.created_at) >= startOfMonth
    ).length;

    const highUrgency = (calls || []).filter(
      c => c.urgency_level === 'high' || c.urgency_level === 'emergency'
    ).length;

    res.json({
      calls: calls || [],
      stats: {
        callsThisMonth,
        highUrgency,
        total: (calls || []).length,
      }
    });
  } catch (error) {
    console.error('Error fetching calls:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.VOICE_OPTIONS = VOICE_OPTIONS;