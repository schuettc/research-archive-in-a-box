"""Set a disposable stage up for the demo video: the first step of `just demo-video <stage>`.

On a deployed stage with `keepData: false` it

1. reads the site's domain, the user pool and the test sign-in client from the stack's outputs;
2. makes the three accounts of the video, two contributors and a curator, each with a
   password it generates here and sets as permanent;
3. publishes every sample package under `examples/` that the stage doesn't hold yet, as the
   curator, through `scripts/seed.py`;
4. clears what an earlier take left: it rejects every submission still waiting for a curator
   and withdraws the plot survey an earlier take published;
5. builds the two package folders of the video in a new temporary folder: the plot survey of
   docs/guide/packages.md with its title left out, for the agent to fix and submit, and a
   small snow-depth package for the Submit page;
6. puts what the agent scene needs in that folder's `.demo/`: the cruise plugin from this
   checkout with its MCP server run from the checkout, the stage saved as the plugin's
   archive, and the commands that start Claude Code and drive the plugin's browser sign-in;
7. writes what the recording needs to `demo/out/run.json`: the site, the three accounts with
   their passwords, and the folders. `demo/out/` is ignored by git, and the accounts go with
   the stage when it is destroyed.

`python demo/setup.py --packages-only <folder>` does step 5 alone, with no AWS call.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "demo" / "out"
sys.path.insert(0, str(ROOT / "scripts"))

import seed  # noqa: E402

ACCOUNTS = {
    # The curator seeds the stage too, and submitting takes the contributor role.
    "curator": ("curator@example.org", ["contributor", "curator", "admin"]),
    # The agent scene's contributor, and the one who submits on the web app's Submit page.
    "contributor": ("contributor@example.org", ["contributor"]),
    "second": ("field-team@example.org", ["contributor"]),
}
EARLIER = "An earlier take of the demo video."
POLL_SECONDS = 5.0
WAIT_SECONDS = 15 * 60.0

PLOT_TITLE = "Canopy cover and stem counts on four forest plots"
PLOT_CSV = """\
plot,date,canopy_cover,stems
P01,2024-06-03,72,41
P02,2024-06-03,65,38
P03,2024-06-04,80,52
P04,2024-06-04,58,29
"""
PLOT_FIELDS = [
    {"name": "plot", "type": "string"},
    {"name": "date", "type": "date"},
    {"name": "canopy_cover", "type": "integer"},
    {"name": "stems", "type": "integer"},
]
# docs/guide/packages.md's edits for the plot survey, with the title (which is then taken out
# again, for the agent to draft) and the three fields the ecology profile asks for.
PLOT_EDITS: list[dict[str, Any]] = [
    {"target": "title", "value": PLOT_TITLE},
    {
        "target": "description",
        "value": "Canopy cover and the number of tree stems on four permanent forest plots at "
        "an invented field station, surveyed in June 2024.",
    },
    {
        "target": "contributors",
        "value": [{"title": "Field Station Survey Team", "roles": ["creator"]}],
    },
    {
        "target": "licenses",
        "value": [{"name": "CC-BY-4.0", "path": "https://creativecommons.org/licenses/by/4.0/"}],
    },
    {"target": "archive:temporalCoverage", "value": {"start": "2024-06-03", "end": "2024-06-04"}},
    {
        "target": "archive:spatialCoverage",
        "value": {
            "bbox": [-72.75, 44.25, -72.70, 44.30],
            "description": "Four permanent plots at an invented field station.",
        },
    },
    {
        "target": "archive:methods",
        "value": "Canopy cover read with a spherical densiometer at each plot centre; stems "
        "counted inside a 20 m by 20 m square.",
    },
    *(
        {"target": target, "resource": "plots", "column": column, "value": value}
        for column, target, value in [
            ("plot", "description", "The plot's code, P01 to P04."),
            ("date", "description", "The day the plot was surveyed."),
            (
                "canopy_cover",
                "description",
                "Share of the sky hidden by the canopy, read at the plot centre.",
            ),
            ("canopy_cover", "archive:unit", "percent"),
            (
                "stems",
                "description",
                "Live tree stems wider than 10 cm at breast height inside the plot.",
            ),
            ("stems", "archive:unit", "dimensionless"),
        ]
    ),
]

SNOW_TITLE = "Snow depth at five meadow stakes"
SNOW_CSV = """\
stake,date,snow_depth_cm
K1,2024-02-05,62
K2,2024-02-05,58
K3,2024-02-05,71
K4,2024-02-05,49
K5,2024-02-05,66
K1,2024-03-04,81
K2,2024-03-04,77
K3,2024-03-04,93
K4,2024-03-04,64
K5,2024-03-04,85
"""
SNOW_FIELDS = [
    {"name": "stake", "type": "string"},
    {"name": "date", "type": "date"},
    {"name": "snow_depth_cm", "type": "integer"},
]
SNOW_EDITS: list[dict[str, Any]] = [
    {"target": "title", "value": SNOW_TITLE},
    {
        "target": "description",
        "value": "Snow depth read at five marked stakes in an invented meadow on two days in "
        "the winter of 2024. Every stake and reading is invented.",
    },
    {
        "target": "contributors",
        "value": [
            {
                "title": "Invented Research Cooperative",
                "organization": "Invented Research Cooperative",
                "roles": ["creator"],
            }
        ],
    },
    {
        "target": "licenses",
        "value": [{"name": "CC-BY-4.0", "path": "https://creativecommons.org/licenses/by/4.0/"}],
    },
    {"target": "archive:temporalCoverage", "value": {"start": "2024-02-05", "end": "2024-03-04"}},
    {
        "target": "archive:spatialCoverage",
        "value": {"bbox": [-72.73, 44.26, -72.71, 44.28], "description": "One invented meadow."},
    },
    {
        "target": "archive:methods",
        "value": "Depth read to the nearest centimetre against each stake's scale.",
    },
    *(
        {"target": target, "resource": "depths", "column": column, "value": value}
        for column, target, value in [
            ("stake", "description", "The stake's code, K1 to K5."),
            ("date", "description", "The day the stake was read."),
            ("snow_depth_cm", "description", "Depth of snow at the stake, in centimetres."),
            ("snow_depth_cm", "archive:unit", "cm"),
        ]
    ),
]


class Failed(Exception):
    pass


# The package folders, built as docs/guide/packages.md builds one: a CSV, a first manifest
# written by hand with the file's size and hash, then cruise set for the rest.


def cruise(*args: str) -> None:
    subprocess.run(
        ["uv", "run", "--project", str(ROOT), "--all-packages", "--frozen", "cruise", *args],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def build_package(
    folder: Path,
    dataset_id: str,
    resource: tuple[str, str, str],
    csv: str,
    fields: list[dict[str, str]],
    edits: list[dict[str, Any]],
) -> None:
    name, file_name, title = resource
    (folder / "data").mkdir(parents=True)
    data = csv.encode()
    (folder / "data" / file_name).write_bytes(data)
    manifest = {
        "id": dataset_id,
        "name": dataset_id,
        "resources": [
            {
                "name": name,
                "path": f"data/{file_name}",
                "title": title,
                "archive:kind": "table",
                "format": "csv",
                "bytes": len(data),
                "hash": "sha256:" + hashlib.sha256(data).hexdigest(),
                "schema": {"fields": fields},
            }
        ],
    }
    (folder / "datapackage.json").write_text(json.dumps(manifest, indent=2) + "\n", "utf-8")
    edits_file = folder.parent / f"{folder.name}-edits.json"
    edits_file.write_text(json.dumps(edits), "utf-8")
    cruise("set", str(folder), "--file", str(edits_file))
    edits_file.unlink()


def build_packages(work: Path, plot_id: str = "plot-survey") -> dict[str, str]:
    """Build both folders under `work`.

    The plot survey is left with one error, its missing title: in the agent scene Claude Code
    finds it, drafts a title, writes it on the person's yes and submits the folder. The
    snow-depth package is publishable as built; the Submit page sends it.
    """
    plot = work / "plot-survey"
    build_package(
        plot, plot_id, ("plots", "plots.csv", "Plot survey"), PLOT_CSV, PLOT_FIELDS, PLOT_EDITS
    )
    edits_file = work / "untitle.json"
    edits_file.write_text(json.dumps([{"target": "title", "value": None}]), "utf-8")
    cruise("set", str(plot), "--file", str(edits_file))
    edits_file.unlink()
    snow = work / "snow-depth"
    build_package(
        snow,
        "snow-depth",
        ("depths", "depths.csv", "Snow depths"),
        SNOW_CSV,
        SNOW_FIELDS,
        SNOW_EDITS,
    )
    return {"work": str(work), "plot": str(plot), "snow": str(snow)}


# The agent scene's Claude Code session.

AGENT = """\
#!/usr/bin/env bash
# Claude Code for the agent scene, with the laptop's own sign-in and nothing else of the
# laptop's: no user settings (so no status line, hooks, plugins or instruction files), no
# claude.ai connectors and no notices, the cruise plugin from this folder, its tools allowed
# for this session, and no shell tool.
cd "{work}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ENABLE_CLAUDEAI_MCP_SERVERS=false
exec claude --plugin-dir "{plugin}" --setting-sources project --model sonnet \\
    --allowedTools mcp__plugin_cruise_cruise --disallowedTools Bash
