// Derive an IANA timezone from a US phone number's area code, used to default
// a new client's business-hours timezone. States spanning zones use their
// majority zone; a handful of split area codes are approximate. Unknown or
// non-US numbers return null so the caller can leave it unset.

const ZONE_AREA_CODES = {
  'America/Los_Angeles': [
    // CA
    '209','213','279','310','323','341','350','408','415','424','442','510','530',
    '559','562','619','626','628','650','657','661','669','707','714','747','760',
    '805','818','820','831','858','909','916','925','949','951',
    // WA
    '206','253','360','425','509','564',
    // OR
    '458','503','541','971',
    // NV
    '702','725','775',
  ],
  'America/Denver': [
    '303','719','720','970',            // CO
    '505','575',                        // NM
    '385','435','801',                  // UT
    '307',                              // WY
    '406',                              // MT
    '208','986',                        // ID
    '915',                              // El Paso, TX (Mountain)
  ],
  'America/Phoenix': [                  // AZ, no DST
    '480','520','602','623','928',
  ],
  'America/Chicago': [
    // TX
    '210','214','254','281','346','361','409','430','432','469','512','682','713',
    '726','737','806','817','830','832','903','936','940','945','956','972','979',
    // IL
    '217','224','309','312','331','447','464','618','630','708','730','773','779',
    '815','847','872',
    // MN
    '218','320','507','612','651','763','952',
    // WI
    '262','274','414','534','608','715','920',
    // IA
    '319','515','563','641','712',
    // MO
    '314','417','573','636','660','816','975',
    // AR
    '479','501','870',
    // LA
    '225','318','337','504','985',
    // MS
    '228','601','662','769',
    // OK
    '405','539','580','918',
    // KS
    '316','620','785','913',
    // NE
    '308','402','531',
    // ND / SD
    '701','605',
    // AL
    '205','251','256','334','659','938',
    // TN (central/west)
    '615','629','731','901','931',
    // KY (central/west)
    '270','364',
  ],
  'America/New_York': [
    // NY
    '212','315','332','347','363','516','518','585','607','631','646','680','716',
    '718','838','845','914','917','929','934',
    // NJ
    '201','551','609','640','732','848','856','862','908','973',
    // PA
    '215','223','267','272','412','445','484','570','582','610','717','724','814',
    '835','878',
    // CT
    '203','475','860','959',
    // MA
    '339','351','413','508','617','774','781','857','978',
    // RI / VT / NH / ME
    '401','802','603','207',
    // DE / MD / DC
    '302','240','301','410','443','667','202',
    // VA / WV
    '276','434','540','571','703','757','804','304','681',
    // NC
    '252','336','704','743','828','910','919','980','984',
    // SC
    '803','839','843','854','864',
    // GA
    '229','404','470','478','678','706','762','770','912','943',
    // FL
    '239','305','321','352','386','407','448','561','656','689','727','754','772',
    '786','813','850','863','904','941','954',
    // OH
    '216','220','234','326','330','380','419','440','513','567','614','740','937',
    // MI
    '231','248','269','313','517','586','616','679','734','810','906','947','989',
    // IN
    '219','260','317','463','574','765','812','930',
    // KY (east) / TN (east)
    '502','606','859','423','865',
  ],
  'America/Anchorage': ['907'],
  'Pacific/Honolulu': ['808'],
};

const AREA_CODE_TO_TZ = {};
for (const [tz, codes] of Object.entries(ZONE_AREA_CODES)) {
  for (const code of codes) AREA_CODE_TO_TZ[code] = tz;
}

function areaCodeFromPhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const d = phone.replace(/\D/g, '');
  if (d.length === 10) return d.slice(0, 3);
  if (d.length === 11 && d[0] === '1') return d.slice(1, 4);
  if (d.length > 11 && d[0] === '1') return d.slice(1, 4);
  return null;
}

// Returns an IANA timezone for the phone's area code, or null if the number
// isn't a parseable US number or the area code isn't mapped.
function timezoneFromPhone(phone) {
  const ac = areaCodeFromPhone(phone);
  if (!ac) return null;
  return AREA_CODE_TO_TZ[ac] || null;
}

module.exports = { timezoneFromPhone, areaCodeFromPhone, AREA_CODE_TO_TZ };