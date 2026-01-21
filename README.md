# VoiceAI Connect - Multi-Tenant Backend

White-label voice AI platform enabling agencies to resell AI receptionists under their own brand.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        VOICEAI CONNECT PLATFORM                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │
│  │   Agency A   │    │   Agency B   │    │   Agency C   │          │
│  │ (SmartCall)  │    │ (AIVoice Pro)│    │ (CallGenius) │          │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘          │
│         │                   │                   │                   │
│  ┌──────┴───────┐    ┌──────┴───────┐    ┌──────┴───────┐          │
│  │  10 Clients  │    │  25 Clients  │    │   5 Clients  │          │
│  │   $49-149    │    │   $99-199    │    │   $79-149    │          │
│  └──────────────┘    └──────────────┘    └──────────────┘          │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Billing Model

### Platform → Agencies
- **Starter**: $99/mo - Up to 50 clients
- **Professional**: $199/mo - Unlimited clients  
- **Enterprise**: $299/mo - Unlimited clients + priority support

### Agencies → Clients (via Stripe Connect)
- Agencies set their own pricing ($49-$199+)
- Payments go directly to agency's Stripe account
- Platform never touches client payments

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: Supabase (PostgreSQL + Auth)
- **Voice AI**: VAPI
- **Payments**: Stripe (Platform) + Stripe Connect (Agencies)
- **SMS**: Telnyx
- **Email**: Resend
- **AI Summaries**: Claude (Anthropic)

## Project Structure

```
voiceai-connect-backend/
├── src/
│   ├── server.js              # Express server entry point
│   ├── lib/
│   │   ├── supabase.js        # Database client + helpers
│   │   ├── vapi.js            # VAPI integration
│   │   └── notifications.js    # SMS + Email helpers
│   ├── routes/
│   │   ├── auth.js            # Login, JWT, password reset
│   │   ├── agency-signup.js   # Agency registration
│   │   ├── agency-settings.js # Agency CRUD, branding
│   │   ├── client-signup.js   # Client provisioning
│   │   ├── stripe-platform.js # Agency billing
│   │   ├── stripe-connect.js  # Client billing (to agency)
│   │   └── knowledge-base.js  # KB management
│   └── webhooks/
│       └── vapi-webhook.js    # Call completion handler
├── supabase/
│   └── 001_multi_tenant_schema.sql
├── package.json
└── .env.example
```

## API Endpoints

### Health
```
GET /health
```

### Agency Endpoints

```bash
# Signup
POST /api/agency/signup
{
  "name": "SmartCall Solutions",
  "email": "owner@smartcall.com",
  "phone": "+14045551234"
}

# Get agency by host (for frontend routing)
GET /api/agency/by-host?host=smartcall.voiceaiconnect.com

# Get settings (protected)
GET /api/agency/:agencyId/settings

# Update settings
PUT /api/agency/:agencyId/settings
{
  "logo_url": "...",
  "primary_color": "#2563eb",
  "price_starter": 4900,  // cents
  "price_pro": 9900
}

# Create checkout (subscribe to platform)
POST /api/agency/checkout
{
  "agency_id": "uuid",
  "plan": "starter"  // starter, professional, enterprise
}

# Customer portal
POST /api/agency/portal
{ "agency_id": "uuid" }

# Stripe Connect onboarding
POST /api/agency/connect/onboard
{ "agency_id": "uuid" }

# Get Connect status
GET /api/agency/connect/status/:agencyId
```

### Client Endpoints

```bash
# Signup (via agency's marketing site)
POST /api/client/signup
{
  "agencyId": "uuid",
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@plumber.com",
  "phone": "+14045551234",
  "businessName": "John's Plumbing",
  "businessCity": "Atlanta",
  "businessState": "GA",
  "industry": "home_services",
  "websiteUrl": "https://johnsplumbing.com"
}

# Create checkout (pay agency via Connect)
POST /api/client/checkout
{
  "client_id": "uuid",
  "agency_id": "uuid",
  "plan": "starter"  // uses agency's pricing
}

# Customer portal
POST /api/client/portal
{ "client_id": "uuid" }
```

### Auth Endpoints

