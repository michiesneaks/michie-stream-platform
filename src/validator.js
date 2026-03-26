// server/validator.js (CommonJS)
'use strict';

const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });

// 64 hex chars (32-byte digests)
const HEX64 = '^[0-9a-fA-F]{64}$';

const metadataSchema = {
  type: 'object',
  additionalProperties: true,
  required: [
    'id',
    'title',
    'creator',
    'content_type',
    'availability_type',
    'release_date',
    'tags',
    'integrityHashes'
  ],
  properties: {
    id: { type: 'string' },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    creator: {
      type: 'object',
      additionalProperties: true,
      required: ['name', 'user_id', 'wallet_address'],
      properties: {
        name: { type: 'string', minLength: 1 },
        user_id: { type: 'string', minLength: 1 },
        wallet_address: { type: 'string', minLength: 1 }
      }
    },
    content_type: { type: 'string', enum: ['music', 'art', 'podcast'] },
    availability_type: { type: 'string' },
    release_date: { type: 'string' },
    tags: { type: 'array', minItems: 5, items: { type: 'string', minLength: 1 } },
    mlc_metadata: {
      type: 'object',
      additionalProperties: true,
      properties: {
        work_title: { type: 'string' },
        iswc: { type: 'string' },
        isrc: { type: 'string' },
        ipi_name_number: { type: 'string' },
        writers: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['name'],
            properties: {
              name: { type: 'string', minLength: 1 },
              role: { type: 'string' },
              ipi_name_number: { type: 'string' },
              ownership_percent: { type: ['number', 'integer'], minimum: 0, maximum: 100 }
            }
          }
        },
        publishers: { type: 'array' }
      }
    },
    integrityHashes: {
      type: 'object',
      additionalProperties: true,
      // SHA-256 is always required (BLAKE3 is optional)
      required: ['sha256Audio', 'sha256CoverImage'],
      properties: {
        sha256Audio:      { type: 'string', minLength: 64, maxLength: 64, pattern: HEX64 },
        sha256CoverImage: { type: 'string', minLength: 64, maxLength: 64, pattern: HEX64 },
        sha256Metadata:   { type: 'string', minLength: 64, maxLength: 64, pattern: HEX64 },

        // Optional BLAKE3 digests (same 32-byte hex by default)
        blake3Audio:        { type: 'string', minLength: 64, maxLength: 64, pattern: HEX64 },
        blake3CoverImage:   { type: 'string', minLength: 64, maxLength: 64, pattern: HEX64 },
        blake3Metadata:     { type: 'string', minLength: 64, maxLength: 64, pattern: HEX64 },
      }
    },
    files: { type: 'object', additionalProperties: true },
    ipfs_audio_url: { type: 'string' }
  }
};

const validateCompiled = ajv.compile(metadataSchema);

function validateMetadata(metadata, contentType) {
  validateMetadata.errors = null;
  const ok = validateCompiled(metadata);
  let errors = validateCompiled.errors ? [...validateCompiled.errors] : [];

  if (contentType && metadata && typeof metadata === 'object') {
    if (metadata.content_type && metadata.content_type !== contentType) {
      errors.push({
        instancePath: '/content_type',
        schemaPath: '#/properties/content_type/enum',
        keyword: 'enum',
        params: { allowedValues: ['music', 'art', 'podcast'] },
        message: `content_type must match the provided contentType argument (${contentType})`
      });
    }
  }

  if (!ok || errors.length) {
    validateMetadata.errors = errors;
    return false;
  }
  return true;
}

function validateOwnership(metadata) {
  const writers = metadata?.mlc_metadata?.writers;
  if (Array.isArray(writers) && writers.length) {
    const total = writers.reduce((sum, w) => sum + (Number(w.ownership_percent) || 0), 0);
    const rounded = Math.round(total * 1000) / 1000;
    if (Math.abs(rounded - 100) > 0.001) {
      throw new Error(`Ownership percentages must sum to 100 (got ${rounded}).`);
    }
  }
}

module.exports = { validateMetadata, validateOwnership };
