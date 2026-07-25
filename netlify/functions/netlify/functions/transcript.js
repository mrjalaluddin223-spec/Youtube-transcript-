// netlify/functions/transcript.js
//
// Runs server-side on Netlify (Node 18+, which has a built-in `fetch`).
// A browser can't fetch youtube.com directly (YouTube blocks cross-origin
// requests), so this function does the fetching on the server and hands
// clean JSON back to the page.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

// Pulls a top-level JSON object out of raw HTML by locating `marker = {`
// and counting braces, rather than relying on a regex to match nested JSON
// (regex can't reliably balance nested braces/brackets).
function extractJsonAfter(html, marker) {
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;
  const start = html.indexOf('{', markerIdx);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const jsonStr = html.slice(start, i + 1);
        try {
          return JSON.parse(jsonStr);
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return respond(200, {});
  }

  const { videoId, lang } = event.queryStringParameters || {};

  if (!videoId || !/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
    return respond(400, { error: 'BAD_REQUEST', message: 'Missing or invalid videoId.' });
  }

  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!pageRes.ok) {
      return respond(502, { error: 'FETCH_FAILED', message: 'YouTube did not return that page. The video may not exist.' });
    }

    const html = await pageRes.text();

    if (/consent\.youtube\.com/.test(html) || /Before you continue to YouTube/.test(html)) {
      return respond(502, { error: 'CONSENT_WALL', message: 'YouTube returned a consent page instead of the video. Please try again in a moment.' });
    }

    const playerResponse = extractJsonAfter(html, 'ytInitialPlayerResponse');

    if (!playerResponse) {
      return respond(502, { error: 'PARSE_FAILED', message: 'Could not read this video\'s data. It may be private, age-restricted, or region-locked.' });
    }

    const playability = playerResponse.playabilityStatus && playerResponse.playabilityStatus.status;
    if (playability && playability !== 'OK') {
      const reason = (playerResponse.playabilityStatus && playerResponse.playabilityStatus.reason) || 'This video is not available.';
      return respond(422, { error: 'UNPLAYABLE', message: reason });
    }

    const videoDetails = playerResponse.videoDetails || {};
    const tracklist = playerResponse.captions &&
      playerResponse.captions.playerCaptionsTracklistRenderer;
    const rawTracks = (tracklist && tracklist.captionTracks) || [];

    if (!rawTracks.length) {
      return respond(422, { error: 'NO_CAPTIONS', message: 'This video has no captions available, so there is no transcript to pull.' });
    }

    const tracks = rawTracks.map(t => ({
      code: t.languageCode,
      name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || t.languageCode,
      baseUrl: t.baseUrl,
      isAuto: t.kind === 'asr'
    }));

    let chosen = tracks[0];
    if (lang) {
      const found = tracks.find(t => t.code === lang);
      if (found) chosen = found;
    }

    const transcriptRes = await fetch(`${chosen.baseUrl}&fmt=json3`, {
      headers: { 'User-Agent': UA }
    });

    if (!transcriptRes.ok) {
      return respond(502, { error: 'TRANSCRIPT_FETCH_FAILED', message: 'Found captions but could not download them. Please try again.' });
    }

    const transcriptJson = await transcriptRes.json();

    const cues = (transcriptJson.events || [])
      .filter(e => e.segs && e.segs.length)
      .map(e => ({
        start: Math.max(0, (e.tStartMs || 0) / 1000),
        duration: (e.dDurationMs || 0) / 1000,
        text: e.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
      }))
      .filter(c => c.text.length > 0);

    if (!cues.length) {
      return respond(422, { error: 'EMPTY_TRANSCRIPT', message: 'The captions for this video came back empty.' });
    }

    return respond(200, {
      videoId,
      title: videoDetails.title || '',
      author: videoDetails.author || '',
      languages: tracks.map(t => ({ code: t.code, name: t.name, isAuto: t.isAuto })),
      selectedLanguage: chosen.code,
      transcript: cues
    });

  } catch (err) {
    return respond(500, { error: 'SERVER_ERROR', message: 'Unexpected error while reading the transcript. Please try again.' });
  }
};
