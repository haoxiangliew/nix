-- Rex's configuration. home/agents/default.nix links this directory's files into ~/.config/rex.

-- Worktrees… in the command palette opens, makes, and removes git worktrees as tabs.
require("worktree")

-- Lets Rex resume pi sessions after the server restarts.
rex.set("resume.trust.pi", { command = { "pi", "--session", rex.match.uuid } })
