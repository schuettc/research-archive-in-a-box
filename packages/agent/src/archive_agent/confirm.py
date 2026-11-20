"""The dialog submit and decide show the person before anything is sent.

The dialog comes from the plugin by MCP elicitation, so only the person can answer it.
"""

from typing import Any

from mcp.server.mcpserver import Context, ElicitationResult
from pydantic import BaseModel

from archive_agent import submit
from archive_agent.errors import NotConfirmed

NO_DIALOG = (
    "{tool} asks the person in a dialog before anything is sent, and this client can't show "
    "one, so nothing was sent. Submitting and deciding need an interactive session."
)
NOT_ACCEPTED = (
    "The person didn't accept the dialog, so nothing was sent to {archive}. "
    "Don't call this again unless they ask."
)


class Yes(BaseModel):
    """The dialog's form: nothing to fill in. Accepting it is the yes."""


def require_dialog(ctx: Context[Any, Any], tool: str) -> None:
    """Refuse when this client can't show a dialog with a form."""
    if ctx.protocol_version is not None:
        capabilities = ctx.client_capabilities
        elicitation = capabilities.elicitation if capabilities is not None else None
        if elicitation is not None and (elicitation.form is not None or elicitation.url is None):
            return
    raise NotConfirmed(NO_DIALOG.format(tool=tool))


def accepted(answer: ElicitationResult[Yes], archive: str) -> None:
    """Refuse unless the person accepted the dialog."""
    if answer.action != "accept":
        raise NotConfirmed(NOT_ACCEPTED.format(archive=archive))


def submit_question(package: submit.Package, submission: str | None) -> str:
    """What submit's dialog says: the files, their size, the folder and the archive."""
    what = f"Send {len(package.files)} files ({package.total:,} bytes) from {package.root}"
    if submission is None:
        return f"{what} to {package.archive} for review?"
    return f"{what} to {package.archive} as the next round of submission {submission}?"


def decide_question(archive: str, id: str, decision: str, note: str) -> str:
    """What decide's dialog says: the archive, the submission, the decision and its note."""
    lines = [
        f"Post this decision on submission {id} at {archive}?",
        f"Decision: {decision}",
        f"Note: {note or '(none)'}",
    ]
    if decision == "approve":
        lines.append("An approval publishes the dataset.")
    return "\n".join(lines)
