Remove agents you own from the session roster. Pass exactly one selector: `ids`, `names`, or `all: true` to dismiss every agent you own.

A running agent is shut down before it is removed. A ghost entry — metadata without a live agent — is only unregistered.

`main`, yourself, and agents you do not own are refused. Dismissing is destructive control, not a message: it is not auto-approved, and it is blocked in plan mode. Every id is validated before anything is removed, so a rejected call removes nothing.
