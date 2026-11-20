# The terminal scene of the demo video, for VHS (https://github.com/charmbracelet/vhs).
# `just demo-video` runs it in the temporary folder demo/setup.py built, with that folder's
# bin/ (a `cruise` that runs this checkout's) first on PATH. The shell's prompt is VHS's own
# "> ", so no user name or folder shows.
Output terminal.mp4

Set Shell "bash"
Set FontSize 16
Set Width 1280
Set Height 800
Set Padding 28
Set Framerate 30
Set TypingSpeed 45ms
Set Theme { "name": "demo", "black": "#1f2430", "red": "#f07178", "green": "#a6cc70", "yellow": "#ffcc66", "blue": "#73b8ff", "magenta": "#d4bfff", "cyan": "#95e6cb", "white": "#d9d7ce", "brightBlack": "#707a8c", "brightRed": "#f28779", "brightGreen": "#bae67e", "brightYellow": "#ffd580", "brightBlue": "#73d0ff", "brightMagenta": "#d4bfff", "brightCyan": "#95e6cb", "brightWhite": "#ffffff", "background": "#1f2430", "foreground": "#d9d7ce", "selection": "#33415e", "cursor": "#ffcc66" }

Sleep 600ms
Type "cruise diagnose plot-survey"
Sleep 400ms
Enter
Sleep 6s
Screenshot demo-cruise-diagnose.png
Sleep 500ms
Type `cruise set plot-survey title "Canopy cover and stem counts on four forest plots"`
Sleep 400ms
Enter
Sleep 2.5s
Type "cruise diagnose plot-survey"
Sleep 400ms
Enter
Sleep 5s