"""
OPEN_SIGN_IN = """\
#!/usr/bin/env bash
# The plugin's "browser": Python's webbrowser runs this (BROWSER) with the sign-in page's
# address. It hands the address to demo/agent-signin.mjs and returns at once.
nohup "{node}" "{script}" "$1" >"{log}" 2>&1 &
"""


def build_agent(work: Path, site: str) -> None:
    """Write `work/.demo/`: the plugin, the archive it starts on and the two commands."""
    support = work / ".demo"
    agent = ROOT / "packages" / "agent"
    plugin = support / "plugin"
    (plugin / ".claude-plugin").mkdir(parents=True)
    shutil.copy(agent / ".claude-plugin" / "plugin.json", plugin / ".claude-plugin")
    shutil.copytree(agent / "skills", plugin / "skills")
    # The plugin's own .mcp.json fetches a released tag; this one runs the checkout's server.
    opener = support / "bin" / "open-sign-in"
    server = {
        "command": "uv",
        "args": ["run", "--project", str(ROOT), "--all-packages", "--frozen", "python"]
        + [str(ROOT / "demo" / "archive_mcp.py")],
        "env": {"XDG_CONFIG_HOME": str(support / "config"), "BROWSER": str(opener)},
    }
    (plugin / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"cruise": server}}, indent=2) + "\n", "utf-8"
    )
    # The stage as the plugin's saved archive, written by the plugin's own connect, in a
    # config folder of the recording's own.
    from archive_agent import server as plugin_server
    from archive_agent.state import Session

    os.environ["XDG_CONFIG_HOME"] = str(support / "config")
    plugin_server.connect(Session(), site)
    opener.parent.mkdir()
    node = shutil.which("node")
    if node is None:
        raise Failed("node is not installed")
    commands = {
        opener: OPEN_SIGN_IN.format(
            node=node, script=ROOT / "demo" / "agent-signin.mjs", log=support / "sign-in.log"
        ),
        support / "bin" / "cruise-agent": AGENT.format(work=work, plugin=plugin),
    }
    for path, text in commands.items():
        path.write_text(text, "utf-8")
        path.chmod(0o755)


# The stage.


def password() -> str:
    """A throwaway password that meets Cognito's default policy."""
    return secrets.token_urlsafe(24) + "aA1!"


