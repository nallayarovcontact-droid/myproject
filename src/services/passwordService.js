'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
// OWASP-aligned scrypt parameters (N=2^16, r=8, p=1 ≈ 64 MiB per hash).
const PARAMS = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const KEYLEN = 32;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEYLEN, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Used when the username does not exist, so the response time does not reveal valid usernames.
let dummyHash;
async function getDummyHash() {
  dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

module.exports = { hashPassword, verifyPassword, getDummyHash };
