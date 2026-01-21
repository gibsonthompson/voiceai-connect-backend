-- ============================================================================
-- VOICEAI CONNECT - MULTI-TENANT DATABASE SCHEMA
-- Version: 1.0.0
-- Description: Complete schema for white-label voice AI platform
-- ============================================================================

-- ============================================================================
-- 1. AGENCIES TABLE - White-label agency accounts
-- ============================================================================
CREATE TABLE IF NOT EXISTS agencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Basic Info
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,                   -- "smartcall" for smartcall.voiceaiconnect.com
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  
  -- Branding
  logo_url TEXT,
  favicon_url TEXT,
  primary_color TEXT DEFAULT '#2563eb',
  secondary_color TEXT DEFAULT '#1e40af',
  accent_color TEXT DEFAULT '#3b82f6',
  
  -- Custom Domain
  marketing_domain TEXT,                       -- "smartcallsolutions.com"
  domain_verified BOOLEAN DEFAULT false,
  
  -- Client Pricing (in cents) - What agency charges their clients
  price_starter INTEGER DEFAULT 4900,          -- $49
  price_pro INTEGER DEFAULT 9900,              -- $99
  price_growth INTEGER DEFAULT 14900,          -- $149
  
  -- Client Call Limits per plan
  limit_starter INTEGER DEFAULT 50,
  limit_pro INTEGER DEFAULT 150,
  limit_growth INTEGER DEFAULT 500,
  
  -- Platform Billing (Agency pays Platform)
  stripe_customer_id TEXT,                     -- Platform Stripe customer
  stripe_subscription_id TEXT,                 -- Platform subscription
  plan_type TEXT DEFAULT 'starter',            -- starter, professional, enterprise
  subscription_status TEXT DEFAULT 'pending',  -- pending, trial, active, past_due, canceled
  trial_ends_at TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  
  -- Stripe Connect (Agency receives client payments)
  stripe_account_id TEXT,                      -- Connected account ID (acct_xxx)
  stripe_onboarding_complete BOOLEAN DEFAULT false,
  stripe_charges_enabled BOOLEAN DEFAULT false,
  stripe_payouts_enabled BOOLEAN DEFAULT false,
  
  -- Status
  status TEXT DEFAULT 'pending_payment',       -- pending_payment, trial, active, suspended
  onboarding_completed BOOLEAN DEFAULT false,
  onboarding_step INTEGER DEFAULT 0,
  
  -- Settings
  support_email TEXT,
  support_phone TEXT,
  timezone TEXT DEFAULT 'America/New_York',
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  
  -- Constraints
  CONSTRAINT valid_agency_status CHECK (status IN ('pending_payment', 'trial', 'active', 'suspended')),
  CONSTRAINT valid_agency_plan CHECK (plan_type IN ('starter', 'professional', 'enterprise')),
  CONSTRAINT valid_subscription_status CHECK (subscription_status IN ('pending', 'trial', 'active', 'past_due', 'canceled'))
);

-- Indexes for agencies
CREATE INDEX IF NOT EXISTS idx_agencies_email ON agencies(email);
CREATE INDEX IF NOT EXISTS idx_agencies_slug ON agencies(slug);
CREATE INDEX IF NOT EXISTS idx_agencies_marketing_domain ON agencies(marketing_domain);
CREATE INDEX IF NOT EXISTS idx_agencies_status ON agencies(status);
CREATE INDEX IF NOT EXISTS idx_agencies_stripe_customer_id ON agencies(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_agencies_stripe_account_id ON agencies(stripe_account_id);

-- ============================================================================
-- 2. MODIFY CLIENTS TABLE - Add agency relationship
-- ============================================================================

-- Add agency_id column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'clients' AND column_name = 'agency_id'
  ) THEN
    ALTER TABLE clients ADD COLUMN agency_id UUID REFERENCES agencies(id) ON DELETE SET NULL;
    CREATE INDEX idx_clients_agency_id ON clients(agency_id);
  END IF;
END $$;

-- Add additional columns for multi-tenant support
DO $$ 
BEGIN
  -- Client's Stripe customer on agency's connected account
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'clients' AND column_name = 'stripe_connected_customer_id'
  ) THEN
    ALTER TABLE clients ADD COLUMN stripe_connected_customer_id TEXT;
  END IF;
  
  -- Client's subscription on agency's connected account
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'clients' AND column_name = 'stripe_connected_subscription_id'
  ) THEN
    ALTER TABLE clients ADD COLUMN stripe_connected_subscription_id TEXT;
  END IF;
END $$;

-- ============================================================================
-- 3. USERS TABLE - Supports both agency owners and client users
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Relationships (one will be set based on role)
  agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  
  -- Auth
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  
  -- Profile
  first_name TEXT,
  last_name TEXT,
  
  -- Role
  role TEXT NOT NULL DEFAULT 'client',         -- super_admin, agency_owner, agency_staff, client
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  
  -- Constraints
  CONSTRAINT valid_user_role CHECK (role IN ('super_admin', 'agency_owner', 'agency_staff', 'client'))
);

