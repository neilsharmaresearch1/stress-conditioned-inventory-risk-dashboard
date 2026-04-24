export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const payload = {
    timestamp: new Date().toISOString(),
    regime: 'normal',
    stress_score: 0.38,
    scenario: 'baseline',
    selected_days_of_cover: 3,
    recommended_days: 3,
    minimum_feasible_days: 3,

    stockout_probability: 0.0185,
    stockout_ci_low: 0.0152,
    stockout_ci_high: 0.0221,

    expected_shortage: 0.040,
    policy_cost_index: 3.12,
    coverage_margin: 0,

    operational_takeaway:
      'Policy is at minimum feasible. Any reduction will breach the 2% target.'
  };

  res.status(200).json(payload);
}
