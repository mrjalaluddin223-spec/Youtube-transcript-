// netlify/functions/transcript.js
//
// Fetches YouTube captions using YouTube's internal "innertube" API (the
// same one YouTube's own apps use), instead of scraping the public watch
// page. Tries a few different client identities in turn, since YouTube
// periodically blocks one or another; the first one that works is used.

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

const CLIENTS = [
  {
    // "sdkless" Android client — omitting androidSdkVersion avoids
    // triggering YouTube's PO Token requirement, as of early 2026.
    clientNameHeader: '3',
    context: {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
      hl: 'en',
      gl: 'US'
    }
  },
  {
    clientNameHeader: '5',
    context: {
      clientName: 'IOS',
      clientVersion: '20.03.02',
      deviceModel: 'iPhone16,2',
      userAgent: 'com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X)',
      hl: 'en',
      gl: 'US'
    }
  },
  {
    clientNameHeader: '2',
    context: {
      clientName: 'MWEB',
      clientVersion: '2.20260201.00.00',
      hl: 'en',
      gl: 'US',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
    }
  }
];

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

async function tryClient(clientConfig, videoId) {
  const ua = clientConfig.context.userAgent || clientConfig.userAgent ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

  const payload = {
    videoId,
    context: { client: clientConfig.context }
  };
  if (clientConfig.thirdParty) {
    payload.context.thirdParty = clientConfig.thirdParty;
  }

  const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': ua,
      'X-YouTube-Client-Name': clientConfig.clientNameHeader,
      'X-YouTube-Client-Version': clientConfig.context.clientVersion
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, status: res.status, detail: text.slice(0, 200), clientName: clientConfig.context.clientName };
  }

  if (!res.ok) {
    return { ok: false, status: res.status, detail: JSON.stringify(json).slice(0, 200), clientName: clientConfig.context.clientName };
  }

  const playability = json.playabilityStatus && json.playabilityStatus.status;
  const tracklist = json.captions && json.captions.playerCaptionsTracklistRenderer;
  const hasCaptions = tracklist && tracklist.captionTracks && tracklist.captionTracks.length;

  if (playability === 'OK' && hasCaptions) {
    return { ok: true, playerResponse: json, ua };
  }

  return {
    ok: false,
    status: res.status,
    detail: `playability=${playability || 'unknown'} hasCaptions=${!!hasCaptions}`,
    clientName: clientConfig.context.clientName,
    playerResponse: json
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return respond(200, {});
  }

  const { videoId, lang } = event.queryStringParameters || {};

  if (!videoId || !/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
    return respond(400, { error: 'BAD_REQUEST', message: 'Missing or invalid videoId.' });
  }

  const attempts = [];
  let success = null;

  try {
    for (const clientConfig of CLIENTS) {
      const result = await tryClient(clientConfig, videoId);
      attempts.push({ client: clientConfig.context.clientName, status: result.status, detail: result.detail });
      if (result.ok) {
        success = result;
        break;
      }
      if (result.playerResponse && result.playerResponse.playabilityStatus &&
          result.playerResponse.playabilityStatus.status !== 'OK' && !success) {
        success = { unplayable: result.playerResponse.playabilityStatus };
      }
    }

    if (!success || !success.playerResponse) {
      if (success && success.unplayable) {
        return respond(422, {
          error: 'UNPLAYABLE',
          message: success.unplayable.reason || 'This video is not available.'
        });
      }
      return respond(502, {
        error: 'ALL_CLIENTS_FAILED',
        message: 'Could not read this video from any client. Details: ' + JSON.stringify(attempts).slice(0, 500)
      });
    }

    const { playerResponse, ua } = success;
    const videoDetails = playerResponse.videoDetails || {};
    const tracklist = playerResponse.captions.playerCaptionsTracklistRenderer;
    const rawTracks = tracklist.captionTracks || [];

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
      headers: { 'User-Agent': ua }
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
    return respond(500, { error: 'SERVER_ERROR', message: 'Unexpected error: ' + (err && err.message ? err.message : String(err)) });
  }
};
