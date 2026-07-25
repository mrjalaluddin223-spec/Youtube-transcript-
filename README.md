# Transcript — YouTube transcript extractor

Paste a YouTube link, get the full transcript back — original captions, any
language YouTube offers, with timestamps. Copy it, or download as `.txt` or
`.srt`.

## How it works

- `index.html` is the page — a form for the link, a language picker, and a
  scrolling transcript panel.
- `netlify/functions/transcript.js` is a small serverless function. It fetches
  the YouTube video page **on the server** and reads the caption track out of
  it, then downloads the chosen caption track and returns clean JSON.

The fetching has to happen on a server, not in the browser — YouTube blocks
direct cross-origin requests from a page like this one. That's what the
Netlify function is for. This is the same approach used by well-known
open-source YouTube transcript libraries.

## Deploy it — GitHub + Netlify

Already done if you're reading this on GitHub — next step is Netlify.

1. Go to [app.netlify.com](https://app.netlify.com) and log in (or sign up,
   it's free).
2. Click **Add new site → Import an existing project**.
3. Choose **GitHub**, authorize it, and pick this repo.
4. Build settings — leave everything as-is. `netlify.toml` in this repo
   already tells Netlify:
   - publish directory: `.`
   - functions directory: `netlify/functions`
5. Click **Deploy site**.

That's it — no build step, no environment variables, no API keys needed.
In a minute or two you'll get a live URL like `your-site-name.netlify.app`.

## Notes

- Works on any public video that has captions — either uploaded by the
  creator or YouTube's auto-generated ones.
- If a video has captions in more than one language, the language dropdown
  lets you switch — it re-fetches that language's track.
- Videos with no captions at all will show a clear message rather than
  fail silently.
