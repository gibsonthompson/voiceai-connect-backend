// ============================================================================
// AGENCY PROMPT TEMPLATES ROUTES
// Enterprise Feature - Custom AI Receptionist Prompts per Industry
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase, getAgencyById } = require('../lib/supabase');

// ============================================================================
// INDUSTRY CONFIGURATION
// Maps frontend industry keys to backend config keys
// ============================================================================
const INDUSTRY_CONFIG = {
  home_services: {
    key: 'home_services',
    label: 'Home Services',
    description: 'Plumbing, HVAC, contractors, handyman services',
    icon: 'Wrench',
  },
  medical_dental: {
    key: 'medical',
    label: 'Medical & Dental',
    description: 'Medical practices, dental offices, healthcare clinics',
    icon: 'Stethoscope',
  },
  legal: {
    key: 'professional_services',
    label: 'Legal Services',
    description: 'Law firms, attorneys, legal consultants',
    icon: 'Scale',
  },
  real_estate: {
    key: 'professional_services',
    label: 'Real Estate',
    description: 'Real estate agents, property management, brokers',
    icon: 'Home',
  },
  financial_services: {
    key: 'professional_services',
    label: 'Financial Services',
    description: 'Accountants, financial advisors, insurance agents',
    icon: 'Calculator',
  },
  professional_services: {
    key: 'professional_services',
    label: 'Professional Services',
    description: 'Consultants, agencies, B2B services',
    icon: 'Briefcase',
  },
  restaurant: {
    key: 'restaurants',
    label: 'Restaurants',
    description: 'Restaurants, cafes, food service, catering',
    icon: 'UtensilsCrossed',
  },
  salon_spa: {
    key: 'salon_spa',
    label: 'Salon & Spa',
    description: 'Hair salons, nail salons, spas, beauty services',
    icon: 'Sparkles',
  },
  fitness: {
    key: 'salon_spa',
    label: 'Fitness & Wellness',
    description: 'Gyms, personal trainers, yoga studios, wellness centers',
    icon: 'Dumbbell',
  },
  retail: {
    key: 'retail',
    label: 'Retail',
    description: 'Retail stores, e-commerce, product sales',
    icon: 'ShoppingBag',
  },
  automotive: {
    key: 'home_services',
    label: 'Automotive',
    description: 'Auto repair, car dealerships, detailing services',
    icon: 'Car',
  },
  other: {
    key: 'professional_services',
    label: 'Other Industries',
    description: 'General business, miscellaneous services',
    icon: 'Building2',
  },
};

