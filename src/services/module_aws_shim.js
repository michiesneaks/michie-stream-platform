'use strict';

/**
 * Shim so ethService.js can import this without knowing the relative path
 * to the real module_aws.js which sits at the project root.
 *
 * In production: place module_aws.js at src/services/module_aws.js
 * or update this path to wherever module_aws.js lives.
 */
let awsKmsSignEIP712;
try {
  ({ awsKmsSignEIP712 } = require('../../module_aws'));
} catch {
  // Fallback no-op — AWS KMS signing is optional
  awsKmsSignEIP712 = async (domain, types, value, wallet) => {
    if (wallet && wallet._signTypedData) {
      return wallet._signTypedData(domain, types, value);
    }
    return '0x';
  };
}

module.exports = { awsKmsSignEIP712 };
