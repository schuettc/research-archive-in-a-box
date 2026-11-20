# The demo video

`just demo-video <stage>` records the 95-second video the repository's README shows, and the five screenshots of the guide, on a deployed stage. The video has six captioned scenes and no sound: searching the archive; Claude Code with the `cruise` plugin checking a package, fixing it and submitting it; a second package submitted on the web app's Submit page; a curator approving the first; the published page; and the config file.

Nothing here is part of the archive. The folder has its own `package.json`, which is not one of the root's npm workspaces, and nothing in it runs in CI.

## What you need

- A deployed stage with `keepData: false`, made for the recording and destroyed after it. [`examples/demo-stage/archive.yaml`](../examples/demo-stage/archive.yaml) is a config for one, named `demo`. The recipe refuses a stage that keeps its data.
- AWS credentials for the stage's account in your shell, as `just seed` needs.
- [Claude Code](https://code.claude.com/docs), signed in on the laptop. The agent scene is a real session, so each take uses a little of that account's allowance.
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

A run takes about six minutes, most of it waiting for the archive to check and publish. It writes to `demo/out/`, which git ignores:

- `research-archive-demo.mp4`: the video, H.264, 1280 by 800, under 10 MB, with no audio track. The run fails if it is anything else.
- `screenshots/`: `demo-browse.png`, `demo-submit-checks.png`, `demo-review-queue.png`, `demo-dataset-page.png` and `demo-agent-session.png`. Copy them to `docs/images/` to update the guide's pictures.
- `run.json`: the three accounts' passwords, readable only by you. They stop working when the stage is destroyed.

Watch the video before using it: check each scene shows the right page, that no caption hides what the scene is about, and that the agent scene reads well. Claude's words differ from take to take; record again if a take reads badly.

## What it does to the stage

1. `setup.py` makes three accounts: `contributor@example.org` and `field-team@example.org`, who each submit one package, and `curator@example.org` (who is also an admin and a contributor, since it seeds the stage), each with a password it generates. It publishes the six sample packages under `examples/` that the stage doesn't hold yet, signed in with the curator's password through the stage's test sign-in client, as `just ingest-e2e` signs in.
2. It builds two package folders in a new folder under `/tmp`: the plot survey that [the Packages guide](../docs/guide/packages.md#making-a-package-from-a-csv) makes by hand, with its title left out, and a small snow-depth package. In that folder's `.demo/` it puts what the agent scene runs.
3. `agent.tape` records the agent scene with VHS: Claude Code, started in that folder with the `cruise` plugin. VHS types the person's three lines (check the plot survey; yes to the title Claude drafts; sign in and submit) and accepts the plugin's own dialog before anything is sent. So the plot survey reaches the archive through the plugin, with the title Claude drafted in that take.
4. `scenes.mjs` records the browser scenes with Playwright, signing in on the archive's own sign-in page with the passwords. As the second contributor it submits the snow-depth folder on the Submit page; as the curator it opens the queue with both submissions, previews a file of the plot survey and approves it, and the snow-depth package stays waiting; signed out, it reads the published page. It takes the screenshots in windows of their own.
5. `assemble.mjs` cuts each browser scene to the parts worth watching, speeds up the stretches of the agent scene where Claude is working, fits each scene to its time in `captions.json`, draws its caption along the bottom, and joins the six.

Every page in the video is the stage's own and every reply in the agent scene is Claude's. Waiting, for the archive's checks, for publishing and for Claude, is cut out or sped up, not faked. The one thing drawn over a page is a dot that follows the mouse, because a browser recording shows no cursor. The script gives the page its folder through **Choose folder**, since a script can't drop a real folder from the desktop.

## The agent scene

The session is Claude Code as installed on the laptop, signed in as its owner, and started by `.demo/bin/cruise-agent` so that nothing else of the laptop's is in it or on screen:

- It loads no user settings, so no status line, hooks, plugins of the laptop's or instruction files, and no claude.ai connectors or notices. It changes none of them either. Claude Code does record the temporary folder as trusted, and keeps the session's transcript, in the laptop's own Claude folder, as for any session.
- Claude Code's first three lines name its version, the model with the account's plan, and the folder. The scene is recorded 108 pixels taller than the video and `assemble.mjs` cuts those lines off the top.
- The plugin is this checkout's: its skills are copied from `packages/agent`, and its MCP server is started from the checkout by `demo/archive_mcp.py`, not fetched from the released tag as the plugin's own `.mcp.json` does. The stage is saved as the plugin's archive in a config folder of the recording's own, by the plugin's own `connect`.
- The plugin's tools are allowed for the session, so Claude Code asks no permission for them; the shell tool is off. The plugin's "send this to the archive?" dialog is the plugin's own and is always shown.
- The plugin signs in on the archive's sign-in page in a browser. `demo/agent-signin.mjs` is that browser: it signs in off camera as `contributor@example.org` and presses **Sign in the command line**. `demo/archive_mcp.py` lets the sign-in listen on any free port instead of 8765, which another program on the laptop may hold.

The tape's third line asks Claude to sign in before it submits. Asked only to submit, it may call `submit` first, and the plugin then shows its dialog twice, once before the sign-in and once after; the tape answers one.

## Recording again

Run `just demo-video <stage>` again on the same stage. It gives the accounts new passwords, rejects every submission an earlier take left waiting for a curator (the snow-depth package, and a plot survey that was never approved), withdraws the plot survey the earlier take published so that Browse lists the six sample datasets again, and publishes this take's as `plot-survey-2` (then `-3`, and so on).

To change a caption or a scene's length, edit `captions.json`; the lengths add up to the video's. To change what a scene does, edit `scenes.mjs` or `agent.tape`. `python demo/setup.py --packages-only <folder>` builds the two package folders with no stage.