def account(cognito: Any, pool: str, email: str, groups: list[str]) -> str:
    """Make the account if it is missing, and give it a new permanent password and its groups."""
    try:
        cognito.admin_get_user(UserPoolId=pool, Username=email)
    except cognito.exceptions.UserNotFoundException:
        cognito.admin_create_user(
            UserPoolId=pool,
            Username=email,
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "email_verified", "Value": "true"},
            ],
            MessageAction="SUPPRESS",
        )
    secret = password()
    cognito.admin_set_user_password(
        UserPoolId=pool, Username=email, Password=secret, Permanent=True
    )
    for group in groups:
        cognito.admin_add_user_to_group(UserPoolId=pool, Username=email, GroupName=group)
    return secret


def id_token(cognito: Any, pool: str, client: str, email: str, secret: str) -> str:
    """The account's ID token, by password through the stage's test client (`e2e`), as
    `just ingest-e2e` signs its users in. The API's authorizer takes it as it takes the web
    app's."""
    result = cognito.admin_initiate_auth(
        UserPoolId=pool,
        ClientId=client,
        AuthFlow="ADMIN_USER_PASSWORD_AUTH",
        AuthParameters={"USERNAME": email, "PASSWORD": secret},
    )
    return str(result["AuthenticationResult"]["IdToken"])


