// ============================================================================
// CLIENT ROUTES - Dashboard Settings & AI Agent Configuration
// VoiceAI Connect Multi-Tenant
// UPDATED: Fixed response formats to match frontend expectations
// ============================================================================
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { supabase, getClientById } = require('../lib/supabase');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// ============================================================================
// VOICE OPTIONS - Complete metadata for frontend voice selector
// ============================================================================
const VOICE_OPTIONS = [
  // Female voices
  { 
    id: '21m00Tcm4TlvDq8ikWAM', 
    name: 'Rachel', 
    gender: 'female', 
    accent: 'American',
    style: 'Calm',
    description: 'Warm and professional. Perfect all-purpose receptionist voice.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/21m00Tcm4TlvDq8ikWAM/df6788f9-5c96-470d-8312-aab3b3d8f50a.mp3',
    recommended: true
  },
  { 
    id: 'EXAVITQu4vr4xnSDxMaL', 
    name: 'Sarah', 
    gender: 'female', 
    accent: 'American',
    style: 'Soft',
    description: 'Gentle and reassuring. Great for medical and professional services.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/6851ec91-9950-471f-8586-357c52539069.mp3',
    recommended: true
  },
  { 
    id: 'pMsXgVXv3BLzUgSXRplE', 
    name: 'Serena', 
    gender: 'female', 
    accent: 'American',
    style: 'Pleasant',
    description: 'Engaging and interactive. Built for back-and-forth conversations.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/pMsXgVXv3BLzUgSXRplE/d61f18ed-e5b0-4d0b-a33c-5c6e7e33b053.mp3',
    recommended: true
  },
  { 
    id: 'XrExE9yKIg1WjnnlVkGX', 
    name: 'Matilda', 
    gender: 'female', 
    accent: 'American',
    style: 'Warm',
    description: 'Friendly and approachable. Perfect for retail and hospitality.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b930e18d-6b4d-466e-bab2-0ae97c6d8535.mp3'
  },
  { 
    id: 'pFZP5JQG7iQjIQuC4Bku', 
    name: 'Lily', 
    gender: 'female', 
    accent: 'British',
    style: 'Raspy',
    description: 'Sophisticated British accent. Great for upscale businesses.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/pFZP5JQG7iQjIQuC4Bku/d10f7534-11f6-41fe-a012-2de1e482d336.mp3'
  },
  { 
    id: 'Xb7hH8MSUJpSbSDYk0k2', 
    name: 'Alice', 
    gender: 'female', 
    accent: 'British',
    style: 'Confident',
    description: 'Clear and authoritative. Great for corporate environments.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/42a5afce-c06c-4a26-b1ea-50d4c423a8f8.mp3'
  },
  { 
    id: 'LcfcDJNUP1GQjkzn1xUU', 
    name: 'Emily', 
    gender: 'female', 
    accent: 'American',
    style: 'Calm',
    description: 'Warm and welcoming. Perfect for wellness and spa.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/LcfcDJNUP1GQjkzn1xUU/e4b994e7-9713-4238-84f3-add8cccb7ec0.mp3'
  },
  
  // Male voices
  { 
    id: 'IKne3meq5aSn9XLyUdCD', 
    name: 'Charlie', 
    gender: 'male', 
    accent: 'Australian',
    style: 'Casual',
    description: 'Friendly and conversational. Officially tagged for conversational AI.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/IKne3meq5aSn9XLyUdCD/102de6f2-22ed-43e0-a1f1-111fa75c5481.mp3',
    recommended: true
  },
  { 
    id: 'iP95p4xoKVk53GoZ742B', 
    name: 'Chris', 
    gender: 'male', 
    accent: 'American',
    style: 'Casual',
    description: 'Natural and easygoing. Officially tagged for conversational AI.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/iP95p4xoKVk53GoZ742B/c1bda571-7123-418e-a796-a2b464b373b4.mp3',
    recommended: true
  },
  { 
    id: 'nPczCjzI2devNBz1zQrb', 
    name: 'Brian', 
    gender: 'male', 
    accent: 'American',
    style: 'Deep',
    description: 'Deep and trustworthy. Great for professional and corporate.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/nPczCjzI2devNBz1zQrb/f4dbda0c-aff0-45c0-93fa-f5d5ec95a2eb.mp3'
  },
  { 
    id: 'pNInz6obpgDQGcFmaJgB', 
    name: 'Adam', 
    gender: 'male', 
    accent: 'American',
    style: 'Deep',
    description: 'Authoritative and clear. Excellent for narration and professional use.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/pNInz6obpgDQGcFmaJgB/38a69695-2ca9-4b9e-b9ec-f07ced494a58.mp3'
  },
  { 
    id: '29vD33N1CtxCmqQRPOHJ', 
    name: 'Drew', 
    gender: 'male', 
    accent: 'American',
    style: 'Well-rounded',
    description: 'Balanced and professional. Works well across industries.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/29vD33N1CtxCmqQRPOHJ/e8b52a3f-9732-440f-b78a-16d5e26407a1.mp3'
  },
  { 
    id: 'onwK4e9ZLuTAKqWW03F9', 
    name: 'Daniel', 
    gender: 'male', 
    accent: 'British',
    style: 'Deep',
    description: 'Sophisticated British voice. Perfect for premium businesses.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/onwK4e9ZLuTAKqWW03F9/7eee0236-1a72-4b86-b303-5dcadc007ba9.mp3'
  },
  { 
    id: 'TxGEqnHWrfWFTfGW9XjX', 
    name: 'Josh', 
    gender: 'male', 
    accent: 'American',
    style: 'Deep',
    description: 'Younger professional voice. Great for tech and modern businesses.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/TxGEqnHWrfWFTfGW9XjX/3ae2fc71-d5f9-4769-bb71-2a43633cd186.mp3'
  },
  { 
    id: 'JBFqnCBsd6RMkjVDRZzb', 
    name: 'George', 
    gender: 'male', 
    accent: 'British',
    style: 'Raspy',
    description: 'Distinguished British voice with character. Great for storytelling.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/JBFqnCBsd6RMkjVDRZzb/365e8ae8-5364-4b07-9a3b-1bfb4a390248.mp3'
  },
  { 
    id: 'TX3LPaxmHKxFdv7VOQHJ', 
    name: 'Liam', 
    gender: 'male', 
    accent: 'American',
    style: 'Young',
    description: 'Energetic younger voice. Perfect for trendy businesses.',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/63148076-6363-42db-aea8-31424308b92c.mp3'
  },
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
// GET /api/client/:id/voice - Get current voice
// FIXED: Response format to match frontend expectations
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
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    // If we have cached voice_id, return it
    if (client.voice_id) {
      const voice = VOICE_OPTIONS.find(v => v.id === client.voice_id);
      return res.json({ 
        success: true, 
        voice_id: client.voice_id, 
        voice 
      });
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
        return res.json({ 
          success: true, 
          voice_id: voiceId, 
          voice 
        });
      }
    }

    res.json({ success: true, voice_id: null, voice: null });
  } catch (error) {
    console.error('Error fetching voice:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/voice - Update voice
// FIXED: Accept both voice_id and voiceId from request body
// ============================================================================
router.put('/:id/voice', async (req, res) => {
  try {
    const { id } = req.params;
    // Accept both field names for compatibility
    const voiceId = req.body.voice_id || req.body.voiceId;

    if (!voiceId) {
      return res.status(400).json({ success: false, error: 'voice_id required' });
    }

    // Validate voice ID
    const validVoice = VOICE_OPTIONS.find(v => v.id === voiceId);
    if (!validVoice) {
      return res.status(400).json({ success: false, error: 'Invalid voice ID' });
    }

    const { data: client } = await supabase
      .from('clients')
      .select('vapi_assistant_id')
      .eq('id', id)
      .single();

    if (!client?.vapi_assistant_id) {
      return res.status(404).json({ success: false, error: 'Client or assistant not found' });
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
      return res.status(500).json({ success: false, error: 'Failed to update voice in VAPI' });
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
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// GET /api/client/:id/greeting - Get greeting message
// FIXED: Response format to match frontend expectations
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
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    const defaultGreeting = `Hi, you've reached ${client.business_name}. This call may be recorded for quality and training purposes. How can I help you today?`;

    // Return cached greeting or fetch from VAPI
    if (client.greeting_message) {
      return res.json({ 
        success: true, 
        greeting_message: client.greeting_message,
        default_greeting: defaultGreeting
      });
    }

    if (client.vapi_assistant_id) {
      const response = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
      });

      if (response.ok) {
        const assistant = await response.json();
        return res.json({ 
          success: true,
          greeting_message: assistant.firstMessage || defaultGreeting,
          default_greeting: defaultGreeting
        });
      }
    }

    res.json({ 
      success: true,
      greeting_message: defaultGreeting,
      default_greeting: defaultGreeting
    });
  } catch (error) {
    console.error('Error fetching greeting:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/greeting - Update greeting message
// FIXED: Accept both greeting_message and greeting from request body
// ============================================================================
router.put('/:id/greeting', async (req, res) => {
  try {
    const { id } = req.params;
    // Accept both field names for compatibility
    const greeting = req.body.greeting_message || req.body.greeting;

    if (!greeting) {
      return res.status(400).json({ success: false, error: 'greeting_message required' });
    }

    const { data: client } = await supabase
      .from('clients')
      .select('vapi_assistant_id')
      .eq('id', id)
      .single();

    if (!client?.vapi_assistant_id) {
      return res.status(404).json({ success: false, error: 'Client or assistant not found' });
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
      return res.status(500).json({ success: false, error: 'Failed to update greeting in VAPI' });
    }

    // Cache in database
    await supabase
      .from('clients')
      .update({ greeting_message: greeting })
      .eq('id', id);

    console.log(`✅ Greeting updated for client ${id}`);
    res.json({ success: true, greeting_message: greeting });
  } catch (error) {
    console.error('Error updating greeting:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/business-hours - Update business hours
// FIXED: Accept both businessHours and business_hours from request body
// ============================================================================
router.put('/:id/business-hours', async (req, res) => {
  try {
    const { id } = req.params;
    // Accept both field names for compatibility
    const businessHours = req.body.business_hours || req.body.businessHours;

    if (!businessHours) {
      return res.status(400).json({ success: false, error: 'business_hours required' });
    }

    const { error } = await supabase
      .from('clients')
      .update({ business_hours: businessHours })
      .eq('id', id);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    console.log(`✅ Business hours updated for client ${id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating business hours:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// GET /api/client/:id/knowledge-base - Get knowledge base content
// FIXED: Response format to match frontend expectations
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
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    // Extract content from knowledge_base_data if it exists
    let content = '';
    if (client.knowledge_base_data) {
      if (typeof client.knowledge_base_data === 'string') {
        content = client.knowledge_base_data;
      } else if (client.knowledge_base_data.content) {
        content = client.knowledge_base_data.content;
      } else if (client.knowledge_base_data.text) {
        content = client.knowledge_base_data.text;
      }
    }

    res.json({
      success: true,
      content: content,
      knowledge_base_id: client.knowledge_base_id,
      updated_at: client.knowledge_base_updated_at
    });
  } catch (error) {
    console.error('Error fetching knowledge base:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/knowledge-base - Update knowledge base
// ============================================================================
router.put('/:id/knowledge-base', async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (content === undefined) {
      return res.status(400).json({ success: false, error: 'content required' });
    }

    // Store content in knowledge_base_data
    const { error } = await supabase
      .from('clients')
      .update({ 
        knowledge_base_data: { content },
        knowledge_base_updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    // TODO: Update VAPI knowledge base file if needed
    // This would require re-uploading the file to VAPI

    console.log(`✅ Knowledge base updated for client ${id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating knowledge base:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// GET /api/client/:id/calls/:callId - Get single call detail
// IMPORTANT: This must come BEFORE the /:id/calls route
// ============================================================================
router.get('/:id/calls/:callId', async (req, res) => {
  try {
    const { id, callId } = req.params;
    
    const { data: call, error } = await supabase
      .from('calls')
      .select('*')
      .eq('id', callId)
      .eq('client_id', id)
      .single();

    if (error || !call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    res.json({ call });
  } catch (error) {
    console.error('Error fetching call:', error);
    res.status(500).json({ error: 'Server error' });
  }
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