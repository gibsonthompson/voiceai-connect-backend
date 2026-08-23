// ============================================================================
// SHARED ADMIN FORMATTERS
// Lifted out of the individual admin pages so phone, date, duration, and
// currency formatting are defined once and stay consistent everywhere.
// Import from '@/lib/admin/format'.
// ============================================================================

// US area code to city/state, used to show caller and agency location without
// storing it. Keyed by the 3-digit area code.
export const US_AREA_CODES: Record<string, string> = {
  '201':'Jersey City, NJ','202':'Washington, DC','205':'Birmingham, AL','206':'Seattle, WA','210':'San Antonio, TX','212':'New York, NY','213':'Los Angeles, CA','214':'Dallas, TX','215':'Philadelphia, PA','216':'Cleveland, OH','224':'Chicago Suburbs, IL','225':'Baton Rouge, LA','234':'Akron, OH','239':'Fort Myers, FL','248':'Troy, MI','251':'Mobile, AL','253':'Tacoma, WA','254':'Killeen, TX','256':'Huntsville, AL','267':'Philadelphia, PA','281':'Houston, TX','301':'Maryland','303':'Denver, CO','305':'Miami, FL','310':'Los Angeles, CA','312':'Chicago, IL','313':'Detroit, MI','314':'St. Louis, MO','315':'Syracuse, NY','317':'Indianapolis, IN','321':'Orlando, FL','323':'Los Angeles, CA','330':'Akron, OH','334':'Montgomery, AL','336':'Greensboro, NC','346':'Houston, TX','347':'New York, NY','352':'Gainesville, FL','385':'Salt Lake City, UT','401':'Rhode Island','402':'Omaha, NE','404':'Atlanta, GA','405':'Oklahoma City, OK','407':'Orlando, FL','408':'San Jose, CA','410':'Baltimore, MD','412':'Pittsburgh, PA','414':'Milwaukee, WI','415':'San Francisco, CA','423':'Chattanooga, TN','424':'Los Angeles, CA','425':'Bellevue, WA','469':'Dallas, TX','470':'Atlanta, GA','478':'Macon, GA','480':'Mesa, AZ','501':'Little Rock, AR','502':'Louisville, KY','503':'Portland, OR','504':'New Orleans, LA','505':'Albuquerque, NM','508':'Worcester, MA','510':'Oakland, CA','512':'Austin, TX','513':'Cincinnati, OH','515':'Des Moines, IA','516':'Hempstead, NY','518':'Albany, NY','520':'Tucson, AZ','530':'Redding, CA','540':'Roanoke, VA','551':'Jersey City, NJ','559':'Fresno, CA','561':'West Palm Beach, FL','562':'Long Beach, CA','571':'Virginia','585':'Rochester, NY','586':'Warren, MI','601':'Jackson, MS','602':'Phoenix, AZ','612':'Minneapolis, MN','614':'Columbus, OH','615':'Nashville, TN','616':'Grand Rapids, MI','617':'Boston, MA','619':'San Diego, CA','623':'Phoenix, AZ','626':'Pasadena, CA','628':'San Francisco, CA','629':'Nashville, TN','646':'New York, NY','650':'San Mateo, CA','651':'St. Paul, MN','657':'Anaheim, CA','661':'Bakersfield, CA','669':'San Jose, CA','678':'Atlanta, GA','682':'Fort Worth, TX','702':'Las Vegas, NV','703':'Virginia','704':'Charlotte, NC','706':'Augusta, GA','708':'Chicago Suburbs, IL','713':'Houston, TX','714':'Anaheim, CA','716':'Buffalo, NY','717':'Harrisburg, PA','718':'New York, NY','719':'Colorado Springs, CO','720':'Denver, CO','725':'Las Vegas, NV','727':'St. Petersburg, FL','732':'New Brunswick, NJ','734':'Ann Arbor, MI','737':'Austin, TX','747':'Los Angeles, CA','754':'Fort Lauderdale, FL','757':'Virginia Beach, VA','760':'Oceanside, CA','770':'Atlanta Suburbs, GA','773':'Chicago, IL','775':'Reno, NV','786':'Miami, FL','801':'Salt Lake City, UT','803':'Columbia, SC','804':'Richmond, VA','805':'Santa Barbara, CA','808':'Hawaii','813':'Tampa, FL','816':'Kansas City, MO','817':'Fort Worth, TX','818':'Burbank, CA','828':'Asheville, NC','832':'Houston, TX','843':'Charleston, SC','847':'Chicago Suburbs, IL','850':'Tallahassee, FL','857':'Boston, MA','858':'San Diego, CA','859':'Lexington, KY','862':'Newark, NJ','863':'Lakeland, FL','864':'Greenville, SC','865':'Knoxville, TN','872':'Chicago, IL','901':'Memphis, TN','903':'Tyler, TX','904':'Jacksonville, FL','907':'Alaska','909':'San Bernardino, CA','910':'Fayetteville, NC','912':'Savannah, GA','913':'Kansas City, KS','914':'Westchester, NY','915':'El Paso, TX','916':'Sacramento, CA','917':'New York, NY','918':'Tulsa, OK','919':'Raleigh, NC','925':'Concord, CA','929':'New York, NY','936':'Conroe, TX','937':'Dayton, OH','941':'Sarasota, FL','949':'Irvine, CA','951':'Riverside, CA','954':'Fort Lauderdale, FL','970':'Fort Collins, CO','971':'Portland, OR','972':'Dallas, TX','973':'Newark, NJ','980':'Charlotte, NC','984':'Raleigh, NC',
};