def get_json(url: str) -> tuple[int, Any]:
    status, raw = seed.http_send("GET", url, {}, None)
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, None


def published(domain: str) -> dict[str, str]:
    """Each dataset search finds, as title: id."""
    status, answer = get_json(f"https://{domain}/api/search?size=100")
    if status != 200 or not isinstance(answer, dict):
        raise Failed(f"/api/search answered {status}")
    return {str(row.get("title")): str(row.get("id")) for row in answer.get("rows", [])}


def seeder(domain: str, token: str) -> seed.Seed:
    return seed.Seed(
        domain, token, seed.http_send, time.sleep, time.monotonic, POLL_SECONDS, WAIT_SECONDS
    )


def publish_samples(domain: str, token: str) -> None:
    """Publish each sample package the stage doesn't hold, then wait for search to list all."""
    titles = {
        folder: str(json.loads((folder / "datapackage.json").read_text("utf-8"))["title"])
        for folder in seed.sample_packages()
    }
    held = published(domain)
    as_curator = seeder(domain, token)
    for folder, title in titles.items():
        if title in held:
            print(f"{folder.name}: already published")
            continue
        print(f"{folder.name}:")
        try:
            print(as_curator.follow(as_curator.submit(folder)))
        except seed.Failed as error:
            raise Failed(str(error)) from error
    deadline = time.monotonic() + WAIT_SECONDS
    while missing := set(titles.values()) - set(published(domain)):
        if time.monotonic() >= deadline:
            raise Failed(f"search still doesn't list {sorted(missing)}")
        time.sleep(POLL_SECONDS)


def decide(domain: str, curator_token: str, sid: str, decision: str) -> None:
    status, raw = seed.http_send(
        "POST",
        f"https://{domain}/api/submissions/{urllib.parse.quote(sid, safe='')}/decision",
        {"Authorization": curator_token, "content-type": "application/json"},
        json.dumps({"decision": decision, "note": EARLIER}).encode(),
    )
    if status not in (200, 202):
        raise Failed(f"the {decision} of submission {sid} answered {status}: {raw[:300]!r}")


def clear_queue(domain: str, curator_token: str) -> None:
    """Reject every submission an earlier take left waiting for a curator, so this take's
    review queue holds its own two and nothing else."""
    as_curator = seeder(domain, curator_token)
    for waiting in as_curator.call("GET", "?status=in-review")["submissions"]:
        decide(domain, curator_token, str(waiting["submissionId"]), "reject")
        print(f"rejected {waiting.get('datasetId')}, an earlier take's submission")


