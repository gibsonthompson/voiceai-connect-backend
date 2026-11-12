// ============================================================================
// Intake templates (platform pre-built)
// VoiceAI Connect
// ----------------------------------------------------------------------------
// Each template is a structured intake schema a business uses to capture an
// order or request on a call. One schema does two jobs (see intake-prompt.js):
//   1. It shapes the live prompt: an ordered, one-question-at-a-time collection
//      flow with if-then branches, framed around serving the caller.
//   2. It is the post-call extraction schema that turns the transcript into a
//      clean structured record for the owner (built in a later pass).
//
// Schema shape:
//   {
//     key, label, industry, intro,
//     fields: [
//       { key, label, type, options?, required, showIf?, hint? }
//     ]
//   }
// field.type: 'text' | 'choice' | 'phone' | 'number' | 'datetime' | 'address'
// field.showIf: { field: '<key>', equals: '<value>' }  OR  { field, in: [..] }
//   (the field is only collected when the condition is met: the if-then branch)
//
// These are PLATFORM defaults (agency_id null). Agencies clone and customize
// them into their own templates; a client ends up with a resolved copy.
// Everything here is content, no side effects, so it is safe to require widely.
// ============================================================================

const RETAIL_ORDERS = {
  key: 'retail_orders',
  label: 'Store Orders',
  industry: 'retail',
  intro: 'Callers place product orders or arrange a pickup. Capture the order accurately so the team can fulfill it.',
  fields: [
    { key: 'caller_name', label: 'Name the order is under', type: 'text', required: true },
    { key: 'order_type', label: 'New order or pickup', type: 'choice', options: ['New order', 'Picking up an existing order'], required: true },
    { key: 'product', label: 'Product', type: 'text', required: true, hint: 'What they want, e.g. whole corn, deer corn' },
    { key: 'quantity', label: 'Quantity', type: 'text', required: true, hint: 'How many, e.g. ten 50lb bags' },
    { key: 'format', label: 'Format', type: 'choice', options: ['Bulk delivery', 'Bagged', 'Tote'], required: true, showIf: { field: 'order_type', equals: 'New order' } },
    { key: 'delivery_address', label: 'Delivery address', type: 'address', required: true, showIf: { field: 'format', equals: 'Bulk delivery' } },
    { key: 'delivery_date', label: 'Preferred delivery date', type: 'datetime', required: false, showIf: { field: 'format', equals: 'Bulk delivery' } },
    { key: 'pickup_time', label: 'Pickup time', type: 'datetime', required: false, showIf: { field: 'format', in: ['Bagged', 'Tote'] } },
    { key: 'phone', label: 'Callback number', type: 'phone', required: true },
  ],
};

const RESTAURANT = {
  key: 'restaurant',
  label: 'Restaurant Orders & Reservations',
  industry: 'restaurant',
  intro: 'Callers order food or book a table. Use the menu in your knowledge base for items and prices. Capture it cleanly so the kitchen or host has what they need.',
  fields: [
    { key: 'request_type', label: 'What they need', type: 'choice', options: ['Takeout order', 'Delivery order', 'Catering', 'Reservation'], required: true },
    { key: 'caller_name', label: 'Name', type: 'text', required: true },
    { key: 'items', label: 'Items ordered', type: 'text', required: true, hint: 'Each item and quantity, against the menu', showIf: { field: 'request_type', in: ['Takeout order', 'Delivery order', 'Catering'] } },
    { key: 'delivery_address', label: 'Delivery address', type: 'address', required: true, showIf: { field: 'request_type', equals: 'Delivery order' } },
    { key: 'headcount', label: 'Number of people', type: 'number', required: true, showIf: { field: 'request_type', in: ['Catering', 'Reservation'] } },
    { key: 'when', label: 'Date and time', type: 'datetime', required: true },
    { key: 'phone', label: 'Callback number', type: 'phone', required: true },
    { key: 'notes', label: 'Allergies or special requests', type: 'text', required: false },
  ],
};

const HOME_SERVICES = {
  key: 'home_services',
  label: 'Service Request',
  industry: 'home_services',
  intro: 'Callers need work done (HVAC, plumbing, electrical, roofing, lawn, junk/dumpster). Capture the job so the team can schedule and quote it. Flag true emergencies.',
  fields: [
    { key: 'caller_name', label: 'Name', type: 'text', required: true },
    { key: 'service_needed', label: 'Service needed', type: 'text', required: true },
    { key: 'problem', label: 'Describe the problem or job', type: 'text', required: true },
    { key: 'urgency', label: 'Urgency', type: 'choice', options: ['Emergency', 'Soon', 'Flexible'], required: true },
    { key: 'address', label: 'Service address', type: 'address', required: true },
    { key: 'access_notes', label: 'Access notes', type: 'text', required: false, hint: 'Gate code, pets, where to park' },
    { key: 'preferred_time', label: 'Preferred day/time', type: 'datetime', required: false, showIf: { field: 'urgency', in: ['Soon', 'Flexible'] } },
    { key: 'phone', label: 'Callback number', type: 'phone', required: true },
  ],
};

