// ============================================================================
// US AREA CODE → LOCATION MAP
// Shared module for phone location lookups across the backend.
//
// Usage:
//   const { formatPhone, getPhoneLocation } = require('../lib/area-codes');
//   formatPhone('+15551234567')       → '(555) 123-4567'
//   getPhoneLocation('+15551234567')  → 'Some City, ST' or null
//
// CREATED: 2026-05-09
// ============================================================================

const US_AREA_CODES = {
  '201':'Jersey City, NJ','202':'Washington, DC','203':'Connecticut','205':'Birmingham, AL','206':'Seattle, WA','207':'Maine','208':'Idaho','209':'Stockton, CA','210':'San Antonio, TX','212':'New York, NY','213':'Los Angeles, CA','214':'Dallas, TX','215':'Philadelphia, PA','216':'Cleveland, OH','217':'Springfield, IL','218':'Duluth, MN','219':'Gary, IN','224':'Chicago Suburbs, IL','225':'Baton Rouge, LA','228':'Gulfport, MS','229':'Albany, GA','231':'Muskegon, MI','234':'Akron, OH','239':'Fort Myers, FL','240':'Maryland','248':'Troy, MI','251':'Mobile, AL','252':'Rocky Mount, NC','253':'Tacoma, WA','254':'Killeen, TX','256':'Huntsville, AL','260':'Fort Wayne, IN','262':'Kenosha, WI','267':'Philadelphia, PA','269':'Kalamazoo, MI','270':'Bowling Green, KY','276':'Bristol, VA','279':'Sacramento, CA','281':'Houston, TX',
  '301':'Maryland','302':'Delaware','303':'Denver, CO','304':'West Virginia','305':'Miami, FL','307':'Wyoming','308':'Grand Island, NE','309':'Peoria, IL','310':'Los Angeles, CA','312':'Chicago, IL','313':'Detroit, MI','314':'St. Louis, MO','315':'Syracuse, NY','316':'Wichita, KS','317':'Indianapolis, IN','318':'Shreveport, LA','319':'Cedar Rapids, IA','320':'St. Cloud, MN','321':'Orlando, FL','323':'Los Angeles, CA','325':'Abilene, TX','330':'Akron, OH','331':'Aurora, IL','332':'New York, NY','334':'Montgomery, AL','336':'Greensboro, NC','337':'Lafayette, LA','339':'Massachusetts','340':'US Virgin Islands','346':'Houston, TX','347':'New York, NY','351':'Massachusetts','352':'Gainesville, FL','360':'Vancouver, WA','361':'Corpus Christi, TX','385':'Salt Lake City, UT','386':'Daytona Beach, FL',
  '401':'Rhode Island','402':'Omaha, NE','404':'Atlanta, GA','405':'Oklahoma City, OK','406':'Montana','407':'Orlando, FL','408':'San Jose, CA','409':'Beaumont, TX','410':'Baltimore, MD','412':'Pittsburgh, PA','413':'Springfield, MA','414':'Milwaukee, WI','415':'San Francisco, CA','417':'Springfield, MO','419':'Toledo, OH','423':'Chattanooga, TN','424':'Los Angeles, CA','425':'Bellevue, WA','430':'Tyler, TX','432':'Midland, TX','434':'Lynchburg, VA','435':'Utah','440':'Cleveland Suburbs, OH','442':'Oceanside, CA','443':'Baltimore, MD','458':'Eugene, OR','463':'Indianapolis, IN','469':'Dallas, TX','470':'Atlanta, GA','475':'Connecticut','478':'Macon, GA','479':'Fort Smith, AR','480':'Mesa, AZ','484':'Pennsylvania',
  '501':'Little Rock, AR','502':'Louisville, KY','503':'Portland, OR','504':'New Orleans, LA','505':'Albuquerque, NM','507':'Rochester, MN','508':'Worcester, MA','509':'Spokane, WA','510':'Oakland, CA','512':'Austin, TX','513':'Cincinnati, OH','515':'Des Moines, IA','516':'Hempstead, NY','517':'Lansing, MI','518':'Albany, NY','520':'Tucson, AZ','530':'Redding, CA','531':'Omaha, NE','539':'Tulsa, OK','540':'Roanoke, VA','541':'Eugene, OR','551':'Jersey City, NJ','559':'Fresno, CA','561':'West Palm Beach, FL','562':'Long Beach, CA','563':'Dubuque, IA','567':'Toledo, OH','570':'Scranton, PA','571':'Virginia','573':'Jefferson City, MO','574':'South Bend, IN','575':'Las Cruces, NM','580':'Ponca City, OK','585':'Rochester, NY','586':'Warren, MI',
  '601':'Jackson, MS','602':'Phoenix, AZ','603':'New Hampshire','605':'South Dakota','606':'Ashland, KY','607':'Binghamton, NY','608':'Madison, WI','609':'Trenton, NJ','610':'Pennsylvania','612':'Minneapolis, MN','614':'Columbus, OH','615':'Nashville, TN','616':'Grand Rapids, MI','617':'Boston, MA','618':'Belleville, IL','619':'San Diego, CA','620':'Hutchinson, KS','623':'Phoenix, AZ','626':'Pasadena, CA','628':'San Francisco, CA','629':'Nashville, TN','630':'Aurora, IL','631':'Islip, NY','636':'O\'Fallon, MO','641':'Mason City, IA','646':'New York, NY','650':'San Mateo, CA','651':'St. Paul, MN','657':'Anaheim, CA','660':'Sedalia, MO','661':'Bakersfield, CA','662':'Southaven, MS','667':'Baltimore, MD','669':'San Jose, CA','678':'Atlanta, GA','681':'West Virginia','682':'Fort Worth, TX','689':'Orlando, FL',
  '701':'North Dakota','702':'Las Vegas, NV','703':'Virginia','704':'Charlotte, NC','706':'Augusta, GA','707':'Santa Rosa, CA','708':'Chicago Suburbs, IL','712':'Sioux City, IA','713':'Houston, TX','714':'Anaheim, CA','715':'Eau Claire, WI','716':'Buffalo, NY','717':'Harrisburg, PA','718':'New York, NY','719':'Colorado Springs, CO','720':'Denver, CO','724':'Pennsylvania','725':'Las Vegas, NV','726':'San Antonio, TX','727':'St. Petersburg, FL','731':'Jackson, TN','732':'New Brunswick, NJ','734':'Ann Arbor, MI','737':'Austin, TX','740':'Newark, OH','747':'Los Angeles, CA','754':'Fort Lauderdale, FL','757':'Virginia Beach, VA','760':'Oceanside, CA','763':'Minneapolis Suburbs, MN','765':'Muncie, IN','769':'Jackson, MS','770':'Atlanta Suburbs, GA','772':'Port St. Lucie, FL','773':'Chicago, IL','774':'Massachusetts','775':'Reno, NV','779':'Rockford, IL','781':'Massachusetts','785':'Topeka, KS','786':'Miami, FL',
  '801':'Salt Lake City, UT','802':'Vermont','803':'Columbia, SC','804':'Richmond, VA','805':'Santa Barbara, CA','806':'Lubbock, TX','808':'Hawaii','810':'Flint, MI','812':'Evansville, IN','813':'Tampa, FL','814':'Erie, PA','815':'Rockford, IL','816':'Kansas City, MO','817':'Fort Worth, TX','818':'Burbank, CA','828':'Asheville, NC','830':'New Braunfels, TX','831':'Salinas, CA','832':'Houston, TX','843':'Charleston, SC','845':'Poughkeepsie, NY','847':'Chicago Suburbs, IL','848':'New Jersey','850':'Tallahassee, FL','856':'Camden, NJ','857':'Boston, MA','858':'San Diego, CA','859':'Lexington, KY','860':'Connecticut','862':'Newark, NJ','863':'Lakeland, FL','864':'Greenville, SC','865':'Knoxville, TN','870':'Jonesboro, AR','872':'Chicago, IL','878':'Pittsburgh, PA',
  '901':'Memphis, TN','903':'Tyler, TX','904':'Jacksonville, FL','906':'Upper Peninsula, MI','907':'Alaska','908':'Elizabeth, NJ','909':'San Bernardino, CA','910':'Fayetteville, NC','912':'Savannah, GA','913':'Kansas City, KS','914':'Westchester, NY','915':'El Paso, TX','916':'Sacramento, CA','917':'New York, NY','918':'Tulsa, OK','919':'Raleigh, NC','920':'Green Bay, WI','925':'Concord, CA','928':'Yuma, AZ','929':'New York, NY','931':'Clarksville, TN','936':'Conroe, TX','937':'Dayton, OH','940':'Denton, TX','941':'Sarasota, FL','949':'Irvine, CA','951':'Riverside, CA','952':'Minneapolis Suburbs, MN','954':'Fort Lauderdale, FL','956':'Laredo, TX','970':'Fort Collins, CO','971':'Portland, OR','972':'Dallas, TX','973':'Newark, NJ','978':'Massachusetts','979':'College Station, TX','980':'Charlotte, NC','984':'Raleigh, NC','985':'Houma, LA','989':'Saginaw, MI',
};

/**
 * Format a phone number for display.
 * US/CA: (XXX) XXX-XXXX
 * International: +CC XXX XXX XXXX
 */
function formatPhone(phone) {
  if (!phone) return '—';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
  if (digits.length > 10) return `+${digits.slice(0, digits.length - 10)} ${digits.slice(-10, -7)} ${digits.slice(-7, -4)} ${digits.slice(-4)}`;
  return phone;
}

/**
 * Get a location string from a phone number's area code.
 * Returns 'City, ST' for US numbers, null otherwise.
 */
function getPhoneLocation(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  let areaCode = '';
  if (digits.length === 10) areaCode = digits.slice(0, 3);
  else if (digits.length === 11 && digits.startsWith('1')) areaCode = digits.slice(1, 4);
  return US_AREA_CODES[areaCode] || null;
}

/**
 * Format duration in seconds to human-readable string.
 * 45 → '45s', 90 → '1m 30s', 120 → '2m'
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return 'Unknown';
  seconds = Math.round(seconds);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}

module.exports = { US_AREA_CODES, formatPhone, getPhoneLocation, formatDuration };
