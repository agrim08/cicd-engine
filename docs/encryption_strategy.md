# Encryption Strategy & Webhook Verification

Detailed analysis and documentation of the cryptographic security strategies implemented in the GitHub Actions Clone.

---

## 🔒 Part 1: Encryption & Decryption (`crypto.ts`)

In simple terms, encryption is the process of scrambling readable text (**plaintext**) into unreadable gibberish (**ciphertext**) so that it can be stored securely in the database. Decryption is the process of reversing it.

We use **AES-256-GCM**, which is the industry standard for symmetric-key authenticated encryption.

### Key Terms
*   **Symmetric Encryption (The Lock & Key):** The same password (our `ENCRYPTION_KEY` in `.env`) is used to both lock (encrypt) and unlock (decrypt) the data. If an attacker gains unauthorized access to the database, they cannot read these secrets without this key.
*   **Initialization Vector (IV) — The Salt:** If the same plaintext (e.g., `"password123"`) is encrypted multiple times with the same key, it would normally produce the exact same ciphertext. Attackers could identify repeating patterns. To prevent this, we generate a random 12-byte number (IV) for every single encryption. Mixing this random value into the key ensures that identical inputs result in unique outputs. The IV is stored as public metadata next to the encrypted text.
*   **GCM (Galois/Counter Mode) — The Security Seal:** GCM is an *authenticated* encryption mode. Along with the ciphertext, it generates a 16-byte **Authentication Tag** (acting as a tamper-evident seal). During decryption, the system verifies this tag first. If a database record has been tampered with or modified, decryption fails immediately, throwing an error instead of returning corrupted data.

---

### Step-by-Step Code Walkthrough

#### 1. The `encrypt` Function
This function encrypts raw string values and returns the Base64-encoded encrypted string (including the Auth Tag) and a Hex-encoded IV.

```typescript
export function encrypt(plaintext: string): EncryptedData {
  // 1. Generate a random 12-byte IV (guarantees uniqueness for every run)
  const iv = crypto.randomBytes(IV_LENGTH);

  // 2. Prepare the AES-256-GCM cipher using our master key and the generated IV
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  
  // 3. Encrypt the plaintext string
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  
  // 4. Retrieve the 16-byte authentication tag (tamper-proof seal)
  const tag = cipher.getAuthTag();
  
  return {
    // Append the authentication tag onto the end of the encrypted text
    // and encode it into a Base64 string for easy storage in PostgreSQL
    encrypted: Buffer.concat([encrypted, tag]).toString('base64'),
    iv: iv.toString('hex') // Store the IV as a hex string
  };
}
```

#### 2. The `decrypt` Function
This function takes the Base64-encoded payload (ciphertext + tag) and the Hex-encoded IV, verifies the integrity tag, and returns the original plaintext.

```typescript
export function decrypt(encrypted: string, iv: string): string {
  // 1. Convert the Base64 storage string back into a raw byte buffer
  const data = Buffer.from(encrypted, 'base64');
  
  // 2. Extract the last 16 bytes representing the Auth Tag
  const tag = data.subarray(data.length - TAG_LENGTH);
  
  // 3. Extract the remaining ciphertext (the locked data)
  const ciphertext = data.subarray(0, data.length - TAG_LENGTH);
  
  // 4. Prepare the decipher using the master key and the Hex IV
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    ENCRYPTION_KEY,
    Buffer.from(iv, 'hex')
  );
  
  // 5. Attach the Auth Tag to verify authenticity and prevent tampering
  decipher.setAuthTag(tag);
  
  // 6. Decrypt the ciphertext (throws an error if the tag is invalid)
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
  
  return decrypted.toString('utf8');
}
```

---

## 📡 Part 2: HMAC Webhook Signature Verification (`webhook.ts`)

A webhook is an Express HTTP endpoint (`POST /webhook/github`) that GitHub triggers to notify our system about events like code pushes.

### The Security Threat
Since our webhook endpoint is exposed to the public internet, anyone could send spoofed HTTP requests to trigger pipelines, executing malicious code or exhausting system resources.

### The Solution: HMAC Digital Signatures
To verify that requests originate strictly from GitHub, we implement **HMAC-SHA256** (Hash-based Message Authentication Code) signatures.

1.  **Registration:** During repository registration, our server generates a cryptographically secure random `webhook_secret` which the user configures in their GitHub repository settings.
2.  **Signature Generation:** On event dispatch, GitHub takes the **raw body** of the request and hashes it using the `webhook_secret` as the key. The result is sent in the `X-Hub-Signature-256` header (prefixed with `sha256=`).
3.  **Validation:** Upon receiving the request, our server performs the same calculation:
    -   We retrieve the raw body and compile the expected signature using the repository's registered `webhook_secret`.
    -   We compare our computed signature against the signature header sent by GitHub.
    -   A successful match guarantees that the request was sent by GitHub (holder of the secret) and that the payload has not been modified in transit.

---

### Critical Implementation Details

#### 1. Raw Body Processing (`Buffer`)
Standard body parsers convert incoming JSON strings directly into JavaScript objects. However, JSON parsing can normalize spaces, keys, or array structures, resulting in different byte representation. Because a hash depends on the exact bytes transmitted, we must parse the request body as a **raw Buffer** using:
```typescript
app.use('/webhook', express.raw({ type: 'application/json' }));
```

#### 2. Timing Attack Prevention (`crypto.timingSafeEqual`)
Standard equality comparisons (e.g., `expected === signature`) terminate early upon finding the first mismatched character. Attackers can measure the timing differences of the response at a nanosecond level to guess the correct signature string character-by-character.

To prevent this, `crypto.timingSafeEqual` performs a bitwise comparison that runs in **constant time**, eliminating any side-channel timing leaks.