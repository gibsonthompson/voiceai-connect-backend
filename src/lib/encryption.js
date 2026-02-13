// ============================================================================
// ENCRYPTION - AES-256-GCM for storing third-party API credentials
// ============================================================================
const crypto = require('crypto');

// ENCRYPTION_KEY must be 32 bytes (64 hex chars) set in environment
// Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!ENCRYPTION_KEY) {
  console.warn('⚠️ ENCRYPTION_KEY not set — credential encryption will fail');
}

/**
 * Encrypt a plaintext string using AES-256-GCM
 * Returns a combined string: iv:authTag:ciphertext (all hex-encoded)
 */
function encrypt(plaintext) {
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY environment variable not set');
  if (!plaintext) return null;

  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a string encrypted with encrypt()
 * Expects format: iv:authTag:ciphertext (all hex-encoded)
 */
function decrypt(encryptedString) {
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY environment variable not set');
  if (!encryptedString) return null;

  const parts = encryptedString.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');

  const [ivHex, authTagHex, ciphertext] = parts;
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

module.exports = { encrypt, decrypt };