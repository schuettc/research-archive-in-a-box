// Join the six scenes into the demo video with ffmpeg: the last step of `just demo-video`.
// Each browser scene is cut to the parts demo/scenes.mjs kept; the agent scene is kept whole,
// with the stretches where Claude Code is working sped up and its first lines cut off the top.
// Each is fitted to its time in demo/captions.json and gets its caption strip drawn over its
// bottom edge; the scenes are then joined into out/research-archive-demo.mp4: H.264, 1280 by
// 800, no sound.
import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FPS = 30;
const MAX_BYTES = 10 * 1024 * 1024;
// The most a scene is sped up to fit its time before the run says so.
const FASTEST = 1.6;
// The agent scene is recorded this much taller than the video (demo/agent.tape says why), and
// the stretches where Claude Code works are sped up by at most this.
const AGENT_TOP = 108;
const FASTEST_WAIT = 8;
// Where the footer of Claude Code says "esc to interrupt" while it works, in the recording:
// the end of that phrase on the window's last line of text. Nothing else is drawn there.
const WORKING = { x: 582, y: 860, width: 30, height: 20 };

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
const captions = JSON.parse(await readFile(path.join(here, "captions.json"), "utf8"));
const timeline = JSON.parse(await readFile(path.join(out, "timeline.json"), "utf8"));
const video = path.join(out, "research-archive-demo.mp4");

const say = (text) => process.stdout.write(`${text}\n`);
const ffmpeg = (args) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: "inherit",
  });
const probe = (file, entries) =>
  execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", entries, "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");

/**
 * One scene as an .mp4 of exactly `seconds`, with its caption. `parts` are the stretches of the
 * source to keep, each with the speed it plays at (1 when it names none); `crop` is an ffmpeg
 * filter applied to the whole before it is framed.
 */
function fit(name, seconds, source, parts, crop = "") {
  const kept = parts.reduce((sum, part) => sum + (part.to - part.from) / (part.speed ?? 1), 0);
  const speed = kept / seconds;
  if (speed > FASTEST)
    say(`warning: ${name} runs ${kept.toFixed(1)} s and is sped up ${speed.toFixed(2)} times`);
  const cuts = parts.map(
    (part, index) =>
      `[0:v]trim=start=${part.from}:end=${part.to},setpts=(PTS-STARTPTS)/${part.speed ?? 1},` +
      `fps=${FPS}[part${index}]`,
  );
  const joined = `${parts.map((_, index) => `[part${index}]`).join("")}concat=n=${parts.length}:v=1:a=0[cut]`;
  // Too long: sped up evenly. Too short: its last frame is held.
  const timed =
    speed > 1
      ? `[cut]setpts=PTS/${speed},fps=${FPS}[timed]`
      : `[cut]tpad=stop_mode=clone:stop_duration=${seconds - kept + 1}[timed]`;
  const framed =
    `[timed]${crop}scale=1280:800:force_original_aspect_ratio=decrease,` +
    "pad=1280:800:(ow-iw)/2:(oh-ih)/2,setsar=1[framed]";
  const captioned = "[framed][1:v]overlay=0:0,format=yuv420p[v]";
  const target = path.join(out, "scenes", `${name}.mp4`);
  ffmpeg([
    "-i",
    source,
    "-i",
    path.join(out, "captions", `${name}.png`),
    "-filter_complex",
    [...cuts, joined, timed, framed, captioned].join(";"),
    "-map",
    "[v]",
    "-an",
    "-r",
    String(FPS),
    "-frames:v",
    String(seconds * FPS),
    "-c:v",
    "libx264",
    "-crf",
    "20",
    "-preset",
    "slow",
    target,
  ]);
  return target;
}

/**
 * The agent scene's parts: the whole recording, with each stretch where Claude Code is working
 * sped up so that the typing, the replies' reading time and the plugin's dialog play as they
 * happened and the scene still fits `seconds`. A working stretch is read off the frames: the
 * footer says "esc to interrupt" for as long as it lasts.
 */
