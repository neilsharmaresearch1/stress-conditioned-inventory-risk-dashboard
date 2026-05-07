const EVENTS_URL = "https://511ga.org/api/v2/get/event";

const CORRIDOR_TERMS = [
  "I-16",
  "I 16",
  "INTERSTATE 16",
  "I-75",
  "I 75",
  "INTERSTATE 75",
  "I-475",
  "I 475",
  "INTERSTATE 475",
  "I-285",
  "I 285",
  "SAVANNAH",
  "MACON",
  "ATLANTA"
];

function includesCorridorTerm(value) {
  const text = String(value || "").toUpperCase();
  return CORRIDOR_TERMS.some((term) => text.includes(term.toUpperCase()));
}

function isCorridorEvent(event) {
  return (
    includesCorridorTerm(event.RoadwayName) ||
    includesCorridorTerm(event.Description) ||
    includesCorridorTerm(event.Comment) ||
    includesCorridorTerm(event.Location)
  );
}

function scoreEvent(event) {
  let score = 0;

  const type = String(event.EventType || "").toLowerCase();
  const severity = String(event.Severity || "").toLowerCase();
  const lanes = String(event.LanesAffected || "").toLowerCase();
  const description = String(event.Description || "").toLowerCase();

  if (event.IsFullClosure) score += 0.35;

  if (type.includes("accident")) score += 0.22;
  if (type.includes("closure")) score += 0.25;
  if (type.includes("construction")) score += 0.08;
  if (type.includes("roadwork")) score += 0.08;
  if (type.includes("congestion")) score += 0.15;

  if (severity.includes("major") || severity.includes("severe")) score += 0.22;
  if (severity.includes("moderate")) score += 0.12;
  if (severity.includes("minor")) score += 0.05;

  if (lanes.includes("all")) score += 0.18;
  if (lanes.includes("lane")) score += 0.08;

  if (description.includes("blocked")) score += 0.12;
  if (description.includes("delay")) score += 0.08;
  if (description.includes("crash")) score += 0.15;

  return score;
}

function scoreTraffic(events) {
  const allEvents = Array.isArray(events) ? events : [];
  const corridorEvents = allEvents.filter(isCorridorEvent);

  const rawScore = corridorEvents.reduce((sum, event) => {
    return sum + scoreEvent(event);
  }, 0);

  const trafficScore = Math.min(1, rawScore / 1.5);

  return {
    traffic_score: Number(trafficScore.toFixed(3)),
    traffic_event_count: corridorEvents.length,
    corridor_events: corridorEvents.slice(0, 8).map((event) => ({
      roadway: event.RoadwayName || null,
      direction: event.DirectionOfTravel || null,
      type: event.EventType || null,
      severity: event.Severity || null,
      lanes: event.LanesAffected || null,
      full_closure: Boolean(event.IsFullClosure),
      description: event.Description || null,
      last_updated: event.LastUpdated || null
    }))
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

  try {
    const key = process.env.GA511_API_KEY;

    if (!key) {
      return res.status(500).json({
        ok: false,
        error: "Missing GA511_API_KEY environment variable",
        traffic_source_enabled: false,
        traffic_score: 0,
        traffic_event_count: 0
      });
    }

    const url = `${EVENTS_URL}?key=${encodeURIComponent(key)}&format=json`;

    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`511GA request failed with status ${response.status}`);
    }

    const events = await response.json();
    const traffic = scoreTraffic(events);

    return res.status(200).json({
      ok: true,
      source: "511GA",
      timestamp: new Date().toISOString(),
      traffic_source_enabled: true,
      ...traffic
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      source: "511GA",
      timestamp: new Date().toISOString(),
      traffic_source_enabled: false,
      traffic_score: 0,
      traffic_event_count: 0,
      error: error.message
    });
  }
}
