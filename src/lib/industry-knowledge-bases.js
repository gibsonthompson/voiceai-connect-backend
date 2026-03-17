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

};

module.exports = { INDUSTRY_KNOWLEDGE_BASES };