const AUTO = {
  key: 'auto',
  label: 'Vehicle Service Intake',
  industry: 'automotive',
  intro: 'Callers need auto service (repair, detailing, tires). Capture the vehicle and the work so the shop can prep.',
  fields: [
    { key: 'caller_name', label: 'Name', type: 'text', required: true },
    { key: 'vehicle', label: 'Vehicle year, make, and model', type: 'text', required: true },
    { key: 'service_needed', label: 'Service needed', type: 'text', required: true },
    { key: 'drop_or_wait', label: 'Drop off or wait', type: 'choice', options: ['Drop off', 'Wait for it'], required: true },
    { key: 'preferred_time', label: 'Preferred day/time', type: 'datetime', required: true },
    { key: 'phone', label: 'Callback number', type: 'phone', required: true },
  ],
};

const SALON = {
  key: 'salon',
  label: 'Appointment Request',
  industry: 'salon',
  intro: 'Callers want to book a service (salon, spa, barber). Capture what they want and when so the front desk can confirm.',
  fields: [
    { key: 'caller_name', label: 'Name', type: 'text', required: true },
    { key: 'client_status', label: 'New or returning client', type: 'choice', options: ['New', 'Returning'], required: true },
    { key: 'service', label: 'Service wanted', type: 'text', required: true },
    { key: 'preferred_staff', label: 'Preferred stylist or tech', type: 'text', required: false },
    { key: 'preferred_time', label: 'Preferred day/time', type: 'datetime', required: true },
    { key: 'phone', label: 'Callback number', type: 'phone', required: true },
  ],
};

// Compliance-sensitive verticals: keep intake to scheduling-level detail only,
// never clinical specifics or protected info. Pairs with HIPAA mode.
const MEDICAL = {
  key: 'medical',
  label: 'Appointment / Consult Request',
  industry: 'medical',
  intro: 'Callers request an appointment or consult (medical, dental, med spa). Collect only scheduling-level detail. Never ask for or record clinical history, diagnoses, or other sensitive health information.',
  fields: [
    { key: 'caller_name', label: 'Name', type: 'text', required: true },
    { key: 'patient_status', label: 'New or existing patient', type: 'choice', options: ['New', 'Existing'], required: true },
    { key: 'reason', label: 'Reason for visit (general)', type: 'text', required: true, hint: 'General only, e.g. cleaning, consult, follow-up. No clinical detail.' },
    { key: 'preferred_time', label: 'Preferred day/time', type: 'datetime', required: true },
    { key: 'phone', label: 'Callback number', type: 'phone', required: true },
  ],
};

const LEGAL = {
  key: 'legal',
  label: 'New Client Intake',
  industry: 'legal',
  intro: 'Callers are potential new clients. Capture enough to route the matter. Do NOT give legal advice or discuss case specifics, just intake.',
  fields: [
    { key: 'caller_name', label: 'Name', type: 'text', required: true },
    { key: 'matter_type', label: 'Type of matter', type: 'text', required: true, hint: 'e.g. family, injury, estate, business' },
    { key: 'parties', label: 'Parties involved', type: 'text', required: false },
    { key: 'summary', label: 'Brief summary', type: 'text', required: true, hint: 'A sentence or two, no advice given' },
    { key: 'preferred_time', label: 'Best time for a consult call', type: 'datetime', required: false },
    { key: 'phone', label: 'Callback number', type: 'phone', required: true },
    { key: 'email', label: 'Email', type: 'text', required: false },
  ],
};

const REAL_ESTATE = {
  key: 'real_estate',
  label: 'Lead Intake',
  industry: 'real_estate',
  intro: 'Callers are buyers, sellers, or renters. Capture the lead so an agent can follow up fast.',
  fields: [
    { key: 'caller_name', label: 'Name', type: 'text', required: true },
    { key: 'intent', label: 'Buying, selling, or renting', type: 'choice', options: ['Buying', 'Selling', 'Renting'], required: true },
    { key: 'area', label: 'Area or neighborhood', type: 'text', required: true },
    { key: 'budget', label: 'Budget or price range', type: 'text', required: false },
    { key: 'timeline', label: 'Timeline', type: 'text', required: false },
    { key: 'preapproved', label: 'Financing / pre-approved', type: 'choice', options: ['Yes', 'No', 'Not sure'], required: false, showIf: { field: 'intent', equals: 'Buying' } },
    { key: 'phone', label: 'Callback number', type: 'phone', required: true },
  ],
};

const VETERINARY = {
  key: 'veterinary',
  label: 'Appointment Request',
  industry: 'veterinary',
  intro: 'Callers want an appointment for their pet. Capture the basics so the clinic can schedule. Keep it to scheduling-level detail.',
  fields: [
    { key: 'caller_name', label: 'Owner name', type: 'text', required: true },
    { key: 'client_status', label: 'New or existing client', type: 'choice', options: ['New', 'Existing'], required: true },
    { key: 'pet', label: 'Pet name and species', type: 'text', required: true },
    { key: 'reason', label: 'Reason (general)', type: 'text', required: true },
    { key: 'preferred_time', label: 'Preferred day/time', type: 'datetime', required: true },
    { key: 'phone', label: 'Callback number', type: 'phone', required: true },
  ],
};

const INTAKE_TEMPLATES = [
  RETAIL_ORDERS, RESTAURANT, HOME_SERVICES, AUTO, SALON,
  MEDICAL, LEGAL, REAL_ESTATE, VETERINARY,
];

const INTAKE_TEMPLATES_BY_KEY = INTAKE_TEMPLATES.reduce((acc, t) => { acc[t.key] = t; return acc; }, {});

function getIntakeTemplate(key) {
  return INTAKE_TEMPLATES_BY_KEY[key] || null;
}

module.exports = { INTAKE_TEMPLATES, INTAKE_TEMPLATES_BY_KEY, getIntakeTemplate };
