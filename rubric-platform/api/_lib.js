import { createHash, timingSafeEqual } from 'node:crypto';

export function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

const sha = (s) => createHash('sha256').update(String(s)).digest();

// Shared department access code + teacher name. Returns the teacher name, or null after replying.
export function authenticate(req, res) {
  const expected = process.env.ACCESS_CODE;
  if (!expected) {
    send(res, 500, { error: 'لم يُضبط رمز الدخول ACCESS_CODE في إعدادات الخادم.' });
    return null;
  }
  const given = decodeURIComponent(req.headers['x-access-code'] || '');
  if (!timingSafeEqual(sha(given), sha(expected))) {
    send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    return null;
  }
  let teacher = '';
  try { teacher = decodeURIComponent(req.headers['x-teacher'] || ''); } catch { /* ignore */ }
  teacher = teacher.trim().slice(0, 60);
  if (!teacher) {
    send(res, 400, { error: 'اكتب اسمك للدخول.' });
    return null;
  }
  return teacher;
}

// Upstash Redis over REST (works with Vercel's Upstash/KV integration variable names)
export async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('قاعدة البيانات غير مربوطة (UPSTASH_REDIS_REST_URL / TOKEN).');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `Redis ${r.status}`);
  return j.result;
}

export const GOALS_KEY = 'rubric:goals';

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}

const LEVELS = ['advanced', 'proficient', 'developing', 'beginner'];

// Accept exactly three criteria of non-empty strings; trim and cap lengths.
export function cleanCriteria(list) {
  if (!Array.isArray(list) || list.length !== 3) return null;
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') return null;
    const item = { name: String(c.name ?? '').trim().slice(0, 120) };
    if (!item.name) return null;
    for (const k of LEVELS) {
      item[k] = String(c[k] ?? '').trim().slice(0, 500);
      if (!item[k]) return null;
    }
    out.push(item);
  }
  return out;
}
