// ============================================================================
// INDUSTRY KNOWLEDGE BASES - Pre-loaded docs for every AI receptionist
// Each function returns a comprehensive knowledge base document that gets
// uploaded to VAPI alongside any website-scraped content.
// 
// These docs give the AI receptionist deep industry context so it can
// handle calls intelligently even without a client-provided knowledge base.
//
// USAGE: Called by createIndustryAssistant() in vapi.js
// UPDATED: Dental split from medical into its own industry
// ============================================================================

const INDUSTRY_KNOWLEDGE_BASES = {

  // ══════════════════════════════════════════════════════════════════════════
  // HOME SERVICES
  // ══════════════════════════════════════════════════════════════════════════
  home_services: (businessName) => `# ${businessName} — AI Receptionist Knowledge Base

## Company Overview
${businessName} is a professional home services company. We serve residential and commercial customers with a range of maintenance, repair, and improvement services. Our team is licensed, insured, and committed to quality workmanship.

## Common Services Offered

### Plumbing
- Leak detection and repair (faucets, pipes, toilets, water heaters)
- Drain cleaning and unclogging
- Water heater installation and repair (tank and tankless)
- Sewer line inspection and repair
- Fixture installation (sinks, toilets, showers, bathtubs)
- Garbage disposal installation and repair
- Water filtration and softener systems
- Gas line installation and repair
- Sump pump installation and maintenance
- Repiping and pipe replacement

### HVAC (Heating, Ventilation, Air Conditioning)
- AC repair and installation
- Furnace repair and installation
- Heat pump systems
- Ductwork installation and cleaning
- Thermostat installation (including smart thermostats)
- Indoor air quality solutions
- Seasonal tune-ups and maintenance plans
- Emergency heating and cooling repair
- Mini-split / ductless systems
- Commercial HVAC services

### Electrical
- Outlet and switch installation or repair
- Panel upgrades and circuit breaker replacement
- Lighting installation (indoor, outdoor, recessed, landscape)
- Ceiling fan installation
- Whole-house surge protection
- Generator installation and maintenance
- Wiring and rewiring
- EV charger installation
- Smoke and carbon monoxide detector installation
- Electrical safety inspections

### General Contracting & Handyman
- Kitchen and bathroom remodeling
- Drywall repair and installation
- Painting (interior and exterior)
- Flooring installation
- Deck and fence building or repair
- Door and window installation
- Pressure washing
- Gutter cleaning and installation
- Roofing repair
- Foundation and waterproofing

## Frequently Asked Questions

**Q: Do you offer free estimates?**
A: We typically offer free estimates for most standard jobs. For complex projects that require an on-site inspection, there may be a diagnostic or trip fee that is often credited toward the cost of the work if you proceed.

**Q: Are you licensed and insured?**
A: Yes. Our team is fully licensed, bonded, and insured. We carry general liability insurance and workers' compensation coverage for your protection.

**Q: Do you offer emergency or after-hours service?**
A: Yes, we understand that emergencies don't wait for business hours. We offer emergency service for urgent situations like burst pipes, gas leaks, no heat in winter, or no AC in extreme heat. Emergency rates may apply outside of normal business hours.

**Q: How quickly can you come out?**
A: For emergencies, we aim to respond as quickly as possible — often same-day. For routine service requests, we typically schedule within 1–3 business days depending on availability.

**Q: What forms of payment do you accept?**
A: We accept cash, check, and all major credit cards. Financing options may be available for larger projects.

**Q: Do you offer warranties on your work?**
A: Yes. We stand behind our work with a warranty on labor. Manufacturer warranties apply to parts and equipment we install. Ask us for specific warranty details on your project.

**Q: What areas do you serve?**
A: We serve the local area and surrounding communities. Contact us with your address and we'll confirm whether you're within our service area.

**Q: Do I need to be home during the service?**
A: For most jobs, we prefer an adult to be present. However, we can make arrangements if needed — just let us know ahead of time.

**Q: Can you give me a price over the phone?**
A: We can provide general pricing ranges for standard services, but most jobs require an on-site assessment for an accurate quote. Every home is different, and we want to make sure we give you an honest, accurate price.

**Q: Do you offer maintenance plans?**
A: Yes. Regular maintenance plans are available, especially for HVAC systems and plumbing. Preventive maintenance helps avoid costly emergency repairs and extends the life of your equipment.

## Urgency Guidelines

### Emergency (Respond ASAP)
- Gas leak or gas smell
- Burst pipe or active flooding
- Complete loss of heat in freezing temperatures
- Complete loss of AC in extreme heat (especially with elderly or infants)
- Sewage backup
- Electrical sparking, burning smell, or exposed wires
- Carbon monoxide detector alarm
- No hot water (with medical need)

### Urgent (Same-day or next-day)
- Slow drain or partial clog
- Water heater not producing hot water
- AC or furnace not working (mild weather)
- Toilet running constantly
- Tripped circuit breaker that won't reset
- Minor leak (contained, not causing damage)

### Routine (Schedule within 1–5 days)
- Fixture replacement
- New installation requests
- Maintenance tune-ups
- Cosmetic repairs
- Estimate requests for remodeling
- Appliance hookup

## Seasonal Considerations

### Spring
- AC tune-up season — recommend scheduling early before summer rush
- Gutter cleaning after winter
- Sump pump checks
- Outdoor faucet and sprinkler system startup

### Summer
- Peak AC repair demand — longer wait times possible
- Outdoor electrical work (landscape lighting, pool equipment)
- Humidity and indoor air quality concerns

### Fall
- Furnace and heating tune-up season
- Winterizing outdoor plumbing
- Gutter cleaning before winter
- Weather stripping and insulation checks

### Winter
- Emergency heating repair peak season
- Frozen pipe prevention and repair
- Generator demand increases
- Holiday lighting installation

## Industry Terminology
- **SEER Rating**: Seasonal Energy Efficiency Ratio — measures AC efficiency. Higher is better.
- **AFUE**: Annual Fuel Utilization Efficiency — measures furnace efficiency.
- **Tankless Water Heater**: On-demand hot water system (no storage tank).
- **Main Shutoff Valve**: The valve that stops all water to the home — important for emergencies.
- **Load Center / Panel**: The electrical panel where circuit breakers are located.
- **PEX Piping**: Flexible plastic piping commonly used in modern plumbing.
- **R-Value**: Measure of insulation effectiveness. Higher is better.
- **GFCI Outlet**: Ground Fault Circuit Interrupter — required in kitchens, bathrooms, and outdoor areas for safety.
- **Backflow Preventer**: Device that stops contaminated water from flowing back into the clean water supply.
`,

  // ══════════════════════════════════════════════════════════════════════════
  // MEDICAL (Physician / Clinic — dental split into its own industry)
  // ══════════════════════════════════════════════════════════════════════════
  medical: (businessName) => `# ${businessName} — AI Receptionist Knowledge Base

## Practice Overview
${businessName} is a healthcare practice dedicated to providing quality patient care. Our team of healthcare professionals is committed to treating every patient with respect, compassion, and clinical excellence.

## Common Services

### Primary Care / General Practice
- Annual physicals and wellness exams
- Sick visits (cold, flu, infections, allergies)
- Chronic disease management (diabetes, hypertension, asthma)
- Immunizations and vaccinations
- Lab work and diagnostic testing
- Preventive screenings
- Sports physicals and school physicals
- Weight management consultations
- Referrals to specialists

### Specialty Services
- Dermatology (skin exams, mole checks, acne treatment)
- Orthopedics (joint pain, fractures, sports injuries)
- Cardiology (heart health, EKG, stress tests)
- OB/GYN (well-woman exams, prenatal care)
- Pediatrics (well-child visits, immunizations)
- Mental health (counseling, medication management)
- Physical therapy and rehabilitation
- Chiropractic care

## Frequently Asked Questions

**Q: Are you accepting new patients?**
A: We are generally accepting new patients. Our team will verify availability and help schedule your first appointment.

**Q: What insurance do you accept?**
A: We accept most major insurance plans. Our team can verify your specific coverage when you call. If we don't accept your insurance, we can discuss self-pay options.

**Q: Do I need a referral to be seen?**
A: It depends on your insurance plan. Some plans require referrals for specialist visits, while primary care typically does not require a referral. Our team can help you check.

**Q: What should I bring to my first appointment?**
A: Please bring a valid photo ID, your insurance card, a list of current medications, and any relevant medical records or test results. Arriving 15 minutes early to complete new patient paperwork is recommended.

**Q: Do you offer telehealth or virtual appointments?**
A: Many practices now offer telehealth visits for appropriate conditions. Ask when scheduling whether a virtual visit is an option for your needs.

**Q: How far in advance should I schedule?**
A: For routine checkups and physicals, we recommend scheduling 2–4 weeks in advance. Sick visits and urgent needs are accommodated on a same-day or next-day basis when possible.

**Q: What is your cancellation policy?**
A: We ask for at least 24 hours' notice if you need to cancel or reschedule. Late cancellations or no-shows may be subject to a fee.

**Q: Do you offer payment plans?**
A: We understand healthcare costs can be a concern. We accept various payment methods and can discuss payment plan options for certain procedures.

**Q: What should I do if I have a medical emergency?**
A: If you are experiencing a medical emergency, please call 911 immediately or go to your nearest emergency room. Our office handles non-emergency medical care.

**Q: Can I request prescription refills by phone?**
A: Prescription refills typically require a review by your provider. Please allow 24–48 hours for refill requests. Contact our office and we'll pass the request to your provider.

**Q: Do you treat children?**
A: Many of our providers see patients of all ages, including children. Pediatric-specific services may also be available. Ask when scheduling.

## HIPAA Compliance Reminders
- Never discuss specific patient medical details over the phone unless identity is verified
- Only collect: name, date of birth, phone number, and general reason for visit
- If a caller shares detailed symptoms, acknowledge and defer to the clinical team
- Never confirm or deny that someone is a patient at the practice
- Refer any records requests to the medical records department
- All calls may be recorded — inform callers at the start

## Urgency Guidelines

### Direct to 911 / Emergency Room
- Chest pain, difficulty breathing, signs of stroke
- Severe allergic reaction (anaphylaxis)
- Uncontrolled bleeding
- Loss of consciousness
- Suspected heart attack (chest pressure, arm pain, jaw pain)
- Severe abdominal pain
- High fever in infants under 3 months

### Urgent (Same-day appointment needed)
- Fever above 101°F with symptoms
- Ear pain or suspected ear infection
- Urinary tract infection symptoms
- Persistent vomiting or diarrhea
- Minor injuries (sprains, small cuts needing stitches)
- Eye pain or sudden vision changes
- Allergic reactions (mild-moderate, no breathing difficulty)

### Routine (Schedule normally)
- Annual physicals and wellness visits
- Follow-up appointments
- Medication reviews
- Routine bloodwork
- Vaccination appointments
- Referral consultations
- Cosmetic consultations

## Insurance Terminology
- **Copay**: Fixed amount you pay at the time of visit (e.g., $25 for a primary care visit)
- **Deductible**: Amount you pay out-of-pocket before insurance starts covering
- **Coinsurance**: Percentage you pay after meeting your deductible
- **In-Network**: Providers who have agreements with your insurance for lower rates
- **Out-of-Network**: Providers without insurance agreements — typically higher costs
- **Prior Authorization**: Approval required from insurance before certain procedures
- **EOB (Explanation of Benefits)**: Statement from insurance showing what was covered
- **FSA/HSA**: Tax-advantaged savings accounts for medical expenses
`,

  // ══════════════════════════════════════════════════════════════════════════
  // DENTAL & ORTHODONTICS (NEW — split from medical)
  // ══════════════════════════════════════════════════════════════════════════
  dental: (businessName) => `# ${businessName} — AI Receptionist Knowledge Base

## Practice Overview
${businessName} is a dental and orthodontic practice dedicated to helping patients achieve and maintain healthy, beautiful smiles. Our team of dental professionals provides comprehensive care in a comfortable, welcoming environment.

## Common Services

### Preventive Care
- Routine cleanings (prophylaxis)
- Comprehensive dental exams
- Digital X-rays and diagnostics
- Oral cancer screenings
- Fluoride treatments
- Dental sealants
- Periodontal (gum) evaluations
- Custom night guards and mouth guards
- Sports mouth guards
- Pediatric dentistry (children's cleanings and exams)

### Restorative Dentistry
- Fillings (composite / tooth-colored)
- Crowns and bridges
- Root canal therapy (endodontics)
- Tooth extractions (simple and surgical)
- Wisdom teeth removal
- Dental implants (single tooth, implant-supported bridges)
- Dentures and partials (full and partial)
- Inlays and onlays
- Post and core buildups
- Bone grafting (for implant preparation)

### Cosmetic Dentistry
- Professional teeth whitening (in-office and take-home)
- Porcelain veneers
- Dental bonding
- Smile makeovers
- Gum contouring / reshaping
- Tooth-colored fillings (replacing silver/amalgam)

### Orthodontics
- Traditional metal braces (adults and children)
- Clear / ceramic braces
- Invisalign (clear aligner therapy)
- Invisalign Teen
- Retainers (fixed and removable)
- Early intervention / Phase 1 orthodontics
- Orthodontic consultations and evaluations
- Space maintainers
- Palatal expanders

### Periodontal (Gum) Treatment
- Deep cleaning (scaling and root planing)
- Gum disease treatment
- Periodontal maintenance
- Gum grafting
- Pocket reduction surgery
- Antibiotic therapy

### Emergency Dental Care
- Severe toothache
- Knocked-out tooth (avulsed tooth)
- Broken, cracked, or chipped tooth
- Lost filling or crown
- Dental abscess (infection with swelling)
- Bleeding that won't stop
- Injury to mouth, lips, or jaw
- Broken braces or orthodontic wire

## Frequently Asked Questions

**Q: Are you accepting new patients?**
A: Yes, we welcome new patients of all ages. Our team will help schedule your first visit and walk you through what to expect.

**Q: What insurance do you accept?**
A: We accept most major dental insurance plans. Our team can verify your specific coverage when you call. We also offer options for patients without insurance.

**Q: What should I bring to my first appointment?**
A: Please bring a valid photo ID, your dental insurance card, a list of any medications you take, and any recent dental records or X-rays if you have them. Arriving 10-15 minutes early to complete new patient paperwork is recommended.

**Q: How often should I come in for a cleaning?**
A: Most patients benefit from a cleaning and exam every six months. Some patients with gum disease may need more frequent visits (every 3-4 months). Your dentist will recommend the best schedule for you.

**Q: Do you see children?**
A: Yes. We recommend a child's first dental visit by age one or when their first tooth appears. Our team is experienced with pediatric patients and makes visits fun and comfortable for kids.

**Q: What should I do if I have a dental emergency?**
A: Call our office right away. For severe pain, a knocked-out tooth, uncontrolled bleeding, or facial swelling, we will work to see you as soon as possible. If a tooth is knocked out, keep it moist (in milk or saliva) and get to us within 30 minutes if possible.

**Q: Do you offer sedation or options for anxious patients?**
A: We understand dental anxiety is common. We offer options to help you feel comfortable, which may include nitrous oxide (laughing gas), oral sedation, or other calming techniques. Let us know about your concerns and we'll find the right approach for you.

**Q: How much does a cleaning cost without insurance?**
A: Pricing for cleanings and other services varies. We can provide a cost estimate when you schedule. We also offer payment plans and may have special pricing for uninsured patients.

**Q: How long does Invisalign treatment take?**
A: Invisalign treatment typically takes 6-18 months depending on the complexity of your case. A consultation with our orthodontist will give you a personalized timeline and cost estimate.

**Q: Do braces hurt?**
A: There is some discomfort when braces are first placed and after adjustments, but it typically lasts only a few days. Over-the-counter pain relievers and soft foods help. Most patients adjust quickly.

**Q: What's the difference between a crown and a veneer?**
A: A crown covers the entire tooth and is used for damaged or weakened teeth. A veneer is a thin shell that covers only the front surface and is primarily cosmetic. Your dentist will recommend the best option for your situation.

**Q: Do you offer teeth whitening?**
A: Yes. We offer both in-office professional whitening (fastest results, typically one visit) and custom take-home whitening kits. Both are more effective and safer than over-the-counter products.

**Q: What is a root canal? Does it hurt?**
A: A root canal removes infected tissue from inside a tooth to save it from extraction. With modern techniques and anesthesia, most patients report little to no pain during the procedure — similar to getting a filling.

**Q: Can I pay in installments?**
A: Yes. We offer flexible payment plans and may accept financing through third-party providers. Our team can discuss options during your visit.

## Dental Emergency Guidelines

### See Immediately (Same Day)
- Knocked-out permanent tooth (time-critical — within 30 minutes)
- Severe, uncontrolled bleeding from the mouth
- Facial swelling that is spreading or affecting breathing/swallowing
- Jaw fracture or dislocation
- Severe trauma to teeth or mouth

### See Urgently (Within 24 Hours)
- Severe toothache not relieved by over-the-counter pain medication
- Broken or cracked tooth with sharp edges or pain
- Lost crown or filling with sensitivity
- Dental abscess (pimple on gums, swelling, fever)
- Broken orthodontic wire poking cheek or gums

### Schedule Soon (Within a Few Days)
- Mild toothache that comes and goes
- Chipped tooth with no pain
- Loose permanent tooth
- Lost retainer or broken aligner
- Sensitivity to hot or cold

### Home Care Tips for Dental Emergencies
- **Knocked-out tooth**: Handle by the crown (not the root). Rinse gently. Place back in socket if possible, or keep in milk. Get to the dentist immediately.
- **Toothache**: Rinse with warm salt water. Use over-the-counter pain relief. Do not place aspirin directly on gums.
- **Broken tooth**: Rinse mouth, apply cold compress to reduce swelling. Save any pieces.
- **Lost filling/crown**: Keep the crown if you have it. Dental cement from a pharmacy can temporarily hold it.

## Insurance and Payment Terminology
- **Copay**: Fixed amount you pay per visit or procedure
- **Deductible**: Amount you pay before insurance starts covering
- **Annual Maximum**: The most your dental plan will pay in a calendar year (commonly dollar one thousand to dollar two thousand)
- **In-Network**: Dentists who have agreed to reduced fees with your insurance
- **Out-of-Network**: Dentists without an insurance agreement — you may pay more
- **Waiting Period**: Time you must be enrolled before certain services are covered (common for major work)
- **Pre-Authorization**: Approval from insurance before expensive procedures
- **UCR (Usual, Customary, and Reasonable)**: The fee your insurance uses to calculate coverage

## First Visit Expectations
1. Check in and complete new patient paperwork (or complete online beforehand)
2. Meet your dental team
3. Comprehensive exam — the dentist checks teeth, gums, jaw, and oral tissues
4. Digital X-rays (if needed)
5. Professional cleaning (may be same visit or scheduled separately depending on findings)
6. Discussion of findings and recommended treatment plan
7. Insurance verification and cost estimate for any recommended treatment
8. Schedule follow-up appointments as needed

Typical first visit duration: 60-90 minutes
`,

  // ══════════════════════════════════════════════════════════════════════════
  // PROFESSIONAL SERVICES
  // ══════════════════════════════════════════════════════════════════════════
  professional_services: (businessName) => `# ${businessName} — AI Receptionist Knowledge Base

## Company Overview
${businessName} is a professional services firm providing expert consulting, advisory, and business solutions. We work with businesses and individuals to deliver results-driven outcomes and personalized attention.

## Common Services

### Business Consulting
- Strategic planning and business development
- Operations improvement and process optimization
- Market research and competitive analysis
- Change management
- Project management
- Technology consulting and digital transformation
- HR and organizational consulting
- Supply chain and logistics consulting

### IT Services & Technology
- Managed IT services
- Cloud computing and migration
- Cybersecurity assessment and implementation
- Software development and integration
- Network design and management
- Data analytics and business intelligence
- IT help desk and support
- Disaster recovery and backup solutions

### Marketing & Communications
- Brand strategy and identity
- Digital marketing (SEO, PPC, social media)
- Content creation and copywriting
- Public relations
- Website design and development
- Email marketing
- Market research and analytics
- Video production

### Accounting & Bookkeeping
- Monthly bookkeeping
- Tax preparation (individual and business)
- Financial statement preparation
- Payroll processing
- Accounts payable / receivable management
- QuickBooks setup and training
- CFO advisory services
- Audit preparation

## Frequently Asked Questions

**Q: Do you offer free consultations?**
A: We typically offer an initial consultation to understand your needs and determine how we can help. Ask about availability when scheduling.

**Q: How do you charge for your services?**
A: Pricing varies depending on the scope and complexity of the project. We offer hourly rates, project-based pricing, and retainer arrangements. Our team can discuss the best fit for your needs.

**Q: How long does a typical project take?**
A: Timelines depend on the project scope. Small engagements may take a few weeks, while larger strategic projects can span several months. We provide a timeline estimate during the proposal process.

**Q: Can you work with my existing team or vendors?**
A: Absolutely. We regularly collaborate with clients' internal teams and third-party vendors to ensure seamless execution.

**Q: Do you sign NDAs or confidentiality agreements?**
A: Yes. Client confidentiality is a priority. We are happy to sign NDAs and non-disclosure agreements before any engagement begins.

**Q: What industries do you serve?**
A: We work across a variety of industries. Our team will determine during the initial consultation whether we're a good fit for your specific industry and needs.

**Q: Do you offer ongoing support or retainer packages?**
A: Yes. Many clients retain us on a monthly basis for ongoing advisory, support, or management services. This is ideal for businesses that need consistent expert guidance.

**Q: What is the best way to get started?**
A: The first step is a brief introductory call or meeting. We'll learn about your situation, goals, and challenges, and then propose a customized approach.

## Engagement Process
1. **Discovery Call** — Understand client needs, goals, and timeline
2. **Proposal** — Scope of work, deliverables, pricing, and timeline
3. **Agreement** — Contract signing and onboarding
4. **Kickoff** — Project launch, team introductions, initial planning
5. **Execution** — Ongoing work with regular check-ins and progress reports
6. **Delivery** — Final deliverables, review, and handoff
7. **Follow-Up** — Post-project support and feedback

## Terminology
- **SOW (Statement of Work)**: Document outlining project scope, deliverables, and terms
- **Retainer**: Ongoing monthly agreement for a set amount of work or advisory time
- **Deliverable**: A tangible output or result from a project
- **KPI (Key Performance Indicator)**: Measurable metric used to evaluate success
- **ROI (Return on Investment)**: Measure of the profitability of an engagement
- **SLA (Service Level Agreement)**: Defined standards for response times and service quality
- **Change Order**: A modification to the original project scope or agreement
`,

  // ══════════════════════════════════════════════════════════════════════════
  // RESTAURANTS / FOOD SERVICE
  // ══════════════════════════════════════════════════════════════════════════
  restaurants: (businessName) => `# ${businessName} — AI Receptionist Knowledge Base

## Restaurant Overview
${businessName} is a dining establishment committed to quality food, excellent service, and a welcoming atmosphere. We pride ourselves on fresh ingredients and a diverse menu that caters to a variety of tastes and dietary needs.

## Common Services

### Dining Options
- Dine-in
- Takeout / carryout
- Curbside pickup
- Delivery (in-house or via third-party platforms)
- Online ordering

### Special Services
- Reservations (walk-ins also welcome based on availability)
- Private dining and event space
- Catering for events, parties, and corporate functions
- Large group accommodations
- Gift cards
- Loyalty / rewards program

## Frequently Asked Questions

**Q: Do you take reservations?**
A: Yes, we accept reservations. We recommend booking in advance for weekends, holidays, and large parties. Walk-ins are also welcome based on availability.

**Q: What are your hours?**
A: Our hours vary by day. Please ask and we'll provide our current schedule, or check our website for the most up-to-date hours.

**Q: Do you offer takeout or delivery?**
A: Yes, we offer takeout. Delivery may be available through our restaurant directly or through third-party delivery platforms. Ask for current delivery options.

**Q: Do you accommodate dietary restrictions?**
A: We do our best to accommodate dietary needs including vegetarian, vegan, gluten-free, nut-free, and dairy-free options. Please inform your server about any allergies so the kitchen can take proper precautions. Note that our kitchen handles common allergens and cross-contamination is possible.

**Q: Do you have a kids' menu?**
A: Yes, we offer a kids' menu with child-friendly options. High chairs and booster seats are available.

**Q: Can you accommodate large parties?**
A: Yes. For parties of 8 or more, we recommend calling ahead so we can ensure proper seating. Private or semi-private dining may be available for larger events.

**Q: Do you offer catering?**
A: Yes, we offer catering for events of various sizes — from small office lunches to large celebrations. Contact us to discuss your event needs and we can put together a custom menu.

**Q: What is your cancellation policy for reservations?**
A: We appreciate at least 2 hours' notice for cancellations. For large party reservations, we may require 24 hours' notice. No-shows for large reservations may be subject to a fee.

**Q: Do you have happy hour specials?**
A: We frequently offer specials during certain hours. Ask about our current promotions or check our website and social media for the latest deals.

**Q: Is parking available?**
A: Parking details depend on our location. We can provide specifics about on-site parking, nearby lots, or street parking when you visit.

**Q: Can I buy gift cards?**
A: Yes, gift cards are available for purchase in any amount. They make a great gift for any occasion.

**Q: Do you have outdoor seating?**
A: Seasonal outdoor seating may be available depending on weather and our location. Ask about current availability.

## Reservation Guidelines
- **Party of 1–4**: Reservations recommended on weekends, walk-ins usually fine on weekdays
- **Party of 5–8**: Reservations strongly recommended
- **Party of 9+**: Reservation required — advance notice of 48+ hours preferred
- **Private events**: Require booking 1–4 weeks in advance depending on size
- **Holiday dining**: Reservations fill up quickly — book 1–2 weeks early

## Common Allergens Handled in the Kitchen
- Wheat / gluten
- Dairy / lactose
- Tree nuts and peanuts
- Shellfish and fish
- Soy
- Eggs
- Sesame

Always recommend that customers with severe allergies speak directly with a manager or chef before ordering.

## Peak Hours & Wait Times
- **Lunch rush**: 11:30 AM – 1:30 PM (weekdays), 12:00 – 2:00 PM (weekends)
- **Dinner rush**: 6:00 – 8:30 PM (weekdays), 5:30 – 9:00 PM (weekends)
- **Brunch** (if applicable): 10:00 AM – 1:00 PM (weekends)
- Wait times during peak can range from 15–45 minutes without a reservation
`,

  // ══════════════════════════════════════════════════════════════════════════
  // SALON & SPA
  // ══════════════════════════════════════════════════════════════════════════
  salon_spa: (businessName) => `# ${businessName} — AI Receptionist Knowledge Base

## Business Overview
${businessName} is a salon and spa providing professional beauty, grooming, and wellness services. Our skilled team is dedicated to helping every client look and feel their best in a relaxing, welcoming environment.

## Common Services

### Hair Services
- Haircuts (women's, men's, children's)
- Blowouts and styling
- Hair coloring (single process, highlights, balayage, ombré)
- Color correction
- Keratin treatments and smoothing
- Perms and texture services
- Hair extensions (tape-in, sew-in, clip-in)
- Deep conditioning and repair treatments
- Updos and special occasion styling (weddings, proms)
- Scalp treatments

### Nail Services
- Manicures (classic, gel, dip powder, acrylic)
- Pedicures (classic, spa, gel)
- Nail art and design
- Nail repair
- Paraffin treatments
- SNS / dip powder nails
- Nail removal (gel, acrylic)

### Skin & Facial Services
- Facials (classic, deep cleansing, hydrating, anti-aging)
- Chemical peels
- Microdermabrasion
- LED light therapy
- Dermaplaning
- Acne treatments
- Microneedling (if licensed)
- Facial waxing (eyebrows, lip, chin)

### Body Services
- Full body waxing (Brazilian, bikini, legs, arms, back, chest)
- Body scrubs and wraps
- Spray tanning
- Lash extensions and lifts
- Brow tinting and lamination
- Lash tinting
- Microblading (if licensed)
- Teeth whitening (if offered)

### Massage & Wellness
- Swedish massage
- Deep tissue massage
- Hot stone massage
- Prenatal massage
- Aromatherapy
- Reflexology
- Couples massage

## Frequently Asked Questions

**Q: Do I need an appointment, or do you take walk-ins?**
A: Appointments are recommended to ensure availability with your preferred stylist or technician. Walk-ins are welcome based on availability, but wait times may apply.

**Q: Can I request a specific stylist or technician?**
A: Absolutely. Let us know your preference when booking and we'll do our best to accommodate your request.

**Q: What is your cancellation policy?**
A: We require at least 24 hours' notice for cancellations or reschedules. Late cancellations or no-shows may be subject to a fee — typically 50% of the service price.

**Q: How long will my appointment take?**
A: Service times vary. A standard haircut is about 30–45 minutes. Color services range from 1.5 to 3+ hours depending on the process. Facials and massages are typically 60–90 minutes. We'll provide a time estimate when you book.

**Q: Do you offer bridal or event packages?**
A: Yes. We offer bridal party packages including hair, makeup, and nail services. We recommend booking 2–4 weeks in advance for bridal events. Trials are available.

**Q: Should I arrive early?**
A: We recommend arriving 10–15 minutes before your appointment to check in and prepare. For first-time clients, arriving a few minutes earlier for a consultation is helpful.

**Q: What products do you use?**
A: We use professional-grade products from reputable brands. If you have allergies or sensitivities, please let us know so we can accommodate.

**Q: Can I purchase the products you use on my hair/skin?**
A: Yes. We carry a selection of professional retail products that you can purchase at the salon. Our team can recommend products tailored to your needs.

**Q: What should I do to prepare for a waxing appointment?**
A: For best results, hair should be at least 1/4 inch long (about 2–3 weeks of growth). Avoid sun exposure, retinoids, and exfoliating products 48 hours before your appointment.

**Q: Do you offer gift cards?**
A: Yes, gift cards are available in any denomination. They make a wonderful gift for any occasion.

**Q: Is there parking available?**
A: Parking details depend on our location. Our team can provide specifics when you book.

## Service Duration Estimates
- Haircut (women): 45–60 min
- Haircut (men): 20–30 min
- Blowout: 30–45 min
- Single-process color: 1.5–2 hrs
- Highlights (partial): 1.5–2 hrs
- Highlights (full): 2–3 hrs
- Balayage: 2.5–3.5 hrs
- Manicure: 30–45 min
- Pedicure: 45–60 min
- Facial: 60–90 min
- Massage: 60–90 min
- Full body wax: 45–90 min
- Lash extensions (full set): 1.5–2.5 hrs
- Lash fill: 45–60 min

## Upsell Opportunities (Natural Suggestions)
- "Would you like to add a deep conditioning treatment to your color service?"
- "We have a great add-on scalp massage with your haircut."
- "Gel finish is available for an extra $10–15 on top of your manicure."
- "Would you like to book a lash lift with your facial?"
`,

  // ══════════════════════════════════════════════════════════════════════════
  // RETAIL
  // ══════════════════════════════════════════════════════════════════════════
  retail: (businessName) => `# ${businessName} — AI Receptionist Knowledge Base

## Store Overview
${businessName} is a retail business offering quality products and personalized customer service. We are committed to helping customers find exactly what they need with knowledgeable staff and a welcoming shopping experience.

## Common Services
- In-store shopping
- Phone orders
- Online ordering with in-store pickup
- Shipping and delivery options
- Product special orders and custom orders
- Gift wrapping
- Gift cards and gift registries
- Loyalty / rewards program
- Price matching (policy varies)
- Product returns and exchanges

## Frequently Asked Questions

**Q: What are your store hours?**
A: Our hours vary by day and may change for holidays. Please ask and we'll provide our current schedule.

**Q: Do you offer online ordering or shipping?**
A: Many of our products are available for online order with shipping or in-store pickup. Ask us about specific items and we can let you know what's available.

**Q: What is your return policy?**
A: We generally accept returns within 30 days with a receipt for a full refund or exchange. Items must be in their original condition. Some items may be final sale or have modified return windows. Our team can provide specifics.

**Q: Can I exchange an item instead of returning it?**
A: Yes, exchanges are welcome within our return window. If the replacement item has a price difference, we'll process the adjustment.

**Q: Do you price match?**
A: Our price match policy varies. Ask our team and we can check whether a price match applies to your situation.

**Q: Can you check if an item is in stock?**
A: Absolutely. Give us the item name or description and we'll check our current inventory for you. If it's out of stock, we may be able to order it or suggest alternatives.

**Q: Do you offer gift cards?**
A: Yes, gift cards are available in various amounts. They can be purchased in-store or over the phone.

**Q: Can I place a special order for something you don't carry?**
A: We can often special order items that aren't currently in our inventory. Lead times and availability vary, but our team can look into it for you.

**Q: Do you have a loyalty or rewards program?**
A: Yes. Ask our team about our rewards program — it's free to join and offers discounts and perks for repeat customers.

**Q: Do you offer gift wrapping?**
A: Yes, complimentary or low-cost gift wrapping is available for purchases. Ask when you visit.

**Q: Can I order over the phone and pick up in store?**
A: Yes, phone orders with in-store pickup are available for most items. We can have your order ready when you arrive.

## Return & Exchange Guidelines
- **With receipt**: Full refund to original payment method or exchange
- **Without receipt**: Store credit at current selling price (ID may be required)
- **Time window**: Typically 30 days from purchase date
- **Condition**: Items must be unused, in original packaging when applicable
- **Exceptions**: Final sale items, intimate apparel, perishables, custom orders
- **Defective items**: Replaced or refunded regardless of return window

## Common Phone Call Types
1. **Product availability check** — "Do you have [item] in stock?"
2. **Hours and location** — "What time do you open/close?"
3. **Pricing inquiry** — "How much is [item]?"
4. **Return question** — "Can I return something I bought last week?"
5. **Order status** — "Has my order come in yet?"
6. **Special order request** — "Can you order [item] for me?"
`,

  // ══════════════════════════════════════════════════════════════════════════
  // FITNESS
  // ══════════════════════════════════════════════════════════════════════════
  fitness: (businessName) => `# ${businessName} — AI Receptionist Knowledge Base

## Facility Overview
${businessName} is a fitness facility dedicated to helping people achieve their health and wellness goals. We offer a supportive, inclusive environment for all fitness levels — from beginners to advanced athletes.

## Common Services & Offerings

### Memberships
- Individual memberships (monthly, annual, day pass)
- Family memberships
- Student and senior discounts
- Corporate wellness packages
- Free trial passes or guest passes

### Facilities
- Cardio equipment (treadmills, ellipticals, bikes, rowers)
- Free weights and weight machines
- Functional training area
- Stretching and mobility area
- Group fitness studio
- Locker rooms with showers
- Sauna or steam room (if available)
- Pool and hot tub (if available)
- Basketball/racquetball courts (if available)
- Childcare / kids club (if available)

### Group Fitness Classes
- Yoga (vinyasa, hot yoga, restorative)
- Pilates (mat, reformer)
- Spin / indoor cycling
- HIIT (high-intensity interval training)
- Bootcamp
- Zumba / dance fitness
- Barre
- Boxing / kickboxing
- CrossFit-style workouts
- Stretching and mobility classes
- Aqua fitness (if pool available)
- Senior fitness classes

### Personal Training
- One-on-one personal training
- Small group training (2–4 people)
- Nutrition coaching and meal planning
- Body composition analysis
- Fitness assessments and goal setting
- Sport-specific training
- Post-rehab and corrective exercise
- Online / virtual training options

## Frequently Asked Questions

**Q: How much is a membership?**
A: We offer several membership tiers at different price points. Our team can walk you through the options and help you find the best fit. We often have promotions running — ask about current specials.

**Q: Do you offer a free trial?**
A: Yes, we typically offer a free trial day or week so you can experience the facility before committing. Ask about our current trial offer.

**Q: What are your hours?**
A: Our hours vary by day. Some locations offer early morning and late-night access. We'll provide our current schedule when you ask.

**Q: Can I tour the facility?**
A: Absolutely. We welcome tours — you can come in during staffed hours and we'll walk you through the facility. No appointment necessary, but scheduling ensures a staff member is ready for you.

**Q: Do I need to sign a contract?**
A: We offer both month-to-month and annual options. Month-to-month provides flexibility, while annual memberships often come with a discounted rate. Our team will explain all the options.

**Q: What is your cancellation policy?**
A: Cancellation policies vary by membership type. Month-to-month memberships typically require 30 days' written notice. Annual memberships may have an early termination fee. We'll provide the specific details for your plan.

**Q: Do you offer personal training?**
A: Yes, we have certified personal trainers available for one-on-one and small group sessions. Packages are available at various price points. We can set up a free introductory session.

**Q: Are group classes included in my membership?**
A: Most group fitness classes are included with membership. Certain specialty classes or workshops may have an additional fee. Ask about specifics for the classes you're interested in.

**Q: Is there childcare available?**
A: Childcare availability varies by location. If we offer it, hours and age restrictions apply. Ask our team about our current childcare options.

**Q: What should I bring for my first visit?**
A: Bring comfortable workout clothes, athletic shoes, a water bottle, a towel, and a valid photo ID. If you have a trial pass, bring that along too.

**Q: Do you have showers and locker rooms?**
A: Yes, we have locker rooms with showers. Day-use lockers are available (bring your own lock or purchase one from the front desk).

**Q: Can I freeze my membership?**
A: Membership freezes may be available for medical reasons, extended travel, or other circumstances. A small monthly hold fee may apply. Contact us to discuss your situation.

## Terminology
- **HIIT**: High-Intensity Interval Training — short bursts of intense exercise with rest periods
- **BMI**: Body Mass Index — general body composition indicator
- **RPE**: Rate of Perceived Exertion — scale of 1–10 for workout intensity
- **PR**: Personal Record — best performance on a given exercise
- **Rep**: One complete motion of an exercise
- **Set**: A group of consecutive reps
- **Circuit**: A series of exercises performed back-to-back
- **Cool Down**: Low-intensity movement after a workout
- **Active Recovery**: Light exercise on rest days to promote recovery
`,

  // ══════════════════════════════════════════════════════════════════════════
  // LEGAL
  // ══════════════════════════════════════════════════════════════════════════
  legal: (businessName) => `# ${businessName} — AI Receptionist Knowledge Base

## Firm Overview
${businessName} is a law firm providing legal representation and advisory services. Our attorneys are experienced professionals committed to protecting our clients' rights and achieving the best possible outcomes.

## Common Practice Areas

### Personal Injury
- Car, truck, and motorcycle accidents
- Slip and fall / premises liability
- Medical malpractice
- Product liability
- Wrongful death
- Workers' compensation
- Dog bites and animal attacks

### Family Law
- Divorce and separation
- Child custody and visitation
- Child support and spousal support (alimony)
- Prenuptial and postnuptial agreements
- Adoption
- Domestic violence / restraining orders
- Paternity cases
- Modification of existing orders

### Criminal Defense
- DUI / DWI
- Drug offenses
- Theft and property crimes
- Assault and violent crimes
- White-collar crimes
- Traffic violations
- Juvenile offenses
- Expungement / record sealing

### Business / Corporate Law
- Business formation (LLC, corporation, partnership)
- Contracts and agreements
- Mergers and acquisitions
- Employment law and disputes
- Intellectual property (trademarks, copyrights, patents)
- Commercial litigation
- Regulatory compliance

### Estate Planning & Probate
- Wills and trusts
- Power of attorney
- Healthcare directives / living wills
- Probate administration
- Estate litigation
- Asset protection planning
- Guardianship and conservatorship

### Real Estate Law
- Residential and commercial closings
- Title disputes
- Landlord-tenant disputes
- Zoning and land use
- Construction disputes
- HOA disputes
- Lease review and negotiation

### Immigration Law
- Family-based immigration
- Employment-based visas (H-1B, L-1, O-1)
- Green card applications
- Naturalization / citizenship
- Deportation defense
- Asylum and refugee applications
- DACA renewals

## Frequently Asked Questions

**Q: Do you offer free consultations?**
A: Many of our practice areas include a free initial consultation. Our team can confirm whether a free consultation is available for your type of case.

**Q: How much do you charge?**
A: Fees depend on the type of case. Some cases are handled on a contingency basis (no fee unless we win), while others use hourly or flat-fee billing. Our team can provide details during the consultation.

**Q: How do I know if I have a case?**
A: The best way to find out is to speak with one of our attorneys during a consultation. They'll review the facts of your situation and give you an honest assessment.

**Q: What documents should I bring to my consultation?**
A: Bring any documents related to your matter — police reports, medical records, contracts, correspondence, court papers, photos, insurance information, and anything else you think may be relevant.

**Q: How long will my case take?**
A: Timelines vary widely depending on the type of case, its complexity, and whether it settles or goes to trial. Your attorney will provide a realistic timeline during your consultation.

**Q: Will my information be kept confidential?**
A: Yes. All communications between you and our firm are protected by attorney-client privilege. Your information is kept strictly confidential.

**Q: Can I call with questions about my existing case?**
A: Yes. If you're a current client, we'll pass your message to your attorney or case manager for a callback. For urgent matters, please let us know the nature of the urgency.

**Q: What areas do you serve?**
A: We serve clients in our local area and may handle cases in surrounding jurisdictions. Our team can confirm whether we can assist with cases in your location.

## Critical Compliance Rules for the AI Receptionist
- NEVER provide legal advice or opinions
- NEVER say whether someone has a viable case
- NEVER interpret laws, statutes, or regulations
- NEVER discuss other clients or ongoing cases
- NEVER estimate case outcomes, settlement amounts, or timelines
- NEVER provide specific fee amounts — defer to attorney consultation
- ALWAYS maintain confidentiality
- If pressed for advice, say: "An attorney would be the best person to answer that. Let me get your information so we can schedule a consultation."

## Legal Terminology
- **Contingency Fee**: Attorney is paid a percentage of the recovery — no fee if you don't win
- **Retainer**: Upfront payment that the attorney draws from as they work on your case
- **Statute of Limitations**: Legal deadline for filing a claim — varies by case type and jurisdiction
- **Discovery**: Process where both sides gather evidence before trial
- **Deposition**: Sworn testimony given outside of court
- **Mediation**: Voluntary process where a neutral third party helps both sides reach a settlement
- **Arbitration**: Dispute resolution process where a neutral third party makes a binding decision
- **Plaintiff**: The person who files a lawsuit
- **Defendant**: The person being sued or charged
- **Subpoena**: Legal order requiring someone to testify or produce documents
`,

  // ══════════════════════════════════════════════════════════════════════════
  // REAL ESTATE
  // ══════════════════════════════════════════════════════════════════════════
  real_estate: (businessName) => `# ${businessName} — AI Receptionist Knowledge Base

## Company Overview
${businessName} is a real estate company helping buyers, sellers, and renters navigate the property market. Our experienced agents provide personalized guidance through every step of the real estate process.

## Services

### For Buyers
- Home search and property tours
- New construction assistance
- Buyer representation and negotiation
- Market analysis and pricing guidance
- First-time homebuyer guidance
- Mortgage lender referrals
- Home inspection coordination
- Closing process management

### For Sellers
- Comparative market analysis (CMA)
- Home staging advice
- Professional photography and virtual tours
- MLS listing and marketing
- Open houses
- Offer negotiation and review
- Closing coordination
- Relocation assistance

### For Renters
- Rental property search
- Lease review
- Tenant placement services
- Rental market analysis

### Property Management (if offered)
- Tenant screening and placement
- Rent collection
- Maintenance coordination
- Property inspections
- Lease management and renewals
- Financial reporting for owners

### Commercial Real Estate (if offered)
- Office, retail, and industrial leasing
- Commercial property sales
- Investment property analysis
- Site selection
- Lease negotiation

## Frequently Asked Questions

**Q: Are you accepting new clients?**
A: Yes, we're happy to help whether you're buying, selling, or renting. An agent can discuss your needs and how we can assist.

**Q: Is there a fee for working with a buyer's agent?**
A: Buyer's agent compensation varies. In many cases, the seller covers the buyer's agent commission. Your agent will explain how compensation works during your initial consultation. There's no cost for an initial conversation.

**Q: How do I get started with selling my home?**
A: The first step is a consultation with one of our agents. They'll do a comparative market analysis (CMA) to estimate your home's value and discuss a marketing strategy. There's no obligation.

**Q: How long does it take to buy a home?**
A: The timeline varies. Once you're pre-approved for a mortgage, finding and closing on a home typically takes 30–60 days, though it can be longer in competitive markets or with complex transactions.

**Q: How long does it take to sell a home?**
A: Average days on market vary by location and season. Your agent will provide a realistic timeline based on current market conditions in your area.

**Q: Do I need to be pre-approved for a mortgage before looking at homes?**
A: While not required to start looking, getting pre-approved makes the process much smoother. Sellers take offers more seriously from pre-approved buyers, and it helps you know your budget.

**Q: Can you recommend a mortgage lender?**
A: Yes, we work with several reputable lenders and can provide referrals. You're also free to use any lender you choose.

**Q: What should I do to prepare my home for sale?**
A: Your agent will provide personalized advice, but common tips include decluttering, deep cleaning, making minor repairs, improving curb appeal, and considering professional staging.

**Q: What are closing costs?**
A: Closing costs typically range from 2–5% of the purchase price and include items like lender fees, title insurance, appraisal, inspections, and taxes. Your agent and lender will provide a detailed estimate.

**Q: Do you handle rentals?**
A: Yes, we assist with both rental property searches for tenants and property management services for landlords. Ask about our specific rental services.

## Real Estate Terminology
- **CMA (Comparative Market Analysis)**: Report comparing a property to similar recently sold homes to estimate market value
- **MLS (Multiple Listing Service)**: Database where agents list properties for sale
- **Pre-Approval**: A lender's written commitment for a specific loan amount based on your financial profile
- **Escrow**: A neutral third party holds funds and documents until closing conditions are met
- **Closing**: The final step where ownership transfers and all documents are signed
- **Contingency**: A condition in a contract that must be met for the deal to proceed (inspection, appraisal, financing)
- **Appraisal**: An independent assessment of a property's market value — required by most lenders
- **Title Search**: Examination of public records to confirm the seller has legal ownership and there are no liens
- **HOA (Homeowners Association)**: An organization that manages a community and collects dues for maintenance
- **Earnest Money**: A deposit made by the buyer to show good faith — typically 1–3% of the purchase price
- **Under Contract**: A property that has an accepted offer but hasn't closed yet
- **Days on Market (DOM)**: Number of days a listing has been active on the MLS

## Seasonal Market Considerations
- **Spring**: Peak listing and buying season — most inventory, most competition
- **Summer**: Active market, especially for families wanting to move before school starts
- **Fall**: Market slows slightly — less competition for buyers, motivated sellers
- **Winter**: Slowest season — fewer listings, but serious buyers and motivated sellers
`,

  // ══════════════════════════════════════════════════════════════════════════
  // FINANCIAL SERVICES
  // ══════════════════════════════════════════════════════════════════════════
  financial: (businessName) => `# ${businessName} — AI Receptionist Knowledge Base

## Firm Overview
${businessName} is a financial services firm providing professional accounting, tax, and financial advisory services. Our team of experienced professionals helps individuals and businesses make smart financial decisions and stay compliant with regulations.

## Common Services

### Tax Services
- Individual tax preparation (federal and state)
- Business tax preparation (S-Corp, C-Corp, LLC, partnership, sole proprietor)
- Tax planning and strategy
- Quarterly estimated tax payments
- Tax amendment filing
- IRS audit representation and resolution
- Back tax filing (prior year returns)
- State and local tax compliance
- Sales tax filing

### Bookkeeping & Accounting
- Monthly bookkeeping and reconciliation
- Accounts payable and receivable management
- Payroll processing and tax filings
- Financial statement preparation (P&L, balance sheet, cash flow)
- QuickBooks / Xero setup and training
- Year-end closing and adjustments
- 1099 preparation and filing

### Financial Planning & Advisory
- Retirement planning (401k, IRA, Roth IRA)
- Investment advisory
- Estate planning coordination
- Insurance review
- College savings planning (529 plans)
- Debt management and reduction strategies
- Cash flow analysis and budgeting
- Social Security optimization

### Business Advisory
- Business formation and entity selection
- Financial forecasting and projections
- Cash flow management
- Pricing strategy and profitability analysis
- Mergers, acquisitions, and business valuation
- CFO advisory / outsourced CFO services
- SBA loan and financing assistance
- Succession planning

## Frequently Asked Questions

**Q: Are you accepting new clients?**
A: Yes, we welcome new clients. The first step is a consultation to understand your needs and determine how we can help.

**Q: How much do you charge for tax preparation?**
A: Fees depend on the complexity of your return. Simple individual returns start at one rate, while business returns, multi-state filing, and complex situations are priced accordingly. We provide a fee estimate before starting any work.

**Q: What documents do I need for tax preparation?**
A: Common documents include W-2s, 1099s, investment statements, mortgage interest statements (1098), property tax records, charitable donation receipts, business income/expense records, and prior year tax returns. We'll provide a personalized checklist.

**Q: When is the tax filing deadline?**
A: The standard federal deadline is April 15th. Extensions are available (October 15th for individuals), but any taxes owed are still due by April 15th. Business deadlines vary by entity type.

**Q: Can you help if I'm being audited?**
A: Yes. We provide audit representation and can communicate with the IRS on your behalf. If you receive an audit notice, contact us as soon as possible.

**Q: Do you offer virtual or remote services?**
A: Yes. We work with clients remotely using secure document sharing and video consultations. You don't need to be local to work with us.

**Q: What is the difference between a CPA, EA, and tax preparer?**
A: A CPA (Certified Public Accountant) has passed a rigorous exam and is licensed by the state. An EA (Enrolled Agent) is licensed by the IRS to represent taxpayers. Both can handle complex tax matters. A general tax preparer may not have these credentials.

**Q: Can you help me set up a new business?**
A: Yes. We assist with entity selection (LLC vs S-Corp vs C-Corp), EIN registration, state registrations, bookkeeping setup, and tax strategy from day one.

**Q: Do you offer payroll services?**
A: Yes. We handle payroll processing, tax withholding, W-2 preparation, and quarterly payroll tax filings.

**Q: How often should I meet with my accountant?**
A: At minimum, we recommend meeting before tax season and mid-year for tax planning. For businesses, monthly or quarterly check-ins help keep finances on track.

## Critical Compliance Rules for the AI Receptionist
- NEVER provide financial, tax, or investment advice
- NEVER estimate tax refunds, liabilities, or returns
- NEVER discuss specific investment products or strategies
- NEVER guarantee outcomes or savings
- NEVER share information about other clients
- Maintain strict confidentiality on all client matters
- If pressed for specific advice, say: "Our team can discuss that in detail during your appointment."

## Tax Season Timeline
- **January**: W-2s and 1099s begin arriving; prior year books should be closed
- **January 31**: Deadline for employers to issue W-2s and 1099s
- **March 15**: S-Corp and partnership return deadline (or extension)
- **April 15**: Individual and C-Corp return deadline (or extension)
- **June 15**: Estimated tax payment due (Q2)
- **September 15**: Estimated tax payment due (Q3); extended S-Corp/partnership deadline
- **October 15**: Extended individual return deadline
- **December 31**: Last day for certain tax planning moves (retirement contributions, charitable giving, etc.)

## Terminology
- **CPA**: Certified Public Accountant
- **EA**: Enrolled Agent — IRS-licensed tax professional
- **W-2**: Wage and tax statement from an employer
- **1099**: Income statement for independent contractors, freelancers, and other non-employment income
- **P&L (Profit & Loss)**: Financial statement showing revenue, expenses, and net income
- **Balance Sheet**: Snapshot of assets, liabilities, and equity at a point in time
- **Cash Flow Statement**: Shows how cash moves in and out of a business
- **Deduction**: Expense that reduces taxable income
- **Depreciation**: Spreading the cost of an asset over its useful life for tax purposes
- **Estimated Taxes**: Quarterly tax payments made by self-employed individuals and businesses
`,

  // ══════════════════════════════════════════════════════════════════════════
  // AUTOMOTIVE
  // ══════════════════════════════════════════════════════════════════════════
  automotive: (businessName) => `# ${businessName} — AI Receptionist Knowledge Base

## Business Overview
${businessName} is an automotive service business providing professional vehicle maintenance, repair, and care. Our certified technicians use quality parts and equipment to keep your vehicle running safely and reliably.

## Common Services

### Routine Maintenance
- Oil changes (conventional, synthetic blend, full synthetic)
- Tire rotation, balancing, and alignment
- Brake inspection and service (pads, rotors, fluid flush)
- Battery testing and replacement
- Air filter and cabin filter replacement
- Fluid checks and top-offs (coolant, transmission, power steering, brake)
- Wiper blade replacement
- Spark plug replacement
- Belts and hoses inspection and replacement
- Multi-point safety inspections

### Repair Services
- Engine diagnostics and check engine light
- Transmission repair and service
- Electrical system diagnosis and repair
- Suspension and steering repair (shocks, struts, tie rods, ball joints)
- Exhaust system repair (muffler, catalytic converter)
- AC repair and recharge
- Radiator and cooling system repair
- Fuel system service
- Timing belt / chain replacement
- Head gasket repair
- Clutch repair and replacement

### Tire Services
- New tire sales and installation
- Flat tire repair
- Tire rotation and balancing
- Wheel alignment (2-wheel and 4-wheel)
- TPMS (tire pressure monitoring) service
- Seasonal tire changeover (winter/summer)

### Body & Cosmetic (if offered)
- Dent repair (PDR — paintless dent removal)
- Scratch and paint repair
- Windshield repair and replacement
- Detailing (interior and exterior)
- Paint protection and ceramic coating

### Specialty Services
- State inspection and emissions testing
- Fleet maintenance programs
- Pre-purchase vehicle inspections
- Classic and vintage car service
- Diesel engine service
- Hybrid and electric vehicle service
- Performance upgrades and tuning

## Frequently Asked Questions

**Q: Do I need an appointment, or do you take walk-ins?**
A: Both. Appointments are recommended to ensure timely service, but we accept walk-ins for quick services like oil changes when availability allows.

**Q: How long will my service take?**
A: It depends on the service. Oil changes and tire rotations typically take 30–60 minutes. More complex repairs may take several hours to a full day. We'll provide a time estimate when you check in.

**Q: Can you give me an estimate before doing the work?**
A: Absolutely. We always provide an estimate before starting any work. If additional issues are found during inspection, we'll call you for approval before proceeding.

**Q: Do you offer loaner cars or shuttle service?**
A: Availability varies. We may offer loaner vehicles, shuttle service, or can help arrange a ride for you while your vehicle is being serviced. Ask when scheduling.

**Q: Do you use OEM or aftermarket parts?**
A: We offer both OEM (Original Equipment Manufacturer) and quality aftermarket parts. Your service advisor can discuss the options and price differences for your specific repair.

**Q: Will you work on my vehicle's brand/make?**
A: We service most makes and models. If we specialize in certain brands or have limitations, our team will let you know.

**Q: Do you offer a warranty on repairs?**
A: Yes. We warranty our work — typically covering parts and labor for a specified period. Warranty details vary by service and parts used.

**Q: What does the check engine light mean?**
A: The check engine light can indicate anything from a loose gas cap to a more serious engine or emissions issue. We recommend bringing your vehicle in for a diagnostic scan to identify the specific problem. Continuing to drive with the light on could cause further damage.

**Q: How often should I change my oil?**
A: The standard recommendation is every 3,000–5,000 miles for conventional oil and 5,000–7,500 miles for synthetic oil. However, always follow your vehicle manufacturer's recommendations, which may vary.

**Q: How do I know when I need new brakes?**
A: Common signs include squealing or grinding noise, longer stopping distances, vibration when braking, or the brake warning light on your dashboard. We recommend a brake inspection if you notice any of these.

**Q: Do you offer financing or payment plans?**
A: We accept all major credit cards and may offer financing options for larger repairs. Ask our service advisors about current financing availability.

**Q: Can you do my state inspection?**
A: Yes (if applicable in your state). We perform state safety and emissions inspections. If your vehicle doesn't pass, we can discuss the needed repairs.

## Safety-Critical Issues (Prioritize These)
These warrant same-day or next-day attention:
- Brake problems (soft pedal, grinding, warning light)
- Steering issues (difficulty turning, play in the wheel)
- Dashboard warning lights (check engine, oil pressure, temperature, ABS, airbag)
- Overheating engine
- Unusual smoke from exhaust (white, blue, or black)
- Fluid leaks under the vehicle (especially brake fluid or coolant)
- Tire damage or blowout
- Strange burning smell

## Maintenance Schedule Reference
- **Every 3,000–7,500 miles**: Oil change (depending on oil type)
- **Every 5,000–7,500 miles**: Tire rotation
- **Every 15,000–30,000 miles**: Air filter, cabin filter replacement
- **Every 30,000 miles**: Transmission fluid service, coolant flush
- **Every 30,000–60,000 miles**: Spark plug replacement, brake fluid flush
- **Every 60,000–100,000 miles**: Timing belt replacement (if applicable), suspension inspection
- **Annually**: Battery test, multi-point inspection, alignment check

## Terminology
- **OEM**: Original Equipment Manufacturer — factory parts
- **Aftermarket**: Non-factory parts, often less expensive but varying in quality
- **Diagnostic Scan**: Electronic reading of vehicle computer codes to identify problems
- **Alignment**: Adjusting wheel angles for proper tire contact and straight driving
- **Balancing**: Adding small weights to wheels to eliminate vibration
- **Caliper**: Part of the brake system that squeezes pads against the rotor
- **Catalytic Converter**: Emission control device that reduces harmful exhaust gases
- **CV Joint**: Constant velocity joint — transfers power to the wheels while allowing steering
- **TPMS**: Tire Pressure Monitoring System — dashboard alert for low tire pressure
- **Serpentine Belt**: Single belt that drives multiple engine components (AC, alternator, power steering)
`,

  waterproofing: (businessName) => `# ${businessName} (AI Receptionist Knowledge Base)

## Company Overview
${businessName} is a waterproofing, foundation repair, and mold company. We help homeowners keep water out, stabilize and repair foundations, and deal with mold and moisture, so their homes stay dry, healthy, and structurally sound. We offer free, no-obligation inspections.

## Common Services

### Basement Waterproofing
- Interior drainage systems (perimeter drain / French drain)
- Sump pump installation and replacement, with battery backup options
- Wall vapor barriers and waterproof wall membranes
- Foundation wall crack repair and crack injection
- Discharge line and freeze-guard solutions

### Crawl Space
- Crawl space encapsulation (sealed vapor barrier system)
- Crawl space drainage and sump systems
- Dehumidifier installation for humidity and musty odors
- Insulation removal and replacement
- Standing-water and moisture cleanup

### Foundation Repair
- Foundation settlement repair (push piers and helical piers)
- Bowing or leaning wall stabilization (carbon fiber straps, wall anchors)
- Foundation and basement wall crack repair
- Sagging or soft floor and floor-joist support
- Structural evaluations

### Concrete
- Concrete lifting and leveling (polyurethane foam)
- Driveways, sidewalks, patios, pool decks, and slabs
- Concrete sealing

### Mold and Moisture
- Mold inspection and testing
- Mold remediation and removal
- Soda blasting for crawl space and basement mold
- Containment and HEPA air filtration during remediation
- Moisture source identification and humidity control

### Drainage
- Exterior and yard drainage
- Downspout and gutter tie-ins
- Grading and water management around the foundation

## Frequently Asked Questions

**Q: Do you offer free inspections?**
A: Yes. We provide a free, no-obligation inspection. A specialist comes out, looks at the problem, and gives you a clear assessment and estimate.

**Q: How much will it cost?**
A: It depends on what's found, since every home is different. That's why the inspection is free, it's how we give you an accurate price.

**Q: Do you offer financing?**
A: Financing options are commonly available for larger projects. The team can walk you through the options during or after your inspection.

**Q: Do you offer a warranty?**
A: Yes, our repairs are backed by a warranty. The specifics depend on the solution, and the team will go over the details for your project.

**Q: Will my homeowners insurance cover this?**
A: Foundation and waterproofing work is often not covered by standard homeowners insurance, though some sudden water-damage events may be. The best step is to check your policy and let our team help you figure it out.

**Q: What are the warning signs I should watch for?**
A: Water or dampness in the basement or crawl space, a musty smell, cracks in walls or floors, stair-step cracks in brick, bowing walls, sticking doors or windows, sloping or bouncy floors, and visible mold. If you're seeing any of these, it's worth a free inspection.

**Q: How long does the work take?**
A: It depends on the scope. Many jobs are completed in a day or two, larger structural projects take longer. The inspector will give you a realistic timeline.

## Urgency Guidelines

### Urgent (get the team on it fast)
- Active flooding or standing water entering the home right now
- Sewage backup
- Water actively pouring in during a storm

### Soon (new-lead intake, book the inspection promptly)
- A wet or damp basement or crawl space that is ongoing
- Visible mold or a strong musty smell
- A new or growing crack, a bowing wall, sloping floors
- A failed or failing sump pump (no active flood)

### Routine (book the free inspection)
- Concrete leveling
- Preventive waterproofing or encapsulation quotes
- General questions and estimates

## What to Expect at the Free Inspection
1. A specialist inspects the affected areas (basement, crawl space, foundation, drainage)
2. They identify the source of the water or movement, not just the symptom
3. They explain what they found in plain language
4. They provide a written estimate and, if wanted, financing options
5. You decide, with no obligation

## Terminology
- **Encapsulation**: fully sealing a crawl space with a heavy vapor barrier to lock out moisture
- **Vapor barrier**: a liner that stops ground moisture from rising into the home
- **Sump pump**: a pump that collects and expels water that drains into a basin
- **French drain / interior drainage**: a perimeter channel that routes water to the sump pump
- **Foundation settlement**: the foundation sinking or shifting as soil moves
- **Push piers / helical piers**: steel piers driven down to stable soil to stabilize and lift a foundation
- **Bowing wall**: a foundation wall pushed inward by soil pressure, stabilized with carbon fiber or anchors
- **Stair-step cracks**: diagonal cracks following mortar joints in brick or block, a settlement sign
- **Efflorescence**: white mineral residue left on masonry by water, a moisture indicator
- **Hydrostatic pressure**: water pressure in the soil that pushes water through foundation walls and floors
- **Concrete leveling**: lifting sunken concrete back into place, often with polyurethane foam
- **Remediation**: the professional removal and cleanup of mold, plus addressing its moisture source
`,

  junk_removal: (businessName) => `# ${businessName} (AI Receptionist Knowledge Base)

## Company Overview
${businessName} provides junk removal and dumpster rental. We offer two ways to clear out junk: full-service removal, where our crew loads and hauls everything away for you, and roll-off dumpster rental, where we drop off a container, you fill it on your own schedule, and we haul it away when you're done.

## Full-Service Junk Removal (we load and haul)

### What We Remove
- Single-item pickups (a couch, a fridge, a mattress)
- Furniture removal (sofas, beds, tables, dressers)
- Appliance removal (washers, dryers, stoves, refrigerators)
- Mattress and box spring removal
- Electronics and e-waste (TVs, monitors, computers)
- Hot tub, shed, deck, and fence removal (light demolition)
- Yard waste and landscaping debris
- Garage, attic, and basement cleanouts
- Whole-home cleanouts
- Estate cleanouts
- Hoarder cleanouts
- Eviction and foreclosure / property-management cleanouts
- Commercial and office cleanouts
- Construction and renovation debris
- Donation and recycling hauling when items can be reused

### How Pricing Works
Full-service pricing is based on volume, that is, how much of the truck your items fill. The crew confirms the price on site before they load. We don't charge by the hour.

## Roll-Off Dumpster Rental (you load it)

### Sizes and Typical Uses
- **10 yard**: small cleanouts, a single room, or heavy material like concrete or dirt. Holds about 3 to 4 pickup-truck loads.
- **15 yard**: medium cleanouts, flooring or small remodel debris.
- **20 yard**: the most popular size for home projects, remodels, garage and yard cleanouts, roofing. Shorter walls make it easy to load.
- **30 yard**: large cleanouts, whole-home projects, big remodels and additions.
- **40 yard**: major construction, demolition, or large commercial jobs.

A good rule of thumb: when stuck between two sizes, the larger one is usually the better value, since most of the cost is delivery and hauling, not the size of the can.

### Rental Periods and Weight
- Rentals typically include a set number of days (commonly 7 to 14, varies by area). Extra days are charged at a flat daily rate.
- Each dumpster has an included weight limit. Going over the limit adds an overage charge per ton.
- Heavy material (concrete, dirt, brick, asphalt, roofing shingles) is dense, so it usually goes in a smaller "heavy" can to stay within weight limits.

### Delivery and Placement
- We drop the dumpster where you want it, usually a driveway. The driver needs a clear, flat spot with room to access it.
- If the dumpster has to sit on a public street, a permit may be required. The team will let you know and help with that.

## What Cannot Go in a Dumpster or Truck
For safety and landfill rules, these are generally not allowed: hazardous chemicals, paint, oil, flammables, liquids, car and other batteries, tires, propane tanks, asbestos, medical waste, and appliances containing refrigerant (refrigerators, freezers, AC units) unless arranged for special handling. If a caller mentions these, flag them and have the team confirm what can be taken and how.

## Frequently Asked Questions

**Q: How much does it cost?**
A: Full-service removal is priced by how much your items fill the truck, and the crew confirms it on site. Dumpsters are a flat rate based on the size and your area, including delivery, pickup, a rental period, and a weight limit. The team will give you the exact number.

**Q: Do I need to be home?**
A: For full-service pickups, it helps for someone to be there to point out what's going, but the team can often make arrangements. For dumpster drop-off, you just need the placement spot clear.

**Q: How soon can you come?**
A: Often same-day or next-day depending on the schedule and your area. The team will confirm availability.

**Q: How long can I keep a dumpster?**
A: The rental includes a set number of days, and you can keep it longer for a flat daily rate. Just let the team know.

**Q: What do you do with the stuff?**
A: We donate and recycle whatever we can, and dispose of the rest responsibly.

**Q: Can you take just one item?**
A: Yes, single-item pickups are no problem.

## Terminology
- **Roll-off**: the open-top dumpster that's delivered and picked up by truck
- **Yard**: a cubic yard, the unit dumpster size is measured in (a 20 yard holds 20 cubic yards)
- **Truckload**: the unit full-service junk removal is priced in, based on how much of the truck fills
- **Weight limit / tonnage**: the included weight for a dumpster, with overage charged per ton beyond it
- **Overage**: an extra charge for going over the included weight or rental days
- **Cleanout**: clearing an entire space, such as an estate, hoarder, eviction, or foreclosure cleanout
- **Curbside**: items placed at the curb for an easier, lower-cost pickup
`,

  hvac: (businessName) => `# ${businessName} (AI Receptionist Knowledge Base)

## Company Overview
${businessName} is a heating and cooling (HVAC) company. We repair, maintain, install, and replace heating and air conditioning systems, and help with indoor air quality, keeping homes comfortable year-round. We offer free estimates on system replacements.

## Common Services

### Heating
- Furnace repair, maintenance, and replacement (gas, electric, oil)
- Heat pump repair, maintenance, and installation
- Boiler service
- Ductless mini-split heating
- Thermostat repair and smart-thermostat installation
- No-heat diagnostics

### Cooling
- Central air conditioning repair, maintenance, and replacement
- Heat pump cooling
- Ductless mini-split AC
- Refrigerant leak diagnosis and recharge
- Condenser and coil cleaning
- No-cooling diagnostics

### Air Quality
- Air filter replacement and upgrades
- Whole-home air purifiers and UV lights
- Humidifiers and dehumidifiers
- Duct cleaning and sealing

### Maintenance
- Seasonal tune-ups (heating and cooling)
- Maintenance plans / service agreements
- System inspections

### Installation and Replacement
- Full system replacement (free estimates)
- New-construction and add-on systems
- System sizing and load evaluation
- Financing options on replacements

## Frequently Asked Questions

**Q: Do you offer free estimates?**
A: Yes, estimates on system replacements are free. For a repair or diagnostic visit there is usually a service or diagnostic fee, which the team can confirm.

**Q: Do you handle emergencies?**
A: Yes. No heat in cold weather and no cooling in dangerous heat are treated urgently, especially when there is an elderly person, an infant, or a medical need in the home.

**Q: What brands do you service?**
A: Our techs service most major heating and cooling brands. If you know your brand, mention it and we can confirm.

**Q: Do you offer maintenance plans?**
A: Yes. Maintenance plans cover seasonal tune-ups and often include priority service and discounts. The team can go over what is included.

**Q: How often should I service my system?**
A: Generally once a year for each, cooling in spring and heating in fall. Regular maintenance keeps efficiency up and prevents breakdowns.

**Q: Do you offer financing?**
A: Financing is commonly available on new-system installations. The team can walk you through the options.

**Q: My system is old, should I repair or replace it?**
A: It depends on the age, condition, and repair cost. A tech will give you an honest recommendation, and replacement estimates are free.

## Urgency Guidelines

### Urgent (get the team on it fast)
- No heat when it is cold out, especially with elderly people, infants, or medical needs at home
- No cooling during dangerous heat, especially with vulnerable people at home
- Any gas smell or suspected carbon monoxide (safety first: leave and call the gas company or 911)

### Soon (new-lead intake, book a visit promptly)
- System running but not keeping up, short-cycling, or making unusual noises
- Water or ice around the unit
- Rising energy bills or weak airflow

### Routine (book the visit or free estimate)
- Seasonal tune-ups and maintenance
- Replacement or new-system quotes
- Thermostat or air-quality upgrades

## What to Expect
1. A technician comes out and diagnoses the heating, cooling, or air-quality issue
2. They explain what is going on in plain language
3. They provide options and pricing (replacement estimates are free)
4. With your approval, they complete the repair or schedule the install
5. You get a comfortable, working system

## Terminology
- **SEER / SEER2**: a cooling-efficiency rating, higher is more efficient
- **AFUE**: a furnace-efficiency rating, the percentage of fuel turned into heat
- **Tonnage**: the cooling capacity of an AC system (one ton equals 12,000 BTU)
- **Heat pump**: a system that both heats and cools by moving heat rather than burning fuel
- **Ductless / mini-split**: a system that heats or cools without ductwork, using wall units
- **Refrigerant**: the fluid that absorbs and releases heat in an AC or heat pump
- **Condenser**: the outdoor unit that releases heat
- **Evaporator coil**: the indoor coil that absorbs heat
- **Load calculation**: sizing a system to a home so it is not over- or under-powered
- **Short-cycling**: a system turning on and off too frequently, a sign of a problem`,

  plumbing: (businessName) => `# ${businessName} (AI Receptionist Knowledge Base)

## Company Overview
${businessName} is a plumbing company. We fix leaks, clear drains, service and install water heaters, repair and replace fixtures and pipes, and handle sewer and water-line work, keeping water flowing where it should and out of where it should not. We offer free estimates on larger jobs.

## Common Services

### Repairs
- Leak detection and repair
- Faucet, sink, and toilet repair
- Pipe repair and replacement
- Low water pressure diagnosis
- Running or clogged toilets

### Drains and Sewer
- Drain cleaning and unclogging
- Hydro jetting
- Sewer camera inspection
- Sewer line repair and replacement
- Root intrusion and backups

### Water Heaters
- Water heater repair and replacement
- Tankless water heater installation
- No-hot-water diagnostics
- Flushing and maintenance

### Fixtures and Remodel
- Faucet, sink, toilet, and shower installation
- Garbage disposal repair and install
- Bathroom and kitchen plumbing for remodels
- Water filtration systems

### Pipes and Lines
- Repiping
- Water-line repair and replacement
- Gas-line work
- Sump pump repair and installation

## Frequently Asked Questions

**Q: Do you offer free estimates?**
A: Estimates on larger jobs are typically free. Diagnostic or service visits may carry a fee, which the team can confirm.

**Q: Do you handle emergencies?**
A: Yes. Active leaks, burst pipes, sewer backups, and no water to the home are treated urgently.

**Q: My water heater is leaking, what should I do?**
A: If it is leaking heavily, you can shut off the water supply to it, and we will get a plumber out. If there is any gas smell near a gas unit, leave and call the gas company or 911.

**Q: How long do water heaters last?**
A: A traditional tank heater usually lasts 8 to 12 years, tankless units longer. If yours is older and giving trouble, replacement may be worth discussing.

**Q: Do you do tankless water heaters?**
A: Yes, we install and service tankless units. They save space and can lower energy use, the team can go over whether one fits your home.

**Q: What is hydro jetting?**
A: A high-pressure water method that fully clears a drain or sewer line, useful for stubborn clogs and grease or root buildup.

**Q: Do you offer financing?**
A: Financing is commonly available on larger jobs like repipes and water-heater replacements.

## Urgency Guidelines

### Urgent (get a plumber on it fast)
- An active leak or burst pipe with water coming out now
- A sewage or sewer backup in the home
- No water at all to the house
- A gas smell near a gas water heater (safety first: leave and call the gas company or 911)

### Soon (new-lead intake, book a visit promptly)
- No hot water
- A slow or fully clogged drain
- A running toilet, dripping fixture, or low water pressure

### Routine (book the visit or free estimate)
- Fixture installs and upgrades
- Remodels and repipes
- Inspections and general questions

## What to Expect
1. A plumber comes out and diagnoses the issue
2. They explain the problem and the fix in plain language
3. They provide pricing and options (estimates on larger jobs are free)
4. With your approval, they complete the work
5. Your plumbing is back in working order

## Terminology
- **Hydro jetting**: clearing a drain or sewer line with high-pressure water
- **Sewer camera**: a camera run down a line to find clogs, breaks, or root intrusion
- **Tankless water heater**: a unit that heats water on demand instead of storing it in a tank
- **PEX**: a flexible plastic piping commonly used in modern plumbing
- **Main shutoff**: the valve that stops all water to the home
- **P-trap**: the curved pipe under a sink that blocks sewer gas
- **Backflow**: water flowing the wrong direction, which can contaminate clean water
- **Sump pump**: a pump that removes water collecting in a basin, often in a basement
- **Repipe**: replacing the pipes throughout part or all of a home`,

  electrical: (businessName) => `# ${businessName} (AI Receptionist Knowledge Base)

## Company Overview
${businessName} is an electrical company. We repair and install wiring, panels, outlets, lighting, and EV chargers, troubleshoot electrical problems, and handle safety upgrades, keeping homes powered safely and up to code. We offer free estimates on projects, and we take safety issues seriously.

## Common Services

### Repairs
- Tripping breakers and blown fuses
- Dead or faulty outlets and switches
- Flickering or dimming lights
- Electrical troubleshooting and diagnostics
- Partial power loss

### Panels and Service
- Electrical panel upgrades and replacement
- Sub-panel installation
- Service upgrades (higher amperage)
- Fuse box to breaker conversions

### Wiring
- Rewiring and new circuits
- Outlet and switch installation
- Whole-home rewires
- Aluminum wiring remediation

### Lighting
- Fixture installation and replacement
- Recessed and under-cabinet lighting
- Outdoor and landscape lighting
- Ceiling fans

### Safety and Upgrades
- Surge protection
- GFCI and AFCI installation
- Smoke and carbon-monoxide detectors
- Electrical safety inspections
- Code corrections

### EV and Power
- EV charger installation
- Generator installation and transfer switches
- Backup power

## Frequently Asked Questions

**Q: Do you offer free estimates?**
A: Estimates on projects are typically free. A diagnostic or troubleshooting visit may carry a fee, which the team can confirm.

**Q: Do you handle emergencies?**
A: Yes. A burning smell, smoke, sparks, or exposed live wiring is treated as urgent, and safety comes first.

**Q: My breaker keeps tripping, is that dangerous?**
A: A breaker tripping occasionally is doing its job, but if it trips repeatedly, or there is any burning smell or heat, it is worth having a licensed electrician look at it.

**Q: How do I know if I need a panel upgrade?**
A: Common signs are an old fuse box, frequent tripping, flickering lights, not enough outlets, or adding a big load like an EV charger or addition. A tech can assess it.

**Q: Do you install EV chargers?**
A: Yes. We install home EV chargers and can advise on whether your panel can support one.

**Q: Do you pull permits?**
A: Yes, we handle permits and inspections where required, and our work is done to code.

**Q: Do you offer financing?**
A: Financing is commonly available on larger projects like panel upgrades and rewires.

## Urgency Guidelines

### Urgent (safety, get the team on it fast)
- A burning smell, smoke, or heat around an outlet, switch, or the panel
- Sparks, or exposed or damaged live wiring
- Partial power loss with any burning smell or buzzing
(For any smoke or fire, the caller should get out and call 911.)

### Soon (new-lead intake, book a visit promptly)
- A breaker that keeps tripping
- Dead outlets or switches, flickering lights
- Total power loss after confirming it is not a utility outage

### Routine (book the visit or free estimate)
- Panel upgrades and new circuits
- Lighting, fans, and outlet additions
- EV chargers, generators, and safety upgrades

## What to Expect
1. A licensed electrician comes out and diagnoses the issue safely
2. They explain what is going on and what it will take to fix
3. They provide pricing and options (project estimates are free)
4. With your approval, they complete the work to code
5. Your electrical is safe and working

## Terminology
- **Panel / breaker box**: the box that distributes power to a home circuits
- **Amps / amperage**: the amount of electrical current a service or circuit can carry
- **Service upgrade**: increasing a home electrical capacity, often 100A to 200A
- **Sub-panel**: a smaller panel branching off the main to serve an area or addition
- **Circuit**: a single path of wiring protected by one breaker
- **GFCI**: an outlet that shuts off power fast to prevent shock, used near water
- **AFCI**: a breaker that guards against arc-fault fires
- **Surge protector**: a device that protects a home from voltage spikes
- **Code**: the electrical safety standards work must meet
- **Permit**: local authorization required for certain electrical work`,

  roofing: (businessName) => `# ${businessName} (AI Receptionist Knowledge Base)

## Company Overview
${businessName} is a roofing company. We repair and replace roofs, handle leaks and storm damage, perform inspections, and help homeowners through the insurance-claim process, keeping roofs sound and homes dry. We offer free inspections.

## Common Services

### Repairs
- Roof leak repair
- Missing, cracked, or curling shingle replacement
- Flashing repair (around chimneys, vents, valleys)
- Emergency tarping

### Replacement
- Full roof replacement (tear-off and re-roof)
- Asphalt shingle, metal, tile, and flat roofing
- New-construction roofing
- Free replacement estimates

### Storm and Insurance
- Hail and wind damage assessment
- Storm-damage repair and replacement
- Insurance-claim assistance and documentation

### Inspections
- Free roof inspections
- Pre-purchase and maintenance inspections
- Leak diagnosis

### Related
- Gutter installation and repair
- Attic ventilation and insulation
- Skylight installation and repair

## Frequently Asked Questions

**Q: Do you offer free inspections?**
A: Yes. A specialist comes out, inspects the roof, and gives you a clear assessment and estimate at no cost.

**Q: How much will a repair or replacement cost?**
A: It depends on the size, materials, and condition, so the inspection is how we give you an accurate number, and inspections are free.

**Q: Do you help with insurance claims?**
A: Yes, the team can document the damage and walk you through the claim process. We cannot tell you what your insurance will cover, but we help you work with your insurer.

**Q: I have a leak, what should I do?**
A: If water is actively coming in during a storm, put a bucket down, move valuables, and we will get someone out. If it is a stain or an occasional drip, we will book an inspection.

**Q: How long does a roof last?**
A: An asphalt-shingle roof commonly lasts 15 to 30 years depending on the material and conditions, metal and tile longer. An inspection can tell you where yours stands.

**Q: Do you offer financing?**
A: Financing is commonly available on replacements, the team can go over the options.

**Q: Do you offer a warranty?**
A: Yes, our work is backed by a warranty, and materials carry manufacturer warranties. The team will go over the specifics.

## Urgency Guidelines

### Urgent (get the team on it fast)
- Water actively pouring or dripping into the home during rain or a storm

### Soon (new-lead intake, book the inspection promptly)
- A leak showing as a ceiling stain or occasional drip
- Storm or hail damage after the weather has passed
- Missing or damaged shingles, visible sagging

### Routine (book the free inspection)
- Aging-roof and replacement quotes
- Gutters, ventilation, and skylights
- General questions and estimates

## What to Expect at the Free Inspection
1. A specialist inspects the roof, flashing, and problem areas
2. They identify the source of the leak or damage
3. They explain what they found in plain language
4. They provide a written estimate and, if relevant, help with the insurance claim
5. You decide, with no obligation

## Terminology
- **Shingle**: the overlapping surface material on most residential roofs
- **Flashing**: metal that seals joints and transitions, around chimneys, vents, and valleys
- **Underlayment**: the protective layer between the decking and the shingles
- **Decking / sheathing**: the wood surface the roof is built on
- **Ridge / soffit vents**: parts of the attic ventilation system
- **Valley**: where two roof slopes meet, a common leak point
- **Fascia**: the board along the roof edge that gutters attach to
- **Square**: a roofing measurement equal to 100 square feet
- **Tear-off**: removing the old roof before installing a new one
- **Ice dam**: ice buildup at the roof edge that can force water under shingles
- **Adjuster**: the insurance representative who assesses storm-damage claims`,

  pest_control: (businessName) => `# ${businessName} (AI Receptionist Knowledge Base)

## Company Overview
${businessName} is a pest control company. We handle infestations and prevention, ants, roaches, rodents, bed bugs, termites, stinging insects, and more, with one-time treatments and recurring service to keep pests away. We offer free inspections.

## Common Services

### General Pest
- Ants, cockroaches, spiders, silverfish
- Interior and exterior perimeter treatments
- One-time and recurring service

### Rodents
- Mice and rat control
- Exclusion (sealing entry points)
- Trapping and cleanup

### Bed Bugs
- Bed bug inspection and treatment
- Heat and chemical treatments
- Follow-up service

### Termites
- Termite inspection
- Termite treatment and baiting systems
- Prevention and warranties

### Stinging Insects
- Wasp, hornet, and bee nest removal
- Yellowjacket control

### Other
- Mosquito control
- Flea and tick treatment
- Wildlife and nuisance animals
- Recurring prevention plans (monthly, quarterly)

## Frequently Asked Questions

**Q: Do you offer free inspections?**
A: Yes. A technician assesses the situation and gives you a plan and pricing at no cost.

**Q: How much does treatment cost?**
A: It depends on the pest and the severity, so we usually take a quick look first, and inspections are free.

**Q: Are your treatments safe for kids and pets?**
A: The technician will go over safety and any short waiting period before re-entering treated areas. Follow their guidance for your specific treatment.

**Q: Do you offer recurring service?**
A: Yes. Many customers use monthly or quarterly plans to keep pests away year-round, which is often the most effective approach.

**Q: Do you guarantee your work?**
A: Many services come with a guarantee or free re-treatment within a period. The team will explain what applies to your service.

**Q: How should I prepare for a treatment?**
A: It varies by pest, bed bug and roach treatments need more prep. The team will give you a prep list when you schedule.

**Q: How long until the pests are gone?**
A: Some pests clear quickly, others take a few visits. The technician will set realistic expectations and a follow-up plan.

## Urgency Guidelines

### Urgent (get the team on it fast)
- A stinging-insect situation (wasps, hornets, bees) where someone is allergic or reacting (a medical reaction means call 911 first)

### Soon (new-lead intake, book promptly)
- An active infestation, bed bugs, or a rodent problem
- A wasp or hornet nest near the home

### Routine (book the visit or free inspection)
- Recurring prevention service
- Termite inspections and quotes
- General questions and estimates

## What to Expect
1. A technician inspects and identifies the pest and the source
2. They explain the treatment plan in plain language
3. They provide pricing and options (inspections are free)
4. With your approval, they treat and set any follow-up
5. Your pest problem is handled

## Terminology
- **Extermination**: eliminating a pest infestation
- **Exclusion**: sealing entry points so pests cannot get back in
- **IPM (Integrated Pest Management)**: a prevention-first approach combining several methods
- **Perimeter treatment**: treating the exterior boundary to keep pests out
- **Baiting system**: stations that pests carry back to the colony, common for termites and ants
- **Infestation**: an established pest population in or around a home
- **Re-treatment**: a follow-up service, often covered by a guarantee`,

  landscaping: (businessName) => `# ${businessName} (AI Receptionist Knowledge Base)

## Company Overview
${businessName} is a landscaping and lawn care company. We handle lawn maintenance, cleanups, landscape design and installation, mulch, irrigation, and seasonal work, keeping yards healthy and looking great. We offer free estimates.

## Common Services

### Lawn Care
- Mowing and edging
- Fertilization and weed control
- Aeration and overseeding
- Lawn treatments and disease control

### Maintenance
- Trimming, pruning, and shrub care
- Seasonal cleanups (spring and fall)
- Leaf removal
- Bed maintenance and weeding

### Design and Installation
- Landscape design
- Planting (trees, shrubs, flowers)
- Sod installation
- Hardscaping (patios, walkways, retaining walls)

### Mulch and Beds
- Mulch and rock installation
- Bed edging and refresh
- Soil and grading

### Irrigation
- Sprinkler installation and repair
- Irrigation system maintenance
- Drip systems

### Seasonal
- Leaf and debris cleanup
- Seasonal color and plantings
- Snow removal (where offered)

## Frequently Asked Questions

**Q: Do you offer free estimates?**
A: Yes. Every property is a little different, so we come take a look and give you an accurate quote at no cost.

**Q: Do you offer recurring service, or just one-time?**
A: Both. Many customers set up regular mowing and maintenance, and we also do one-time cleanups and projects.

**Q: How much does service cost?**
A: It depends on the property size and what is involved, which is why estimates are free.

**Q: Do you require a contract?**
A: For recurring service the team will go over the options, some are seasonal agreements and some are month to month.

**Q: What area do you serve?**
A: The team can confirm whether your property is in the service area when you provide the address.

**Q: Do you do design and installation, not just mowing?**
A: Yes. We do full landscape design, planting, sod, and hardscaping in addition to maintenance.

**Q: When is the best time for aeration or seeding?**
A: It depends on your grass type and region, the team can recommend the right timing for your lawn.

## Urgency Guidelines

### Soon (new-lead intake, book promptly)
- An overgrown property or a cleanup needed before an event or listing
- Time-sensitive seasonal work

### Routine (book the estimate or service)
- Recurring mowing and maintenance
- Design, installation, and hardscaping projects
- Mulch, irrigation, and general questions

## What to Expect
1. The team looks at the property and discusses what you want done
2. They provide a free estimate and, for recurring work, a service plan
3. With your approval, they schedule the service
4. The crew completes the work
5. Your yard looks and stays great

## Terminology
- **Hardscape**: the non-living features, patios, walkways, walls, edging
- **Softscape**: the living elements, grass, plants, trees, shrubs
- **Aeration**: pulling small plugs from the lawn so air, water, and nutrients reach the roots
- **Overseeding**: spreading grass seed over an existing lawn to thicken it
- **Mulch**: material spread over beds to retain moisture and suppress weeds
- **Sod**: pre-grown grass laid down for an instant lawn
- **Irrigation / sprinkler zones**: sections of a yard watered by a controlled system
- **Retaining wall**: a wall that holds back soil and manages grade
- **Grading**: shaping the ground for drainage and a level surface
- **Perennial / annual**: plants that return each year versus those that last one season`,
};

module.exports = { INDUSTRY_KNOWLEDGE_BASES };