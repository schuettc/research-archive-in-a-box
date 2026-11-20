# The agent scene of the demo video, for VHS (https://github.com/charmbracelet/vhs): a real
# Claude Code session with the cruise plugin. `just demo-video` runs it in the temporary folder
# demo/setup.py built, with that folder's .demo/bin first on PATH. VHS types the person's
# lines; every reply is Claude's own and differs from take to take, so the tape waits on what
# the screen shows: the footer's "(shift+tab to cycle)" ends the last line only while Claude
# Code waits for the person.
#
# The window is 108 px taller than the video. Claude Code's first lines name the version, the
# model and plan, and the folder; demo/assemble.mjs cuts those 108 px off the top, so nothing
# of the laptop's Claude account is in the video.
Output agent.mp4

Set Shell "bash"
Set FontSize 16
Set Width 1280
Set Height 908
Set Padding 28
Set Framerate 30
Set TypingSpeed 45ms
Set WaitTimeout 4m
Set Theme { "name": "demo", "black": "#1f2430", "red": "#f07178", "green": "#a6cc70", "yellow": "#ffcc66", "blue": "#73b8ff", "magenta": "#d4bfff", "cyan": "#95e6cb", "white": "#d9d7ce", "brightBlack": "#707a8c", "brightRed": "#f28779", "brightGreen": "#bae67e", "brightYellow": "#ffd580", "brightBlue": "#73d0ff", "brightMagenta": "#d4bfff", "brightCyan": "#95e6cb", "brightWhite": "#ffffff", "background": "#1f2430", "foreground": "#d9d7ce", "selection": "#33415e", "cursor": "#ffcc66" }

# Off camera: start Claude Code and say the new temporary folder is trusted.
Hide
Type "cruise-agent"
Enter
Wait+Screen /Yes, I trust this folder/
Sleep 500ms
Down
Sleep 300ms
Enter
Wait+Screen /cycle\)( . . for agents)?\s*$/
Sleep 4s
Show

Sleep 1200ms
Type "Check the plot-survey package for me."
Sleep 500ms
Enter
Sleep 3s
Wait+Screen /cycle\)\s*$/
Sleep 1500ms
Screenshot demo-agent-session.png
Sleep 2500ms

Type "Yes, use that title."
Sleep 500ms
Enter
Sleep 3s
Wait+Screen /cycle\)\s*$/
Sleep 3s

# The plugin signs in on the archive's sign-in page, which demo/agent-signin.mjs drives off
# camera, and then asks the person itself before anything is sent.
Type "Sign me in and submit it."
Sleep 500ms
Enter
Wait+Screen /requests your input/
Sleep 3s
Enter
Sleep 3s
Wait+Screen /cycle\)\s*$/
Sleep 4s