-- Indexes for users
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_agency_id ON users(agency_id);
CREATE INDEX IF NOT EXISTS idx_users_client_id ON users(client_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ============================================================================
-- 4. PASSWORD RESET TOKENS (if not exists)
-- ============================================================================
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_tokens_token ON password_reset_tokens(token);
CREATE INDEX IF NOT EXISTS idx_password_tokens_email ON password_reset_tokens(email);

-- ============================================================================
-- 5. AGENCY SUBSCRIPTION EVENTS - Track platform billing events
-- ============================================================================
CREATE TABLE IF NOT EXISTS agency_subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  stripe_event_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agency_sub_events_agency ON agency_subscription_events(agency_id);
CREATE INDEX IF NOT EXISTS idx_agency_sub_events_type ON agency_subscription_events(event_type);

-- ============================================================================
-- 6. ENSURE CALLS TABLE HAS CLIENT_ID
-- ============================================================================
-- (Your existing calls table should already have client_id)
-- This just ensures the index exists
CREATE INDEX IF NOT EXISTS idx_calls_client_id ON calls(client_id);
CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at DESC);

-- ============================================================================
-- 7. EMAIL LOGS TABLE (if not exists)
-- ============================================================================
CREATE TABLE IF NOT EXISTS email_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  agency_id UUID REFERENCES agencies(id) ON DELETE SET NULL,
  email_type TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'sent',
  resend_id TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_email_logs_client ON email_logs(client_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_agency ON email_logs(agency_id);

-- ============================================================================
-- 8. ROW LEVEL SECURITY POLICIES
-- ============================================================================

-- Enable RLS
ALTER TABLE agencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_subscription_events ENABLE ROW LEVEL SECURITY;

-- Agencies: Public read for active agencies (marketing sites need this)
DROP POLICY IF EXISTS "Public can read active agencies" ON agencies;
CREATE POLICY "Public can read active agencies" ON agencies
  FOR SELECT USING (status = 'active');

-- Agencies: Service role can do everything
DROP POLICY IF EXISTS "Service role full access agencies" ON agencies;
CREATE POLICY "Service role full access agencies" ON agencies
  FOR ALL USING (auth.role() = 'service_role');

-- Users: Service role can do everything  
DROP POLICY IF EXISTS "Service role full access users" ON users;
CREATE POLICY "Service role full access users" ON users
  FOR ALL USING (auth.role() = 'service_role');

-- Clients: Add policy for agency access
DROP POLICY IF EXISTS "Agency can manage their clients" ON clients;
CREATE POLICY "Agency can manage their clients" ON clients
  FOR ALL USING (
    agency_id IN (
      SELECT agency_id FROM users WHERE id = auth.uid()
    )
  );

-- ============================================================================
-- 9. HELPER FUNCTIONS
-- ============================================================================

-- Function to get agency by slug or domain
CREATE OR REPLACE FUNCTION get_agency_by_host(host_name TEXT)
RETURNS TABLE (
  id UUID,
  name TEXT,
  slug TEXT,
  logo_url TEXT,
  primary_color TEXT,
  secondary_color TEXT,
  accent_color TEXT,
  stripe_account_id TEXT,
  price_starter INTEGER,
  price_pro INTEGER,
  price_growth INTEGER
) AS $$
BEGIN
  -- First try exact domain match
  RETURN QUERY
  SELECT 
    a.id, a.name, a.slug, a.logo_url, 
    a.primary_color, a.secondary_color, a.accent_color,
    a.stripe_account_id,
    a.price_starter, a.price_pro, a.price_growth
  FROM agencies a
  WHERE (
    a.marketing_domain = host_name 
    OR a.marketing_domain = REPLACE(host_name, 'www.', '')
  )
  AND a.domain_verified = true
  AND a.status = 'active'
  LIMIT 1;
  
  -- If no match, try subdomain
  IF NOT FOUND THEN
    RETURN QUERY
    SELECT 
      a.id, a.name, a.slug, a.logo_url,
      a.primary_color, a.secondary_color, a.accent_color,
      a.stripe_account_id,
      a.price_starter, a.price_pro, a.price_growth
    FROM agencies a
    WHERE a.slug = SPLIT_PART(host_name, '.', 1)
    AND a.status = 'active'
    LIMIT 1;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to get agency stats
CREATE OR REPLACE FUNCTION get_agency_stats(p_agency_id UUID)
RETURNS TABLE (
  total_clients BIGINT,
  active_clients BIGINT,
  total_calls_this_month BIGINT,
  monthly_revenue_cents BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COUNT(*)::BIGINT as total_clients,
    COUNT(*) FILTER (WHERE status = 'active')::BIGINT as active_clients,
    COALESCE(SUM(calls_this_month), 0)::BIGINT as total_calls_this_month,
    (
      COUNT(*) FILTER (WHERE plan_type = 'starter' AND subscription_status = 'active') * 
        (SELECT price_starter FROM agencies WHERE id = p_agency_id) +
      COUNT(*) FILTER (WHERE plan_type = 'pro' AND subscription_status = 'active') * 
        (SELECT price_pro FROM agencies WHERE id = p_agency_id) +
      COUNT(*) FILTER (WHERE plan_type = 'growth' AND subscription_status = 'active') * 
        (SELECT price_growth FROM agencies WHERE id = p_agency_id)
    )::BIGINT as monthly_revenue_cents
  FROM clients
  WHERE agency_id = p_agency_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 10. UPDATED_AT TRIGGERS
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_agencies_updated_at ON agencies;
CREATE TRIGGER update_agencies_updated_at
  BEFORE UPDATE ON agencies
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
