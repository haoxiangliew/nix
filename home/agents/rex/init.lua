-- Rex's configuration. home/agents/default.nix links this directory's files into ~/.config/rex.

-- Worktrees… in the command palette opens, makes, and removes git worktrees as tabs.
require("worktree")
-- Resumes coding agents in their panes after the Rex server restarts.
require("agent_resume")
