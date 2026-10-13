import { authenticate, send, redis, readBody, cleanCriteria, GOALS_KEY } from './_lib.js';

async function getGoal(id) {
  const raw = await redis(['HGET', GOALS_KEY, id]);
  return raw ? JSON.parse(raw) : null;
}

export default async function handler(req, res) {
  const teacher = authenticate(req, res);
  if (!teacher) return;
  try {
    if (req.method === 'GET') {
      const flat = (await redis(['HGETALL', GOALS_KEY])) || [];
      const goals = [];
      for (let i = 1; i < flat.length; i += 2) {
        try { goals.push(JSON.parse(flat[i])); } catch { /* skip corrupt row */ }
      }
      goals.sort((a, b) => b.createdAt - a.createdAt);
      return send(res, 200, { goals: goals.slice(0, 300) });
    }

    if (req.method === 'PATCH') {
      const { id, criteria } = await readBody(req);
      const clean = cleanCriteria(criteria);
      if (!id || !clean) return send(res, 400, { error: 'بيانات غير صالحة.' });
      const g = await getGoal(String(id));
      if (!g) return send(res, 404, { error: 'الهدف غير موجود.' });
      if (g.teacher !== teacher) return send(res, 403, { error: 'يمكنك تعديل أهدافك فقط.' });
      g.criteria = clean;
      g.updatedAt = Date.now();
      await redis(['HSET', GOALS_KEY, g.id, JSON.stringify(g)]);
      return send(res, 200, { goal: g });
    }

    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (!id) return send(res, 400, { error: 'معرّف الهدف مفقود.' });
      const g = await getGoal(id);
      if (!g) return send(res, 200, { ok: true });
      if (g.teacher !== teacher) return send(res, 403, { error: 'يمكنك حذف أهدافك فقط.' });
      await redis(['HDEL', GOALS_KEY, id]);
      return send(res, 200, { ok: true });
    }

    return send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    return send(res, 500, { error: e.message || 'خطأ في الخادم.' });
  }
}
