//netlify/functions/transcript.js
//
// Fetches YouTube captions using YouTube's internal "innertube" API (the
// same one the official Android app uses), instead of scraping the public
// watch page. Scraping the watch page from a server/datacenter IP often
// triggers YouTube's "confirm you're not a bot" wall; the app API is far
// less likely to be blocked and returns clean JSON directly.

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const ANDROID_UA = 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip';

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return respond(200, {});
  }

  const { videoId, lang } = event.queryStringParameters || {};

  if (!videoId || !/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
    return respond(400, { error: 'BAD_REQUEST', message: 'Missing or invalid videoId.' });
  }

  try {
    const playerRes = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': ANDROID_UA,
          'X-YouTube-Client-Name': '3',
          'X-YouTube-Client-Version': '19.09.37'
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion: '19.09.37',
              androidSdkVersion: 30,
              hl: 'en',
              gl: 'US',
              userAgent: ANDROID_UA
            }
          }
        })
      }
    );

    if (!playerRes.ok) {
      const bodyText = await playerRes.text();
      return respond(502, {
        error: 'FETCH_FAILED',
        message: `YouTube did not respond as expected (status ${playerRes.status}). ${bodyText.slice(0, 300)}`
      });
    }

    const playerResponse = await playerRes.json();

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
      headers: { 'User-Agent': ANDROID_UA }
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