def free_plot_id(domain: str, curator_token: str) -> str:
    """The id this take's plot survey is published under: `plot-survey`, or after an earlier
    take on the same stage `plot-survey-2` and so on. An earlier take's dataset is withdrawn
    first, so Browse opens on the six sample datasets again. It is found by its id: its title
    is the one the agent drafted in that take."""

    def earlier() -> list[str]:
        return [i for i in published(domain).values() if i.startswith("plot-survey")]

    for dataset in earlier():
        status, raw = seed.http_send(
            "POST",
            f"https://{domain}/api/admin/datasets/{urllib.parse.quote(dataset, safe='')}/withdraw",
            {"Authorization": curator_token, "content-type": "application/json"},
            json.dumps({"reason": EARLIER}).encode(),
        )
        if status != 200:
            raise Failed(f"withdrawing {dataset} answered {status}: {raw[:300]!r}")
        print(f"withdrew {dataset}, an earlier take's dataset")
    deadline = time.monotonic() + WAIT_SECONDS
    while left := earlier():
        if time.monotonic() >= deadline:
            raise Failed(f"search still lists {left} after its withdrawal")
        time.sleep(POLL_SECONDS)
    for number in range(1, 50):
        candidate = "plot-survey" if number == 1 else f"plot-survey-{number}"
        status, _ = get_json(f"https://{domain}/api/datasets/{candidate}")
        if status == 404:
            return candidate
    raise Failed("no free plot-survey id; destroy the stage and deploy it again")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("stage", nargs="?")
    parser.add_argument(
        "--packages-only",
        type=Path,
        metavar="FOLDER",
        help="build the two package folders in FOLDER, which must be empty, and stop",
    )
    args = parser.parse_args(argv)
    if args.packages_only:
        args.packages_only.mkdir(parents=True, exist_ok=True)
        print(json.dumps(build_packages(args.packages_only.resolve()), indent=2))
        return 0
    if not args.stage:
        parser.error("name the stage, or give --packages-only")

    import boto3

    stack = boto3.client("cloudformation").describe_stacks(
        StackName=f"ResearchArchive-{args.stage}"
    )["Stacks"][0]
    outputs = {o["OutputKey"]: o["OutputValue"] for o in stack.get("Outputs", [])}
    missing = {"E2eClientId", "UserPoolId", "SiteDomain"} - outputs.keys()
    if missing:
        print(
            f"ResearchArchive-{args.stage} has no {', '.join(sorted(missing))} output; "
            "demo-video needs a stage with keepData: false in its config"
        )
        return 2
    domain, pool, client = outputs["SiteDomain"], outputs["UserPoolId"], outputs["E2eClientId"]
    cognito = boto3.client("cognito-idp")
    try:
        accounts = {}
        tokens = {}
        for role, (email, groups) in ACCOUNTS.items():
            secret = account(cognito, pool, email, groups)
            accounts[role] = {"email": email, "password": secret}
            tokens[role] = id_token(cognito, pool, client, email, secret)
            print(f"{email}: ready ({', '.join(groups)})")
        publish_samples(domain, tokens["curator"])
        clear_queue(domain, tokens["curator"])
        plot_id = free_plot_id(domain, tokens["curator"])
        # Under /tmp, not the laptop user's own temporary folder, since Claude Code and the
        # plugin's dialog show the path; and the realpath, as /tmp is behind a symlink on macOS.
        work = Path(tempfile.mkdtemp(prefix="demo-video-", dir="/tmp")).resolve()
        folders = build_packages(work, plot_id)
        build_agent(work, f"https://{domain}")
    except (Failed, seed.Failed, OSError) as error:
        print(error)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    run = OUT / "run.json"
    run.touch(mode=0o600)
    run.chmod(0o600)
    run.write_text(
        json.dumps(
            {
                "site": f"https://{domain}",
                "accounts": accounts,
                "plotId": plot_id,
                "snowTitle": SNOW_TITLE,
                **folders,
            },
            indent=2,
        )
        + "\n",
        "utf-8",
    )
    print(f"wrote {run.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
