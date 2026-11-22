Remove agents in your subtree from the session roster. Pass exactly one selector: `ids`, `names`, or `all: true` to dismiss every agent in your subtree.

Dismissing an agent also dismisses its whole subtree, children first, so no agent is left orphaned. A running agent is shut down before it is removed. A ghost entry — metadata without a live agent — is only unregistered.

`main`, yourself, and agents outside your subtree are refused. Dismissing is destructive control, not a message: it is not auto-approved, and it is blocked in plan mode. Every id is validated before anything is removed, so a rejected call removes nothing.