const EMPTY = '\u2013'; // en dash placeholder for empty values (not an em dash)

// Format a raw phone string into a readable US or international number.
export function formatPhone(phone?: string | null): string {
  if (!phone) return EMPTY;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  if (digits.length > 11) return `+${digits.slice(0, digits.length - 10)} ${digits.slice(-10, -7)} ${digits.slice(-7, -4)} ${digits.slice(-4)}`;
  return phone;
}

// Resolve an approximate location from a US area code, falling back to the
// agency country if no area code match is found.
export function getPhoneLocation(phone?: string | null, countryCode?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  let areaCode = '';
  if (digits.length === 10) areaCode = digits.slice(0, 3);
  else if (digits.length === 11 && digits.startsWith('1')) areaCode = digits.slice(1, 4);
  if (areaCode) {
    // Show the city/state for the area code, with the area code itself in
    // parens so the signup's area code is always visible. Unmapped US codes
    // still surface the number so it is never hidden.
    const place = US_AREA_CODES[areaCode];
    return place ? `${place} (${areaCode})` : `Area code ${areaCode}`;
  }
  if (countryCode) return getCountryName(countryCode);
  return null;
}

// Just the US state (2-letter, or full name for state-only entries) for a
// phone's area code, or null. Handy when a surface wants the state on its own.
export function getPhoneState(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  let areaCode = '';
  if (digits.length === 10) areaCode = digits.slice(0, 3);
  else if (digits.length === 11 && digits.startsWith('1')) areaCode = digits.slice(1, 4);
  const place = areaCode ? US_AREA_CODES[areaCode] : '';
  if (!place) return null;
  const comma = place.lastIndexOf(', ');
  return comma >= 0 ? place.slice(comma + 2) : place;
}

// The 3-digit US area code for a phone, or null.
export function getAreaCode(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return digits.slice(0, 3);
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1, 4);
  return null;
}

export function getCountryName(code?: string | null): string {
  if (!code) return EMPTY;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
}

export function formatDate(date?: string | null): string {
  if (!date) return EMPTY;
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(date?: string | null): string {
  if (!date) return EMPTY;
  return new Date(date).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// Short relative time, e.g. "just now", "5m ago", "3h ago", "2d ago".
export function timeAgo(date?: string | null): string {
  if (!date) return EMPTY;
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return formatDate(date);
}

// Whole-second duration to m:ss (e.g. 252 to "4:12").
export function formatDuration(seconds?: number | null): string {
  if (seconds == null || Number.isNaN(Number(seconds))) return EMPTY;
  const s = Math.round(Number(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? '0' : ''}${rem}`;
}

// Money stored as integer cents (payments, plan prices).
export function formatCurrencyCents(cents?: number | null): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 0,
  }).format((cents || 0) / 100);
}

// Money already in dollars (VAPI reported cost, margin figures).
export function formatUSD(dollars?: number | null, fractionDigits = 2): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: fractionDigits,
  }).format(dollars || 0);
}

// Whole-number formatting with thousands separators.
export function formatNumber(n?: number | null): string {
  return (n || 0).toLocaleString('en-US');
}