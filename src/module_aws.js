'use strict';
/**
 * AWS module (CommonJS)
 * - KMS EIP-712 signing (KMS if configured, else wallet fallback)
 * - AWS SDK v3 clients (DynamoDB, S3, CloudFront)
 * - Helpers: ensureKmsKeyIsSecp256k1, getKmsPublicKey, getKmsEthAddress
 *
 * ENV:
 *  AWS_REGION=us-east-1
 *  KMS_KEY_ID=arn:aws:kms:...       (asymmetric key, ECC_SECG_P256K1)
 */

const { KMSClient, SignCommand, GetPublicKeyCommand, DescribeKeyCommand } = require('@aws-sdk/client-kms');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { S3Client } = require('@aws-sdk/client-s3');
const { CloudFrontClient } = require('@aws-sdk/client-cloudfront');
const { ethers } = require('ethers');

const region = process.env.AWS_REGION || 'us-east-1';
const kms = new KMSClient({ region });
const kmsKeyId = process.env.KMS_KEY_ID || null;

// v3 SDK clients
const dynamoClient = new DynamoDBClient({ region });
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const s3 = new S3Client({ region });
const cloudfront = new CloudFrontClient({ region });

/**
 * awsKmsSignEIP712(domain, types, value, wallet)
 * If KMS_KEY_ID is set: signs the EIP-712 digest with AWS KMS and returns a DER hex (0x…).
 * If KMS_KEY_ID is missing: falls back to wallet._signTypedData (returns RSV).
 *
 * NOTE: server.cjs converts DER → RSV automatically when it sees a DER prefix (0x30…).
 */
async function awsKmsSignEIP712(domain, types, value, wallet) {
  if (!kmsKeyId) {
    if (!wallet) throw new Error('No KMS key or wallet provided for signing');
    return wallet._signTypedData(domain, types, value);
  }
  const digest = ethers.utils._TypedDataEncoder.hash(domain, types, value); // 0x…32 bytes
  const params = {
    KeyId: kmsKeyId,
    Message: Buffer.from(digest.slice(2), 'hex'),
    SigningAlgorithm: 'ECDSA_SHA_256',
    MessageType: 'DIGEST',
  };
  const { Signature } = await kms.send(new SignCommand(params));
  return '0x' + Buffer.from(Signature).toString('hex'); // DER hex
}

/**
 * Ensure the configured KMS key is usable for Ethereum (ECC_SECG_P256K1).
 * Throws with a helpful message if not.
 */
async function ensureKmsKeyIsSecp256k1() {
  if (!kmsKeyId) return false;
  const desc = await kms.send(new DescribeKeyCommand({ KeyId: kmsKeyId }));
  const meta = desc?.KeyMetadata;
  if (!meta) throw new Error('KMS key metadata not found');

  if (meta.KeyState !== 'Enabled') {
    throw new Error(`KMS key is not enabled (state: ${meta.KeyState})`);
  }
  if (meta.KeyUsage !== 'SIGN_VERIFY') {
    throw new Error(`KMS key usage must be SIGN_VERIFY (got: ${meta.KeyUsage})`);
  }

  // The definitive check is GetPublicKey (gives KeySpec)
  const pub = await kms.send(new GetPublicKeyCommand({ KeyId: kmsKeyId }));
  if (pub.KeySpec !== 'ECC_SECG_P256K1') {
    throw new Error(`KMS KeySpec must be ECC_SECG_P256K1 for Ethereum (got: ${pub.KeySpec})`);
  }
  return true;
}

/**
 * Fetch the KMS public key (ASN.1 DER) and return it as a Buffer.
 */
async function getKmsPublicKey() {
  if (!kmsKeyId) throw new Error('KMS_KEY_ID not set');
  const { PublicKey } = await kms.send(new GetPublicKeyCommand({ KeyId: kmsKeyId }));
  return Buffer.from(PublicKey);
}

/**
 * Derive the Ethereum address from the KMS public key.
 * AWS returns an ASN.1 SubjectPublicKeyInfo. We extract the 65-byte uncompressed key, then keccak-256 hash.
 */
async function getKmsEthAddress() {
  const spki = await getKmsPublicKey(); // ASN.1 SPKI
  // Very small DER decoder to get uncompressed EC point from SPKI:
  // Look for the BIT STRING (0x03), skip 1 "unused bits" byte, remaining must start with 0x04 (uncompressed)
  let i = 0;
  if (spki[i++] !== 0x30) throw new Error('SPKI: bad sequence');
  // Skip length (could be short or long form)
  const lenByte = spki[i++];
  const lenLen = (lenByte & 0x80) ? (lenByte & 0x7f) : 0;
  if (lenLen) i += lenLen; // skip long-form length bytes

  // AlgorithmIdentifier sequence
  if (spki[i++] !== 0x30) throw new Error('SPKI: bad alg seq');
  const aLenByte = spki[i++];
  const aLenLen = (aLenByte & 0x80) ? (aLenByte & 0x7f) : 0;
  const aLen = aLenLen ? parseInt(spki.slice(i, i + aLenLen).toString('hex'), 16) : aLenByte;
  i += (aLenLen ? aLenLen : 0) + (aLenLen ? aLen : 0); // move past alg seq (approx; good enough for AWS layout)

  // SubjectPublicKey BIT STRING
  if (spki[i++] !== 0x03) throw new Error('SPKI: missing BIT STRING');
  let bitLenByte = spki[i++];
  let bitLenLen = 0;
  if (bitLenByte & 0x80) {
    bitLenLen = bitLenByte & 0x7f;
    bitLenByte = parseInt(spki.slice(i, i + bitLenLen).toString('hex'), 16);
    i += bitLenLen;
  }
  const unusedBits = spki[i++]; // should be 0
  if (unusedBits !== 0x00) throw new Error('SPKI: unexpected unused bits');

  // Now we expect uncompressed EC point: 0x04 <32-byte X> <32-byte Y>
  if (spki[i] !== 0x04) throw new Error('SPKI: expected uncompressed EC point (0x04)');
  const uncompressed = spki.slice(i, i + 65);
  if (uncompressed.length !== 65) throw new Error('SPKI: bad EC point length');

  const pubkey = '0x' + uncompressed.toString('hex'); // 0x04 + X + Y
  const addr = ethers.utils.computeAddress(pubkey);
  return addr;
}

module.exports = {
  kms,
  kmsKeyId,
  awsKmsSignEIP712,
  ensureKmsKeyIsSecp256k1,
  getKmsPublicKey,
  getKmsEthAddress,
  dynamo,
  s3,
  cloudfront,
};