```bash
# Agency login
POST /api/auth/agency/login
{ "email": "...", "password": "..." }

# Client login
POST /api/auth/client/login
{ "email": "...", "password": "..." }

# Verify token
POST /api/auth/verify
Headers: Authorization: Bearer <token>

# Set password (from email link)
POST /api/auth/set-password
{ "token": "...", "password": "..." }

# Request reset
POST /api/auth/reset-password
{ "email": "..." }
```

### Webhook Endpoints

```bash
# VAPI call completion
POST /webhook/vapi

# Stripe platform (agency subscriptions)
POST /webhook/stripe

# Stripe Connect (client payments to agency)
POST /webhook/stripe-connect
```

### Knowledge Base

```bash
POST /api/knowledge-base/update
{
  "clientId": "uuid",
  "businessHours": "Mon-Fri 8am-5pm",
  "services": "Plumbing, HVAC, ...",
  "faqs": "Q: Do you offer emergency service? A: Yes!",
  "additionalInfo": "We've been in business since 1990...",
  "websiteUrl": "https://..."
}
```

## Database Schema

### agencies
- `id`, `name`, `slug`, `email`, `phone`
- Branding: `logo_url`, `primary_color`, `secondary_color`, `accent_color`
- Domain: `marketing_domain`, `domain_verified`
- Pricing: `price_starter`, `price_pro`, `price_growth`
- Limits: `limit_starter`, `limit_pro`, `limit_growth`
- Platform billing: `stripe_customer_id`, `stripe_subscription_id`, `plan_type`
- Stripe Connect: `stripe_account_id`, `stripe_charges_enabled`, `stripe_payouts_enabled`

### clients
- All existing CallBird fields
- **NEW**: `agency_id` (references agencies)
- **NEW**: `stripe_connected_customer_id` (customer on agency's Connect account)
- **NEW**: `stripe_connected_subscription_id`

### users
- `id`, `email`, `password_hash`, `first_name`, `last_name`
- `agency_id` OR `client_id` (one will be set)
- `role`: 'super_admin', 'agency_owner', 'agency_staff', 'client'

## Setup

1. **Database**: Run `supabase/001_multi_tenant_schema.sql`

2. **Environment**: Copy `.env.example` to `.env` and fill in values

3. **Stripe Setup**:
   - Create platform products/prices for agency plans
   - Enable Stripe Connect
   - Set up webhooks for both endpoints

4. **Start**:
   ```bash
   npm install
   npm run dev
   ```

## Deployment

```bash
# Build
npm run build

# Start (production)
npm start
```

Recommended: Deploy to DigitalOcean App Platform or similar.

## Multi-Tenant Flow

### Agency Signup Flow
1. Agency fills out signup form
2. Create agency record (status: pending_payment)
3. Create user record (role: agency_owner)
4. Generate password token, send welcome email
5. Agency sets password, logs in
6. Agency selects plan → Stripe Checkout
7. Stripe webhook updates status to 'trial'/'active'
8. Agency completes onboarding (logo, colors, pricing)
9. Agency connects Stripe → Stripe Connect onboarding
10. Agency starts acquiring clients!

### Client Signup Flow (via Agency)
1. Client visits agency's marketing site (subdomain or custom domain)
2. Frontend detects agency from URL, fetches branding
3. Client fills signup form (includes agency_id)
4. Create client record linked to agency
5. Create VAPI assistant with industry template
6. Provision local phone number
7. Create user record, send branded welcome email
8. Client sets password, logs in to branded dashboard
9. Trial starts (7 days)
10. Client upgrades → Checkout on agency's Connect account
11. Payments go directly to agency!

### Call Flow
1. Customer calls client's AI phone number
2. VAPI answers, handles conversation
3. Call ends, VAPI sends webhook to `/webhook/vapi`
4. Lookup client by phone → get agency for branding
5. Generate AI summary via Claude
6. Save call to database
7. Send SMS notification (agency branding)
8. Track usage against limits

## Key Adaptations from CallBird

| Feature | CallBird | VoiceAI Connect |
|---------|----------|-----------------|
| Client lookup | Direct | Via `agency_id` |
| SMS branding | "CallBird" | Agency name |
| Email branding | callbirdai.com | Agency domain/name |
| Stripe | Single account | Platform + Connect |
| Dashboard | Single | Per-agency branding |
| Pricing | Fixed | Agency-configurable |
