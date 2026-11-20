"""The cruise plugin's MCP server for the agent scene of the demo video: this checkout's
`archive-mcp`, with its sign-in listening on any free port.

The plugin's own `.mcp.json` fetches a released tag; the recording runs the server from the
checkout, so the video shows the code beside it. The sign-in's fixed port (8765) is left to
whatever else on the recording laptop may hold it; the archive's sign-in page takes any port.
"""

from functools import partial

from archive_agent.server import build
from archive_agent.state import Session
from archive_client.signin import sign_in

if __name__ == "__main__":
    build(Session(sign_in=partial(sign_in, port=0))).run("stdio")
