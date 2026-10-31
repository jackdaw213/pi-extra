# session-name

Names new pi sessions automatically. On the first real message of an unnamed
session it asks the cheap local glm53 model for a 3-6 word title and sets it.

Fire-and-forget: never delays the run, never announces failure. If the model
call fails or the reply is unusable, the title falls back to the first words
of the prompt. One attempt per session; a session that already has a name
(/name, resume) is left alone. Re-armed by /new.

## Install

    ln -sfn ~/GitHub/pi-extra/session-name ~/.pi/agent/extensions/session-name
