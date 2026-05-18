import { readFile } from 'fs/promises';
import { join }     from 'path';

const FALLBACK = {
  status:     'unavailable',
  updated_at: null,
  limitations: 'History file not available.',
  points:     []
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let payload;
  try {
    const text = await readFile(join(process.cwd(), 'data/history.json'), 'utf8');
    payload = JSON.parse(text);
  } catch (_) {
    payload = FALLBACK;
  }

  res.status(200).json(payload);
}
