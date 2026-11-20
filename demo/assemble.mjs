// Join the six scenes into the demo video with ffmpeg: the last step of `just demo-video`.
// Each scene is cut to the parts demo/scenes.mjs kept (the terminal scene is kept whole), fitted
// to its time in demo/captions.json, and gets its caption strip drawn over its bottom edge; the
// scenes are then joined into out/research-archive-demo.mp4: H.264, 1280 by 800, no sound.
import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FPS = 30;
const MAX_BYTES = 10 * 1024 * 1024;
// The most a scene is sped up to fit its time before the run says so.
const FASTEST = 1.6;

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

/** One scene as an .mp4 of exactly `seconds`, with its caption. */
function fit(name, seconds, source, keeps) {
  const parts = keeps ?? [{ from: 0, to: Number(probe(source, "format=duration")[0]) }];
  const kept = parts.reduce((sum, part) => sum + part.to - part.from, 0);
  const speed = kept / seconds;
  if (speed > FASTEST)
    say(`warning: ${name} runs ${kept.toFixed(1)} s and is sped up ${speed.toFixed(2)} times`);
  const cuts = parts.map(
    (part, index) =>
      `[0:v]trim=start=${part.from}:end=${part.to},setpts=PTS-STARTPTS,fps=${FPS}[part${index}]`,
  );
  const joined = `${parts.map((_, index) => `[part${index}]`).join("")}concat=n=${parts.length}:v=1:a=0[cut]`;
  // Too long: sped up evenly. Too short: its last frame is held.
  const timed =
    speed > 1
      ? `[cut]setpts=PTS/${speed},fps=${FPS}[timed]`
      : `[cut]tpad=stop_mode=clone:stop_duration=${seconds - kept + 1}[timed]`;
  const framed =
    "[timed]scale=1280:800:force_original_aspect_ratio=decrease," +
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

const scenes = captions.map(({ scene, seconds }) =>
  scene === "terminal"
    ? fit(scene, seconds, path.join(out, "scenes", "terminal-raw.mp4"), null)
    : fit(scene, seconds, timeline[scene].file, timeline[scene].keeps),
);

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
  (seconds < 80 || seconds > 90) && "it is not 80 to 90 seconds long",
  streams.includes("audio") && "it has an audio track",
  bytes >= MAX_BYTES && "it is 10 MB or more",
].filter(Boolean);
if (wrong.length) {
  say(`the video is not as the README needs it: ${wrong.join("; ")}`);
  process.exit(1);
}
