// ============================================================================
// SUPABASE CLIENT - Multi-tenant aware
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ============================================================================
// AGENCY HELPERS
// ============================================================================

async function getAgencyById(agencyId) {
  const { data, error } = await supabase
    .from('agencies')
    .select('*')
    .eq('id', agencyId)
    .single();
  
  if (error) {
    console.error('Error fetching agency:', error);
    return null;
  }
  return data;
}

async function getAgencyBySlug(slug) {
  const { data, error } = await supabase
    .from('agencies')
    .select('*')
    .eq('slug', slug)
    .eq('status', 'active')
    .single();
  
  if (error) return null;
  return data;
}

async function getAgencyByDomain(domain) {
  const cleanDomain = domain.replace('www.', '');
  
  const { data, error } = await supabase
    .from('agencies')
    .select('*')
    .eq('marketing_domain', cleanDomain)
    .eq('domain_verified', true)
    .eq('status', 'active')
    .single();
  
  if (error) return null;
  return data;
}

async function getAgencyByStripeCustomerId(customerId) {
  const { data, error } = await supabase
    .from('agencies')
    .select('*')
    .eq('stripe_customer_id', customerId)
    .single();
  
  if (error) return null;
  return data;
}

async function getAgencyByStripeAccountId(accountId) {
  const { data, error } = await supabase
    .from('agencies')
    .select('*')
    .eq('stripe_account_id', accountId)
    .single();
  
  if (error) return null;
  return data;
}

// ============================================================================
// CLIENT HELPERS (Multi-tenant)
// ============================================================================

async function getClientById(clientId) {
  const { data, error } = await supabase
    .from('clients')
    .select('*, agencies(*)')
    .eq('id', clientId)
    .single();
  
  if (error) return null;
  return data;
}

async function getClientByVapiAssistantId(assistantId) {
  const { data, error } = await supabase
    .from('clients')
    .select('*, agencies(*)')
    .eq('vapi_assistant_id', assistantId)
    .single();
  
  if (error) return null;
  return data;
}

async function getClientByVapiPhoneNumber(phoneNumber) {
  const { data, error } = await supabase
    .from('clients')
    .select('*, agencies(*)')
    .eq('vapi_phone_number', phoneNumber)
    .single();
  
  if (error) return null;
  return data;
}

async function getClientByEmail(email, agencyId = null) {
  let query = supabase
    .from('clients')
    .select('*')
    .eq('email', email.toLowerCase());
  
  if (agencyId) {
    query = query.eq('agency_id', agencyId);
  }
  
  const { data, error } = await query.single();
  if (error) return null;
  return data;
}

async function getClientsByAgency(agencyId) {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('agency_id', agencyId)
    .order('created_at', { ascending: false });
  
  if (error) return [];
  return data;
}

async function getClientByStripeConnectedCustomerId(customerId, agencyStripeAccountId) {
  const { data, error } = await supabase
    .from('clients')
    .select('*, agencies(*)')
    .eq('stripe_connected_customer_id', customerId)
    .single();
  
  if (error) return null;
  return data;
}

// ============================================================================
// USER HELPERS
// ============================================================================

async function getUserByEmail(email) {
  const { data, error } = await supabase
    .from('users')
    .select('*, agencies(*), clients(*)')
    .eq('email', email.toLowerCase())
    .single();
  
  if (error) return null;
  return data;
}

async function getUserById(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*, agencies(*), clients(*)')
    .eq('id', userId)
    .single();
  
  if (error) return null;
  return data;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  supabase,
  // Agency
  getAgencyById,
  getAgencyBySlug,
  getAgencyByDomain,
  getAgencyByStripeCustomerId,
  getAgencyByStripeAccountId,
  // Client
  getClientById,
  getClientByVapiAssistantId,
  getClientByVapiPhoneNumber,
  getClientByEmail,
  getClientsByAgency,
  getClientByStripeConnectedCustomerId,
  // User
  getUserByEmail,
  getUserById
};
