import crypto from 'crypto';
import { env } from '../config/env';

// Load and parse the 32-byte (64-character) hex encryption key
const ENCRYPTION_KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');
const IV_LENGTH = 12; // 12-byte (96-bit) Initialization Vector (IV) is standard for AES-GCM
const TAG_LENGTH = 16; // 16-byte (128-bit) authentication tag

interface EncryptedData {
  encrypted: string; // Base64 encoded ciphertext + auth tag
  iv: string;        // Hex encoded initialization vector
}

/**
 * Encrypts plaintext using AES-256-GCM authenticated encryption.
 * Combines the ciphertext and the authentication tag into the returned "encrypted" string.
 *
 * @param plaintext The sensitive string to encrypt
 * @returns EncryptedData containing base64 ciphertext and hex IV
 */
export function encrypt(plaintext: string): EncryptedData {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  
  const tag = cipher.getAuthTag();
  
  return {
    // Append the 16-byte authentication tag to the ciphertext for storage
    encrypted: Buffer.concat([encrypted, tag]).toString('base64'),
    iv: iv.toString('hex')
  };
}

/**
 * Decrypts a base64 encoded ciphertext (including auth tag) using the provided hex IV.
 * Verifies authenticity before returning decrypted plaintext.
 *
 * @param encrypted Base64 encoded string containing ciphertext + 16-byte auth tag
 * @param iv Hex encoded initialization vector
 * @returns Decrypted plaintext string
 */
export function decrypt(encrypted: string, iv: string): string {
  const data = Buffer.from(encrypted, 'base64');
  
  // Extract the auth tag from the end of the buffer
  const tag = data.subarray(data.length - TAG_LENGTH);
  // Extract the actual ciphertext
  const ciphertext = data.subarray(0, data.length - TAG_LENGTH);
  
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    ENCRYPTION_KEY,
    Buffer.from(iv, 'hex')
  );
  
  decipher.setAuthTag(tag);
  
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
  
  return decrypted.toString('utf8');
}
