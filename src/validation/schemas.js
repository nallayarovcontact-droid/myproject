'use strict';
const { HttpError } = require('../lib/http');

// Server-side validation is about data integrity and rejecting garbage early.
// It is NOT the XSS defence — that is output encoding in the browser (textContent) plus the CSP header.

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function str(value, field, { min = 0, max, pattern, multiline = false }) {
  if (typeof value !== 'string') return `${field} must be a string`;
  const v = value.trim();
  if (v.length < min) return min === 1 ? `${field} is required` : `${field} must be at least ${min} characters`;
  if (v.length > max) return `${field} must be at most ${max} characters`;
  if (CONTROL_CHARS.test(v) || (!multiline && /[\r\n]/.test(v))) return `${field} contains invalid characters`;
  if (pattern && !pattern.test(v)) return `${field} has an invalid format`;
  return null;
}

const productFields = {
  sku: (v) => (v === null ? null : str(v, 'sku', { min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ })),
  name: (v) => str(v, 'name', { min: 1, max: 200 }),
  description: (v) => str(v, 'description', { max: 5000, multiline: true }),
  category: (v) => str(v, 'category', { max: 100 }),
  price: (v) =>
    typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1_000_000 || Math.abs(v * 100 - Math.round(v * 100)) > 1e-6
      ? 'price must be a number between 0 and 1,000,000 with at most 2 decimals'
      : null,
  stock: (v) => (Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? null : 'stock must be an integer between 0 and 1,000,000'),
};

/**
 * Validate a product payload. Unknown fields are rejected (prevents mass-assignment of e.g. `id` or `image_id`).
 * @param {object} body
 * @param {{partial: boolean}} opts  partial=true for PATCH
 * @returns normalized object ready for the model
 */
function validateProduct(body, { partial }) {
  const errors = [];
  for (const key of Object.keys(body)) {
    if (!(key in productFields)) errors.push(`unknown field: ${key}`);
  }
  if (!partial) {
    for (const required of ['name', 'price']) {
      if (body[required] === undefined) errors.push(`${required} is required`);
    }
  }
  for (const [key, check] of Object.entries(productFields)) {
    if (body[key] === undefined) continue;
    const err = check(body[key]);
    if (err) errors.push(err);
  }
  if (errors.length) throw new HttpError(400, 'Validation failed', errors);

  const out = {};
  for (const key of ['sku', 'name', 'description', 'category']) {
    if (body[key] !== undefined) out[key] = body[key] === null ? null : body[key].trim();
  }
  if (body.price !== undefined) out.price_cents = Math.round(body.price * 100);
  if (body.stock !== undefined) out.stock = body.stock;
  return out;
}

function validateLogin(body) {
  const errors = [];
  if (typeof body.username !== 'string' || body.username.length < 1 || body.username.length > 64) {
    errors.push('username is required');
  }
  if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 256) {
    errors.push('password is required');
  }
  if (errors.length) throw new HttpError(400, 'Validation failed', errors);
  return { username: body.username.trim(), password: body.password };
}

function validateSearchQuery(searchParams) {
  const q = (searchParams.get('q') || '').trim();
  if (q.length > 100 || CONTROL_CHARS.test(q)) throw new HttpError(400, 'Invalid search query');
  const limit = intParam(searchParams.get('limit'), 24, 1, 100, 'limit');
  const offset = intParam(searchParams.get('offset'), 0, 0, 100_000, 'offset');
  return { q, limit, offset };
}

function intParam(raw, dflt, min, max, name) {
  if (raw === null || raw === '') return dflt;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `${name} must be an integer`);
  const n = Number(raw);
  if (n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return n;
}

function parseId(raw) {
  if (!/^[1-9]\d{0,15}$/.test(raw)) throw new HttpError(404, 'Not found');
  return Number(raw);
}

module.exports = { validateProduct, validateLogin, validateSearchQuery, parseId };
