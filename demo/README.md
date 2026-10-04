# Demo

Real Sidebet output from our group chats, with friends' names changed. The bets
on #71 were placed for the demo; #64 played out as shown.

- `sidebet-demo.mp4`: 90-second demo video (1080p).
- `site/`: the demo web page. `python3 site/build.py` rebuilds `site/index.html`
  from `template.html` and `demo.json`, with the images inlined.
- `video/`: the video page and recorder. To re-render, build `video/video.html`
  from `video/template.html` (same scene data as the site), then
  `npm i puppeteer-core@23 ffmpeg-static@5` and `node record.mjs` (needs Google
  Chrome). It steps the animation frame by frame into `frames/`; encode with
  `ffmpeg -framerate 30 -i frames/%05d.jpg -c:v libx264 -pix_fmt yuv420p sidebet-demo.mp4`.
