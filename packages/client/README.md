# archive-client

The client signs a person in to an archive from a terminal. It opens the archive's own sign-in page in the browser, where the person signs in as they do on the site and presses **Sign in the command line**. The page then posts the sign-in's tokens, which last about an hour, to the client's listener on `http://localhost:8765/callback`, and the client checks the post came from the sign-in it started. Nothing is saved to disk.

Who uses it: the Claude Code plugin's `sign_in` tool, and the recipes that act as an admin, `just seed` and `just set-embargo`.

It has no command of its own; code calls it:

```python
from archive_client.signin import AuthConfig, sign_in

tokens = sign_in(AuthConfig(site="https://data.example.org"))
```
