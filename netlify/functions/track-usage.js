async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(`${url}/${command.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.result;
}

exports.handler = async function (event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const { clientId, sessionData } = body;

    if (!clientId || !sessionData) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing data' }) };

    const dbKey = `student_data:${clientId}`;
    await redis(['hset', dbKey, 'latest_test_state', JSON.stringify(sessionData)]);
    await redis(['hset', dbKey, 'last_active', new Date().toISOString()]);

    return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Tracking Error' }) };
  }
};
