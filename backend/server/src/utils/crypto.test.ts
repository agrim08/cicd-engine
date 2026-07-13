import { encrypt, decrypt } from './crypto';

function testCrypto() {
  console.log('🧪 Starting AES-256-GCM crypto utility test...');
  
  const originalText = 'my-super-secret-github-token-12345';
  console.log('Original Text:', originalText);
  
  const result1 = encrypt(originalText);
  console.log('Encryption 1 Result:', result1);
  
  const result2 = encrypt(originalText);
  console.log('Encryption 2 Result (should have different IV & ciphertext):', result2);
  
  if (result1.iv === result2.iv) {
    throw new Error('❌ Test Failed: IVs must be unique!');
  }
  
  const decrypted1 = decrypt(result1.encrypted, result1.iv);
  console.log('Decrypted 1 Result:', decrypted1);
  
  if (decrypted1 !== originalText) {
    throw new Error('❌ Test Failed: Decrypted text does not match original!');
  }
  
  const decrypted2 = decrypt(result2.encrypted, result2.iv);
  console.log('Decrypted 2 Result:', decrypted2);
  
  if (decrypted2 !== originalText) {
    throw new Error('❌ Test Failed: Decrypted text does not match original!');
  }
  
  console.log('✅ AES-256-GCM crypto utility test passed successfully!');
}

testCrypto();
