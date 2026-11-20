# The demo video

`just demo-video <stage>` records the 85-second video the repository's README shows, and the five screenshots of the guide, on a deployed stage. The video has six captioned scenes and no sound: searching the archive, checking a package in a terminal with `cruise`, submitting it, a curator approving it, the published page, and the config file.

Nothing here is part of the archive. The folder has its own `package.json`, which is not one of the root's npm workspaces, and nothing in it runs in CI.

## What you need

- A deployed stage with `keepData: false`, made for the recording and destroyed after it. [`examples/demo-stage/archive.yaml`](../examples/demo-stage/archive.yaml) is a config for one, named `demo`. The recipe refuses a stage that keeps its data.
- AWS credentials for the stage's account in your shell, as `just seed` needs.
- [VHS](https://github.com/charmbracelet/vhs) and [ffmpeg](https://ffmpeg.org/), which record the terminal and join the scenes, and `jq`:

  ```
  brew install vhs ffmpeg jq
  ```

- [Playwright](https://playwright.dev/) and its Chromium, which record the browser:

  ```
  cd demo
  npm ci
  npx playwright install chromium
  ```

The recipe says which of these is missing and stops.

## Recording

Deploy the stage, record, and destroy the stage, each with the demo stage's config:

```
export ARCHIVE_CONFIG=examples/demo-stage/archive.yaml
just lambda-assets
npm run build -w packages/web
(cd packages/infra && npx cdk deploy ResearchArchive-demo)
just demo-video demo
just destroy demo
```

A run takes about ten minutes, most of it waiting for the archive to check and publish. It writes to `demo/out/`, which git ignores:

- `research-archive-demo.mp4`: the video, H.264, 1280 by 800, under 10 MB, with no audio track. The run fails if it is anything else.
- `screenshots/`: `demo-browse.png`, `demo-submit-checks.png`, `demo-review-queue.png`, `demo-dataset-page.png` and `demo-cruise-diagnose.png`. Copy them to `docs/images/` to update the guide's pictures.
- `run.json`: the two accounts' passwords, readable only by you. They stop working when the stage is destroyed.

Watch the video before using it: check each scene shows the right page, and that no caption hides what the scene is about.

## What it does to the stage

1. `setup.py` makes two accounts, `contributor@example.org` and `curator@example.org` (who is also an admin and a contributor, since it seeds the stage), each with a password it generates. It publishes the six sample packages under `examples/` that the stage doesn't hold yet, signed in with the curator's password through the stage's test sign-in client, as `just ingest-e2e` signs in.
2. It builds two package folders in a temporary folder: the plot survey that [the Packages guide](../docs/guide/packages.md#making-a-package-from-a-csv) makes by hand, with its title left out, and a small snow-depth package. It submits the snow-depth package as the contributor and leaves it waiting for a curator, so the review queue has more than one row.
3. `terminal.tape` records the terminal scene with VHS: `cruise diagnose` shows the missing title, `cruise set` adds it, and `cruise diagnose` says the package is publishable.
4. `scenes.mjs` records the browser scenes with Playwright, signing in on the archive's own sign-in page with the passwords. As the contributor it submits the plot survey folder the terminal scene fixed; as the curator it previews a file and approves it; signed out, it reads the published page. It takes the screenshots in windows of their own.
5. `assemble.mjs` cuts each scene to the parts worth watching, fits it to its time in `captions.json`, draws its caption along the bottom, and joins the six.

Every page in the video is the stage's own. Waiting for the archive's checks and for publishing is cut out, not faked. The one thing drawn over a page is a dot that follows the mouse, because a browser recording shows no cursor. The script gives the page its folder through **Choose folder**, since a script can't drop a real folder from the desktop.

## Recording again

Run `just demo-video <stage>` again on the same stage. It gives the accounts new passwords, withdraws the plot survey the earlier take published so that Browse lists the six sample datasets again, and publishes this take's as `plot-survey-2` (then `-3`, and so on).

To change a caption or a scene's length, edit `captions.json`; the lengths add up to the video's. To change what a scene does, edit `scenes.mjs` or `terminal.tape`. `python demo/setup.py --packages-only <folder>` builds the two package folders with no stage, which is enough to try the terminal scene: run `vhs` on the tape from inside that folder with the folder's `bin` first on `PATH`.
