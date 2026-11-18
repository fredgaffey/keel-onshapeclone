// Accounts and sessions: PBKDF2 password hashes and random session tokens in D1.
// The cookie holds the token; D1 holds only its SHA-256, so a leaked table can't sign anyone in.

const COOKIE = 'keel_session';
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000; // the most Workers' WebCrypto allows

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => new Uint8Array((s.match(/../g) || []).map((h) => parseInt(h, 16)));

export function randomId(bytes = 12) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(bytes));
  return [...r].map((b) => alphabet[b % alphabet.length]).join('');
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS }, key, 256);
  return hex(bits);
}

async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function createUser(env, { email, name, password }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim().slice(0, 80) || email.split('@')[0];
  if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) throw new HttpError(400, 'Passwords need at least 8 characters.');
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) throw new HttpError(409, 'An account with that email already exists.');
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const user = { id: randomId(), email, name };
  await env.DB.prepare('INSERT INTO users (id, email, name, pw_salt, pw_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(user.id, email, name, salt, await hashPassword(password, salt), Date.now())
    .run();
  return user;
}

export async function checkPassword(env, email, password) {
  email = String(email || '').trim().toLowerCase();
  const row = await env.DB.prepare('SELECT id, email, name, pw_salt, pw_hash FROM users WHERE email = ?').bind(email).first();
  // Hash even when there's no such user, so the response time doesn't say which emails exist.
  const hash = await hashPassword(String(password || ''), row ? row.pw_salt : '00'.repeat(16));
  if (!row || !timingSafeEqual(hash, row.pw_hash)) throw new HttpError(401, 'Wrong email or password.');
  return { id: row.id, email: row.email, name: row.name };
}

export async function startSession(env, userId, secure) {
  const token = randomId(32);
  const expires = Date.now() + SESSION_DAYS * 86400_000;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), userId, expires).run();
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

export async function endSession(env, request) {
  const token = readCookie(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function currentUser(env, request) {
  const token = readCookie(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
  ).bind(await sha256(token)).first();
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, email: row.email, name: row.name };
}

function readCookie(request) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=') || null;
  }
  return null;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