// ============================================================================
// ELEVENLABS VOICES (Curated List)
// ============================================================================
const ELEVENLABS_VOICES = [
  { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris', description: 'Warm, friendly male voice - great for home services', gender: 'male' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'Professional, caring female voice - ideal for medical', gender: 'female' },
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', description: 'Warm, welcoming female voice - perfect for hospitality', gender: 'female' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', description: 'Authoritative male voice - suits professional services', gender: 'male' },
  { id: '29vD33N1CtxCmqQRPOHJ', name: 'Drew', description: 'Friendly, conversational male voice', gender: 'male' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', description: 'Deep, trustworthy male voice', gender: 'male' },
  { id: 'yoZ06aMxZJJ28mfd3POQ', name: 'Sam', description: 'Neutral, clear voice - works for any industry', gender: 'neutral' },
  { id: 'jBpfuIE2acCO8z3wKNLl', name: 'Gigi', description: 'Energetic, youthful female voice', gender: 'female' },
  { id: 'jsCqWAovK2LkecY7zXl4', name: 'Freya', description: 'Elegant, sophisticated female voice', gender: 'female' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', description: 'British accent, professional male voice', gender: 'male' },
];

// ============================================================================
// DEFAULT PROMPTS (For reference/reset functionality)
// ============================================================================
const DEFAULT_PROMPTS = {
  home_services: {
    system_prompt: `You are the phone assistant for {businessName}, a home services company.

## YOUR ROLE
Listen to customers' problems, collect their information, and let them know when someone will contact them. Be warm, empathetic, and efficient.

## CONVERSATION FLOW
1. Let them explain their issue without interrupting
2. Show empathy: "I understand" / "That sounds frustrating" / "Let's get that fixed"
3. Collect information one piece at a time:
   - Name: "What's your name?" → "Thanks [name]"
   - Phone: "Best number to reach you?" → "Got it"
   - Address: "What's the property address?" → "Perfect"
   - Issue: "Can you describe what's happening?" → Listen and acknowledge
4. Assess urgency silently (emergency/urgent/routine)
5. Let them know next steps: "Our team will call you back [timeframe]"
6. Ask: "Is there anything else I can help you with?"

## KNOWLEDGE BASE USAGE
When customers ask about services, pricing, hours, or policies, use the 'search_knowledge_base' tool to find accurate information.

## CRITICAL RULE
You do NOT have the ability to end calls. The customer will hang up when they're ready.`,
    first_message: `Hi, you've reached {businessName}. This call may be recorded for quality purposes. What can I help you with today?`,
    voice_id: 'iP95p4xoKVk53GoZ742B', // Chris
  },
  medical: {
    system_prompt: `You are the receptionist for {businessName}, a medical/dental practice.

## YOUR ROLE
Determine patient needs, collect basic HIPAA-compliant information, and route appropriately.

## CONVERSATION FLOW
1. Ask: "Are you a current patient or would this be your first visit?"
2. Collect: Name, date of birth, phone, general reason
3. NEVER ask for specific medical details
4. Assess urgency (emergency → 911, urgent → work in, routine → schedule)

## HIPAA COMPLIANCE
- Only collect: name, DOB, phone, general reason
- If they share medical info: "Our doctor will discuss that at your appointment"

## CRITICAL RULE
You do NOT have the ability to end calls. The patient will hang up when ready.`,
    first_message: `Hello, you've reached {businessName}. This call may be recorded. Are you a current patient or would this be your first visit?`,
    voice_id: 'EXAVITQu4vr4xnSDxMaL', // Sarah
  },
  professional_services: {
    system_prompt: `You are the professional receptionist for {businessName}.

## YOUR ROLE
Greet callers professionally, understand their needs, collect contact information, and route appropriately.

## CONVERSATION FLOW
1. Determine if new or existing client
2. Collect: Name, phone, company (if business), general service needed
3. Assess urgency
4. Confirm details and next steps

## BOUNDARIES
- Never make promises about outcomes
- Never discuss other clients
- Never quote prices without checking

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    first_message: `Hello, you've reached {businessName}. This call may be recorded. How may I help you?`,
    voice_id: 'nPczCjzI2devNBz1zQrb', // Brian
  },
  restaurants: {
    system_prompt: `You are the phone assistant for {businessName}, a restaurant.

## YOUR ROLE
Take reservations, handle takeout orders, answer menu questions.

## CONVERSATION FLOW
1. Ask: "Is this for a reservation or a takeout order?"
2. For reservations: date, time, party size, name, phone
3. For takeout: take order item by item, name, phone
4. Confirm all details

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    first_message: `Hi! You've reached {businessName}. This call may be recorded. How can I help you?`,
    voice_id: '21m00Tcm4TlvDq8ikWAM', // Rachel
  },
  salon_spa: {
    system_prompt: `You are the welcoming receptionist for {businessName}, a salon and spa.

## YOUR ROLE
Book appointments, answer service questions, make clients feel pampered.

## CONVERSATION FLOW
1. Ask: "Are you a new client or have you been here before?"
2. Determine their need (booking, rescheduling, question)
3. For bookings: service, preferred date/time, name, phone
4. Suggest add-ons naturally
5. Confirm appointment details

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    first_message: `Hi! You've reached {businessName}. This call may be recorded. Are you calling to book an appointment?`,
    voice_id: '21m00Tcm4TlvDq8ikWAM', // Rachel
  },
  retail: {
    system_prompt: `You are the phone assistant for {businessName}, a retail store.

## YOUR ROLE
Answer questions, help find products, take orders. Be enthusiastic!

## CONVERSATION FLOW
1. Understand their need (product question, stock check, order, return)
2. Help based on their need using knowledge base
3. Get contact info when needed
4. Confirm orders/details

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    first_message: `Hi! You've reached {businessName}. This call may be recorded. How can I help you today?`,
    voice_id: '21m00Tcm4TlvDq8ikWAM', // Rachel (female_warm)
  },
};

// ============================================================================
// MIDDLEWARE: Check Enterprise Plan
// ============================================================================
async function requireEnterprisePlan(req, res, next) {
  const { agencyId } = req.params;
  
  try {
    const agency = await getAgencyById(agencyId);
    
    if (!agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }
    
    if (agency.plan_type !== 'enterprise') {
      return res.status(403).json({ 
        error: 'Enterprise plan required',
        feature: 'ai_templates',
        current_plan: agency.plan_type,
        upgrade_url: '/agency/settings?tab=billing'
      });
    }
    
    req.agency = agency;
    next();
  } catch (error) {
    console.error('Enterprise check error:', error);
    res.status(500).json({ error: 'Failed to verify plan' });
  }
}

// ============================================================================
// GET /api/agency/:agencyId/templates/industries
// Get list of all industries with their config
// ============================================================================
router.get('/:agencyId/templates/industries', requireEnterprisePlan, async (req, res) => {
  const { agencyId } = req.params;
  
  try {
    // Get existing templates for this agency
    const { data: existingTemplates, error } = await supabase
      .from('agency_prompt_templates')
      .select('industry, is_active, updated_at')
      .eq('agency_id', agencyId);
    
    if (error) throw error;
    
    // Build response with customization status
    const templateMap = {};
    (existingTemplates || []).forEach(t => {
      templateMap[t.industry] = {
        hasCustom: true,
        isActive: t.is_active,
        updatedAt: t.updated_at,
      };
    });
    
    const industries = Object.entries(INDUSTRY_CONFIG).map(([frontendKey, config]) => ({
      frontendKey,
      backendKey: config.key,
      label: config.label,
      description: config.description,
      icon: config.icon,
      hasCustomTemplate: !!templateMap[config.key],
      isActive: templateMap[config.key]?.isActive ?? true,
      updatedAt: templateMap[config.key]?.updatedAt || null,
    }));
    
    res.json({ industries });
  } catch (error) {
    console.error('Error fetching industries:', error);
    res.status(500).json({ error: 'Failed to fetch industries' });
  }
});

// ============================================================================
// GET /api/agency/:agencyId/templates/voices
// Get available ElevenLabs voices
// ============================================================================
router.get('/:agencyId/templates/voices', requireEnterprisePlan, (req, res) => {
  res.json({ 
    voices: ELEVENLABS_VOICES,
    provider: 'ElevenLabs',
    note: 'All voices are powered by ElevenLabs text-to-speech technology.'
  });
});

// ============================================================================
// GET /api/agency/:agencyId/templates/:industry
// Get template for specific industry (custom or default)
// ============================================================================
router.get('/:agencyId/templates/:industry', requireEnterprisePlan, async (req, res) => {
  const { agencyId, industry } = req.params;
  
  // Map frontend key to backend key
  const industryConfig = INDUSTRY_CONFIG[industry];
  if (!industryConfig) {
    return res.status(400).json({ error: 'Invalid industry' });
  }
  
  const backendKey = industryConfig.key;
  
  try {
    // Check for custom template
    const { data: customTemplate, error } = await supabase
      .from('agency_prompt_templates')
      .select('*')
      .eq('agency_id', agencyId)
      .eq('industry', backendKey)
      .single();
    
    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
      throw error;
    }
    
    // Get default prompts for this industry
    const defaults = DEFAULT_PROMPTS[backendKey] || DEFAULT_PROMPTS.professional_services;
    
    // Get voice details
    const voiceId = customTemplate?.voice_id || defaults.voice_id;
    const voice = ELEVENLABS_VOICES.find(v => v.id === voiceId);
    
    res.json({
      industry: {
        frontendKey: industry,
        backendKey,
        ...industryConfig,
      },
      template: {
        id: customTemplate?.id || null,
        isCustom: !!customTemplate,
        isActive: customTemplate?.is_active ?? true,
        system_prompt: customTemplate?.system_prompt || defaults.system_prompt,
        first_message: customTemplate?.first_message || defaults.first_message,
        voice_id: voiceId,
        voice: voice || null,
        temperature: customTemplate?.temperature || 0.7,
        updated_at: customTemplate?.updated_at || null,
      },
      defaults: {
        system_prompt: defaults.system_prompt,
        first_message: defaults.first_message,
        voice_id: defaults.voice_id,
        temperature: 0.7,
      },
      placeholders: [
        { variable: '{businessName}', description: 'The client\'s business name (auto-filled)' },
      ],
    });
  } catch (error) {
    console.error('Error fetching template:', error);
    res.status(500).json({ error: 'Failed to fetch template' });
  }
});

// ============================================================================
// PUT /api/agency/:agencyId/templates/:industry
// Create or update template for an industry
// ============================================================================
router.put('/:agencyId/templates/:industry', requireEnterprisePlan, async (req, res) => {
  const { agencyId, industry } = req.params;
  const { system_prompt, first_message, voice_id, temperature, is_active } = req.body;
  
  // Map frontend key to backend key
  const industryConfig = INDUSTRY_CONFIG[industry];
  if (!industryConfig) {
    return res.status(400).json({ error: 'Invalid industry' });
  }
  
  const backendKey = industryConfig.key;
  
  // Validate voice_id if provided
  if (voice_id && !ELEVENLABS_VOICES.find(v => v.id === voice_id)) {
    return res.status(400).json({ error: 'Invalid voice_id' });
  }
  
  // Validate temperature
  const temp = parseFloat(temperature);
  if (isNaN(temp) || temp < 0 || temp > 1) {
    return res.status(400).json({ error: 'Temperature must be between 0 and 1' });
  }
  
  try {
    // Upsert template
    const { data, error } = await supabase
      .from('agency_prompt_templates')
      .upsert({
        agency_id: agencyId,
        industry: backendKey,
        system_prompt,
        first_message,
        voice_id,
        temperature: temp,
        is_active: is_active !== false,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'agency_id,industry',
      })
      .select()
      .single();
    
    if (error) throw error;
    
    console.log(`✅ Template saved for agency ${agencyId}, industry ${backendKey}`);
    
    res.json({
      success: true,
      template: data,
      message: 'Template saved successfully. New clients in this industry will use this configuration.',
    });
  } catch (error) {
    console.error('Error saving template:', error);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

// ============================================================================
// DELETE /api/agency/:agencyId/templates/:industry
// Reset template to defaults (delete custom template)
// ============================================================================
router.delete('/:agencyId/templates/:industry', requireEnterprisePlan, async (req, res) => {
  const { agencyId, industry } = req.params;
  
  // Map frontend key to backend key
  const industryConfig = INDUSTRY_CONFIG[industry];
  if (!industryConfig) {
    return res.status(400).json({ error: 'Invalid industry' });
  }
  
  const backendKey = industryConfig.key;
  
  try {
    const { error } = await supabase
      .from('agency_prompt_templates')
      .delete()
      .eq('agency_id', agencyId)
      .eq('industry', backendKey);
    
    if (error) throw error;
    
    console.log(`🔄 Template reset for agency ${agencyId}, industry ${backendKey}`);
    
    res.json({
      success: true,
      message: 'Template reset to defaults. New clients will use the default configuration.',
    });
  } catch (error) {
    console.error('Error resetting template:', error);
    res.status(500).json({ error: 'Failed to reset template' });
  }
});

// ============================================================================
// GET /api/agency/:agencyId/templates/check
// Check if agency has enterprise plan (for frontend gating)
// ============================================================================
router.get('/:agencyId/templates/check', async (req, res) => {
  const { agencyId } = req.params;
  
  try {
    const agency = await getAgencyById(agencyId);
    
    if (!agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }
    
    res.json({
      hasAccess: agency.plan_type === 'enterprise',
      plan_type: agency.plan_type,
      upgrade_url: '/agency/settings?tab=billing',
    });
  } catch (error) {
    console.error('Error checking access:', error);
    res.status(500).json({ error: 'Failed to check access' });
  }
});

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = router;
module.exports.INDUSTRY_CONFIG = INDUSTRY_CONFIG;
module.exports.DEFAULT_PROMPTS = DEFAULT_PROMPTS;
module.exports.ELEVENLABS_VOICES = ELEVENLABS_VOICES;