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
    .in('status', ['active', 'trial'])
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
    .in('status', ['active', 'trial'])
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
    .select('*, agencies!clients_agency_id_fkey(*)')
    .eq('id', clientId)
    .single();
  
  if (error) return null;
  return data;
}

async function getClientByVapiAssistantId(assistantId) {
  const { data, error } = await supabase
    .from('clients')
    .select('*, agencies!clients_agency_id_fkey(*)')
    .eq('vapi_assistant_id', assistantId)
    .single();
  
  if (error) return null;
  return data;
}

async function getClientByVapiPhoneNumber(phoneNumber) {
  // Resolve a client by its number in EITHER column (vapi_phone_number or
  // phone_number) and tolerant of formatting: we compare the last 10 digits, so
  // "+14043482773", "14043482773" and "(404) 348-2773" all resolve to the same
  // client. A real client must never fall through to the demo path over a column
  // or format mismatch (which is what sent a demo text on a real client's call).
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  const last10 = digits.slice(-10);
  if (!last10) return null;
  const sel = '*, agencies!clients_agency_id_fkey(*)';
  const { data, error } = await supabase
    .from('clients')
    .select(sel)
    .or(`vapi_phone_number.ilike.*${last10},phone_number.ilike.*${last10}`)
    .limit(1);
  if (error) { console.error('❌ getClientByVapiPhoneNumber error:', error.message); return null; }
  return (data && data[0]) || null;
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
    .select('*, agencies!clients_agency_id_fkey(*)')
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

// Look up the users row for an email whose role is in `roles`. One email can
// legitimately hold BOTH an agency and a client account (each its own row): an
// agency owner logging into a real client they run. Each login passes the roles
// it accepts, so it finds ITS row instead of colliding. Uses limit(1), not
// .single(), so a shared email never errors into a false "no user".
async function getUserByEmailForRoles(email, roles) {
  const { data, error } = await supabase
    .from('users')
    .select('*, agencies(*), clients(*)')
    .eq('email', email.toLowerCase())
    .in('role', roles)
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0];
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
  getUserByEmailForRoles,
  getUserById
};