function agentParts(source, seconds) {
  const RATE = 10;
  const { x, y, width, height } = WORKING;
  const pixels = execFileSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-i", source, "-vf"].concat(
      `fps=${RATE},crop=${width}:${height}:${x}:${y},format=gray`,
      ["-f", "rawvideo", "-"],
    ),
    { maxBuffer: 1 << 28 },
  );
  const frames = pixels.length / (width * height);
  const working = Array.from({ length: frames }, (_, frame) => {
    const from = frame * width * height;
    // Text on the dark background: a few bright pixels are enough.
    return pixels.subarray(from, from + width * height).filter((value) => value > 80).length > 5;
  });
  // Stretches of working frames; a flicker of under half a second doesn't end one, and one
  // under a second and a half is left as it is.
  const waits = [];
  for (let frame = 0; frame < frames; frame++) {
    if (!working[frame]) continue;
    const last = waits.at(-1);
    if (last && frame - last.to <= RATE / 2) last.to = frame + 1;
    else waits.push({ from: frame, to: frame + 1 });
  }
  const total = Number(probe(source, "format=duration")[0]);
  const long = waits
    .filter((wait) => wait.to - wait.from >= 1.5 * RATE)
    .map((wait) => ({ from: wait.from / RATE, to: Math.min(wait.to / RATE, total) }));
  const waiting = long.reduce((sum, wait) => sum + wait.to - wait.from, 0);
  const rest = total - waiting;
  const speed = Math.min(FASTEST_WAIT, Math.max(1, waiting / Math.max(seconds - rest, 0.1)));
  say(
    `agent: ${total.toFixed(1)} s recorded, ${waiting.toFixed(1)} s of it Claude working in ` +
      `${long.length} stretches (${long.map((wait) => `${wait.from}-${wait.to}`).join(", ")}), ` +
      `played ${speed.toFixed(1)} times faster`,
  );
  const parts = [];
  let at = 0;
  for (const wait of long) {
    if (wait.from > at) parts.push({ from: at, to: wait.from });
    parts.push({ ...wait, speed });
    at = wait.to;
  }
  if (total > at) parts.push({ from: at, to: total });
  return parts;
}

const agentRaw = path.join(out, "scenes", "agent-raw.mp4");
const scenes = captions.map(({ scene, seconds }) =>
  scene === "agent"
    ? fit(scene, seconds, agentRaw, agentParts(agentRaw, seconds), `crop=1280:800:0:${AGENT_TOP},`)
    : fit(scene, seconds, timeline[scene].file, timeline[scene].keeps),
);
// The agent's screenshot, cut as the scene is.
ffmpeg([
  "-i",
  path.join(out, "scenes", "agent-screenshot.png"),
  "-vf",
  `crop=1280:800:0:${AGENT_TOP}`,
  path.join(out, "screenshots", "demo-agent-session.png"),
]);

const list = path.join(out, "scenes", "list.txt");
await writeFile(list, scenes.map((file) => `file '${file}'\n`).join(""));
// Encoded once more as one stream, so every player sees one video; a file over the size
// GitHub's README player takes is encoded again, smaller.
for (const crf of [23, 27, 31]) {
  ffmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-an",
    "-c:v",
    "libx264",
    "-crf",
    String(crf),
    "-preset",
    "slow",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    video,
  ]);
  if ((await stat(video)).size < MAX_BYTES) break;
}

const [codec, width, height] = probe(video, "stream=codec_name,width,height");
const streams = probe(video, "stream=codec_type");
const seconds = Number(probe(video, "format=duration")[0]);
const bytes = (await stat(video)).size;
say(
  `${path.relative(process.cwd(), video)}: ${codec}, ${width}x${height}, ${seconds.toFixed(1)} s, ` +
    `${(bytes / 1024 / 1024).toFixed(1)} MB, ${streams.includes("audio") ? "with" : "no"} audio`,
);
const wrong = [
  codec !== "h264" && "it is not H.264",
  (width !== "1280" || height !== "800") && "it is not 1280 by 800",
  (seconds < 90 || seconds > 100) && "it is not 90 to 100 seconds long",
  streams.includes("audio") && "it has an audio track",
  bytes >= MAX_BYTES && "it is 10 MB or more",
].filter(Boolean);
if (wrong.length) {
  say(`the video is not as the README needs it: ${wrong.join("; ")}`);
  process.exit(1);
}
