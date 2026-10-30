-- Git worktrees as Rex tabs.
--
-- A worktree tab is a window that worktree_open made for a worktree. Rex keeps no data on a window,
-- so a state file maps each such window to its worktree. Any tab can still cd into a worktree; only
-- the ones this file opened count as its tab.
--
-- init.lua requires this file for the command palette. Agents run it as a script instead, as in
-- `rex do ~/.config/rex/worktree.lua --action worktree_open branch=x`, because an action from the
-- configuration file gets 30 seconds, and `git worktree add` can take longer in a big repository.
--
-- worktree.json beside this file sets `directory`, where new worktrees go, as
-- <directory>/<repository>/<branch>, and `git`, the git to run. REX_WORKTREES_DIR overrides
-- `directory`, as tests do. The Rex server's PATH is only the system's, so `git` matters there.

local shared = require("lib.shared")
local worktree_tabs = require("lib.worktree_tabs")

local TERMINAL, SHELL, STATE_DIR = shared.TERMINAL, shared.SHELL, shared.STATE_DIR
local fail, expand, trim, basename = shared.fail, shared.expand, shared.trim, shared.basename
local tildify, within, exec, exists = shared.tildify, shared.within, shared.exec, shared.exists
local read_json, realpath, slug = shared.read_json, shared.realpath, shared.slug
local with_lock = shared.with_lock
local call, attach, in_session, viewer = shared.call, shared.attach, shared.in_session, shared.viewer
local window_of_block = shared.window_of_block
local block_cwd, context = shared.block_cwd, shared.context
local load_state, with_state = worktree_tabs.load_state, worktree_tabs.with_state
local open_tabs = worktree_tabs.open_tabs

local DEFAULT_DIR = "~/Developer/.rex/worktrees"

-- How long a call waits for another on the same worktree, which git has up to 10 minutes to create,
-- checking every half second.
local WORKTREE_WAIT = { seconds = 660, poll = 0.5 }

-- worktree_remove exits a script with this when the worktree has uncommitted changes, so callers
-- can tell that refusal from other errors.
local DIRTY_EXIT = 10

local SELF = shared.source_path("worktree.lua")

local SETTINGS = SELF:match("^(.*)/[^/]+$") .. "/worktree.json"

-- What a tab's label starts with.
local MARK = "⎇ "

-- worktree.json, read once per action. Each action starts without it, so a changed file applies to
-- the next action without a reload.
local settings = nil

local function setting(key)
  if settings == nil then
    settings = read_json(SETTINGS) or {}
  end

  local value = settings[key]

  if value ~= nil and (type(value) ~= "string" or value == "") then
    fail(("`%s` in %s must be a non-empty string."):format(key, tildify(SETTINGS)))
  end

  return value
end

local function directory()
  local from_env = os.getenv("REX_WORKTREES_DIR")

  if from_env ~= nil and from_env ~= "" then
    return expand(from_env)
  end

  return expand(setting("directory") or DEFAULT_DIR)
end

-- git's output, or an error with what it printed.
local function git(cwd, args, timeout)
  local argv = { setting("git") or "git", "-C", cwd }

  for _, arg in ipairs(args) do
    argv[#argv + 1] = arg
  end

  local result = exec(argv, { timeout = timeout or 20 })

  if not result.ok then
    local why = trim(result.stderr ~= "" and result.stderr or result.stdout)

    fail(("git %s in %s failed: %s"):format(args[1], tildify(cwd), why))
  end

  return trim(result.stdout)
end

-- The repository's worktrees, main checkout first, with real paths.
local function worktrees(cwd)
  local list, current = {}, nil

  -- With -z, each field ends in NUL, so a path can hold any character, even a newline.
  local porcelain = git(cwd, { "worktree", "list", "--porcelain", "-z" })
  local start = 1

  while start <= #porcelain do
    local stop = porcelain:find("\0", start, true) or (#porcelain + 1)
    local field = porcelain:sub(start, stop - 1)
    local path = field:match("^worktree (.+)$")
    local branch = field:match("^branch refs/heads/(.+)$")

    start = stop + 1

    if path ~= nil then
      current = { path = path, main = #list == 0 }
      list[#list + 1] = current
    elseif branch ~= nil and current ~= nil then
      current.branch = branch
    elseif field == "bare" and current ~= nil then
      current.bare = true
    end
  end

  for _, worktree in ipairs(list) do
    if exists(worktree.path) then
      worktree.path = realpath(worktree.path)
    end
  end

  return list
end

-- The lock that creating, opening, and removing one worktree take, so they don't overlap. It's
-- named by the repository and the branch, or the path for a worktree without one.
local function worktree_lock(main_path, name)
  return ("%s/worktree.%s.%s.lock"):format(STATE_DIR, slug(main_path), slug(name))
end

local function resolve_session(name, default)
  if name == nil or name == "" then
    return default
  end

  local resolved = call("target.resolve", { kinds = { "session" }, queries = { name } }).results[1]

  if resolved.status ~= "resolved" then
    fail(("No single Rex session matches `%s` (%s)."):format(name, resolved.status))
  end

  return resolved.target.session_id
end

local function base_cwd(args, ctx)
  local session_id, block_id = context(ctx)
  local cwd = args.cwd and expand(args.cwd) or block_cwd(session_id, block_id)

  if cwd == nil then
    fail("Pass `cwd`, a directory in the repository.")
  end

  return realpath(cwd)
end

-- Finding worktrees

-- The worktree that args.path or args.branch names, with the repository's worktrees. A path is
-- listed from itself, so it can be in another repository.
local function locate(args, ctx)
  if args.path ~= nil and args.branch ~= nil then
    fail("Pass `path` or `branch`, not both.")
  end

  if args.path ~= nil and args.base ~= nil then
    fail("`base` starts a new branch, so it needs `branch`, not `path`.")
  end

  if args.path == nil and args.branch == nil then
    fail("Pass `branch` for a new or existing worktree, or `path` for an existing one.")
  end

  if args.path ~= nil then
    local path = realpath(expand(args.path))
    local list = worktrees(path)

    for _, worktree in ipairs(list) do
      if worktree.path == path then
        return worktree, list, path
      end
    end

    fail(("%s isn't a worktree of its repository."):format(tildify(path)))
  end

  local cwd = base_cwd(args, ctx)
  local list = worktrees(cwd)

  for _, worktree in ipairs(list) do
    if worktree.branch == args.branch then
      return worktree, list, cwd
    end
  end

  return nil, list, cwd
end

local function branch_exists(cwd, ref)
  return exec({ setting("git") or "git", "-C", cwd, "show-ref", "--verify", "--quiet", ref }).ok
end

-- A remote branch with the same name, such as a PR's, gets a local branch that tracks it. origin
-- wins over other remotes.
local function remote_branch(cwd, branch)
  local remotes = {}
  local names = git(cwd, { "remote" }) .. "\n"

  for remote in names:gmatch("([^\n]+)\n") do
    table.insert(remotes, remote == "origin" and 1 or #remotes + 1, remote)
  end

  for _, remote in ipairs(remotes) do
    if branch_exists(cwd, ("refs/remotes/%s/%s"):format(remote, branch)) then
      return remote .. "/" .. branch
    end
  end

  return nil
end

-- Why a new worktree's path is taken: by a repository with the same name, or by a branch of this
-- one whose name makes the same folder, such as `feat/x` and `feat-x`.
local function taken(path, main_path)
  local program = setting("git") or "git"
  local args = { "rev-parse", "--path-format=absolute", "--git-common-dir" }
  local ours = git(main_path, args)
  local theirs = exec({ program, "-C", path, args[1], args[2], args[3] })

  if not theirs.ok or trim(theirs.stdout) ~= ours then
    return table.concat({
      ("%s already exists, and isn't part of this repository."):format(tildify(path)),
      "Another repository with the same name can have made it.",
      ("Pick another branch, or another `directory` in %s."):format(tildify(SETTINGS)),
    }, " ")
  end

  local on = git(path, { "branch", "--show-current" })

  return ("%s already exists, checked out on `%s`. Open it with `path`, or pick another branch."):format(
    tildify(path),
    on
  )
end

local function create(list, cwd, branch, base)
  local main = list[1]

  if main.bare then
    fail("Bare repositories aren't supported.")
  end

  local path = ("%s/%s/%s"):format(directory(), basename(main.path), slug(branch))

  if exists(path) then
    fail(taken(path, main.path))
  end

  if branch_exists(cwd, "refs/heads/" .. branch) then
    if base ~= nil then
      fail(("Branch `%s` already exists, so it can't start from `%s`."):format(branch, base))
    end

    git(main.path, { "worktree", "add", path, branch }, 600)
  else
    local tracked = base == nil and remote_branch(cwd, branch) or nil

    if tracked then
      git(main.path, { "worktree", "add", "--track", "-b", branch, path, tracked }, 600)
    else
      -- Resolved at cwd, so the default HEAD is the commit there, not the main checkout's.
      local commit = git(cwd, { "rev-parse", "--verify", (base or "HEAD") .. "^{commit}" })

      git(main.path, { "worktree", "add", "-b", branch, path, commit }, 600)
    end
  end

  return { path = realpath(path), branch = branch, main = false }
end

-- Switches the app to a tab in another session, which needs a client, and from the CLI, Remote
-- Control. rex.client.queue raises when it can't, so its error gets what was opened.
local function select(session_id, window_id, from_session)
  if session_id == from_session then
    return
  end

  local ok, err = pcall(rex.client.queue, "session.select", {
    session_id = session_id,
    window_id = window_id,
  })

  if not ok then
    fail(
      ("Opened tab %s in session %s, but the app didn't switch to it: %s"):format(
        window_id,
        session_id,
        tostring(err)
      )
    )
  end
end

local function pane(worktree, args)
  local options = { cwd = worktree.path }

  if args.command ~= nil then
    options.command = args.command
  end

  return { block = { flavor = SHELL, label = args.label, options = options } }
end

-- The tab of path to use: one in session_id if there is one, else any.
local function tab_for(tabs, path, session_id)
  local tab = nil

  for _, open_tab in ipairs(tabs[path] or {}) do
    if tab == nil or open_tab.session_id == session_id then
      tab = open_tab
    end
  end

  return tab
end

-- Splits like pi's rex_start: right when both halves keep 100 columns, down when they keep 15 rows.
-- That needs the tab's real size, which only a session the user sees has, so it's measured only in
-- the caller's session. A session no app shows reports 80x24, so a tab there splits right.
local function split_direction(tab, from_session)
  if tab.session_id ~= from_session or tab.focused_block_id == nil then
    return "horizontal"
  end

  local where = { session_id = tab.session_id, block_id = tab.focused_block_id }
  local size, err = rex.block.call(TERMINAL, "size", where)

  if size == nil then
    fail(("Looking up the size of pane %s failed: %s"):format(tab.focused_block_id, tostring(err)))
  end

  if size.columns / 2 >= 100 then
    return "horizontal"
  end

  if size.rows / 2 >= 15 then
    return "vertical"
  end

  fail(
    ("Pane %s in the worktree's tab is %dx%d, too small to split again."):format(
      tab.focused_block_id,
      size.columns,
      size.rows
    )
  )
end

-- Opens a pane in the worktree's open tab, or focuses it, or opens a new tab. The state is locked
-- meanwhile, so two calls don't both open a tab.
local function show(worktree, args, session_id, from_session)
  return with_state(function(state)
    local tabs, pruned = open_tabs(state, viewer())
    local tab = tab_for(tabs, worktree.path, session_id)

    if tab ~= nil then
      local shown = { session_id = tab.session_id, window_id = tab.window_id, tab = "existing" }

      -- A command gets its own pane in the tab.
      if args.command ~= nil then
        shown.block_id = in_session("session.new_split", {
          session_id = tab.session_id,
          window_id = tab.window_id,
          direction = split_direction(tab, from_session),
          side = "after",
          focus = args.focus == true,
          layout = pane(worktree, args),
        }).block_ids[1]
      elseif args.focus == true then
        in_session("session.focus_window", { session_id = tab.session_id, window_id = tab.window_id })
      end

      return shown, pruned
    end

    local window = in_session("session.new_window", {
      session_id = session_id,
      window_label = MARK .. (worktree.branch or basename(worktree.path)),
      focus = args.focus == true,
      layout = pane(worktree, args),
    })

    state.windows[window.window_id] = {
      session_id = session_id,
      path = worktree.path,
      branch = worktree.branch,
    }

    local shown = {
      session_id = session_id,
      window_id = window.window_id,
      block_id = window.block_ids[1],
      tab = "new",
    }

    return shown, true
  end)
end

-- Actions

-- fzf over the repository's worktrees, in a floating pane. Enter opens one, a query that matches
-- none makes a branch of that name, and ctrl-x removes one.
local PICKER = [[
self=$1
cd "$2" || exit 1
command -v fzf >/dev/null || { echo "fzf isn't installed."; read -r _; exit 1; }
list=$(git worktree list --porcelain | awk '
  /^worktree / { path = substr($0, 10); branch = "(detached)" }
  /^branch / { branch = substr($0, 8); sub("^refs/heads/", "", branch) }
  /^$/ && path != "" { print branch "\t" path; path = "" }
  END { if (path != "") print branch "\t" path }')
out=$(printf '%s\n' "$list" | fzf --print-query --expect=ctrl-x --delimiter='\t' \
  --prompt='worktree> ' --header='enter: open · new name + enter: create · ctrl-x: remove')
# Esc or ctrl-c
[ $? -ge 128 ] && exit 0
query=$(printf '%s\n' "$out" | sed -n 1p)
key=$(printf '%s\n' "$out" | sed -n 2p)
path=$(printf '%s\n' "$out" | sed -n 3p | cut -f2-)
if [ -n "$path" ] && [ "$key" = ctrl-x ]; then
  set -- rex do "$self" --action worktree_remove path="$path" keep_caller=false
elif [ -n "$path" ]; then
  set -- rex do "$self" --action worktree_open path="$path" focus=true
elif [ -n "$query" ]; then
  set -- rex do "$self" --action worktree_open branch="$query" cwd="$PWD" focus=true
else
  exit 0
fi
echo "$*"
"$@" >/dev/null || { printf 'Press enter to close.'; read -r _; }
]]

local function pick(ctx, args)
  local cwd = base_cwd(args, ctx)

  shared.float_script(ctx, "worktrees", cwd, PICKER, { SELF, cwd })
end

local function open(ctx, args)
  -- The command palette passes no arguments, so it gets the picker. Only scripts have rex.after, so
  -- a script, such as an agent's call, still has to name the worktree.
  if args.branch == nil and args.path == nil and rex.after == nil then
    return pick(ctx, args)
  end

  -- Resolve the session and worktree first, so a bad argument fails before git creates anything.
  local from_session = context(ctx)
  local session_id = resolve_session(args.session, from_session)
  local worktree, list, cwd = locate(args, ctx)
  local name = args.branch or worktree.branch or worktree.path

  -- Another call can create or remove the worktree meanwhile, so it's looked up again under its
  -- lock.
  local shown = with_lock(worktree_lock(list[1].path, name), WORKTREE_WAIT, function()
    local found, again = locate(args, ctx)
    local created = found == nil

    if created then
      found = create(again, cwd, args.branch, args.base)
    elseif args.base ~= nil then
      fail(
        ("Branch `%s` already has a worktree at %s, so it can't start from `%s`."):format(
          args.branch,
          tildify(found.path),
          args.base
        )
      )
    end

    local result = show(found, args, session_id, from_session)

    result.path = found.path
    result.branch = found.branch
    result.created = created

    return result
  end)

  if args.focus == true then
    select(shown.session_id, shown.window_id, from_session)
  end

  return shown
end

-- A script exits with DIRTY_EXIT. An action from the configuration can only fail.
local function refuse_dirty(path)
  local message = ("%s has uncommitted changes. Commit them, or pass `force` to discard them."):format(
    tildify(path)
  )

  if rex.stop == nil then
    fail(message)
  end

  io.stderr:write("Error: " .. message .. "\n")
  rex.stop(DIRTY_EXIT)
end

-- Refuses when the caller runs in one of the worktree's tabs or directories, since removing the
-- worktree would end it.
local function guard_caller(ctx, worktree, own)
  local session_id, block_id = context(ctx)

  if block_id == nil then
    return
  end

  local tabs = with_state(function(state)
    local all, pruned = open_tabs(state, viewer())

    return all[worktree.path] or {}, pruned
  end)

  for _, tab in ipairs(tabs) do
    if own ~= nil and own.window_id == tab.window_id then
      fail("You run in that worktree's tab, so removing it would end you.")
    end
  end

  local cwd = block_cwd(session_id, block_id)

  if cwd == nil then
    fail(
      ("Rex doesn't know pane %s's directory, so it can't tell whether it's in %s."):format(
        block_id,
        tildify(worktree.path)
      )
    )
  end

  -- worktree.path has symlinks resolved, and a directory a shell reported may not.
  if within(cwd, worktree.path) or (exists(cwd) and within(realpath(cwd), worktree.path)) then
    fail(("You run in %s, so removing it would remove your own directory."):format(tildify(cwd)))
  end
end

-- Closes tabs, the caller's own last, since closing it ends the call. Returns why each tab that
-- didn't close failed.
local function close_tabs(tabs, own)
  local ordered, last = {}, nil

  for _, tab in ipairs(tabs) do
    if own ~= nil and tab.window_id == own.window_id then
      last = tab
    else
      ordered[#ordered + 1] = tab
    end
  end

  ordered[#ordered + 1] = last

  local failed = {}

  for _, tab in ipairs(ordered) do
    local ok, err = attach(tab.session_id)

    if ok then
      ok, err = rex.call("session.close_window", { session_id = tab.session_id, window_id = tab.window_id })
    end

    if not ok then
      failed[#failed + 1] = ("%s: %s"):format(tab.window_id, tostring(err))
    end
  end

  return failed
end

local function remove_locked(ctx, args)
  local worktree, list = locate(args, ctx)

  if worktree == nil then
    fail(("No worktree has branch `%s`."):format(args.branch))
  end

  if worktree.main then
    fail(("%s is the repository's main checkout, which isn't removed."):format(tildify(worktree.path)))
  end

  local session_id, block_id = context(ctx)
  local own = window_of_block(viewer()(session_id), block_id)

  if args.keep_caller ~= false then
    guard_caller(ctx, worktree, own)
  end

  if args.force ~= true and git(worktree.path, { "status", "--porcelain" }) ~= "" then
    return { dirty = worktree.path }
  end

  local remove_args = { "worktree", "remove" }

  if args.force == true then
    remove_args[#remove_args + 1] = "--force"
  end

  remove_args[#remove_args + 1] = worktree.path

  -- Removed before its tabs close, since the caller can be in one of them, as the picker is.
  git(list[1].path, remove_args, 120)

  -- A tab that closes leaves the state the next time it's read, and one that doesn't keeps its
  -- entry.
  local closing = with_state(function(state)
    local all, pruned = open_tabs(state, viewer())
    local tabs = all[worktree.path] or {}

    return { count = #tabs, failed = close_tabs(tabs, own) }, pruned
  end)

  if #closing.failed > 0 then
    fail(
      ("Removed %s, but couldn't close %d of its tabs: %s"):format(
        tildify(worktree.path),
        #closing.failed,
        table.concat(closing.failed, "; ")
      )
    )
  end

  return { path = worktree.path, branch = worktree.branch, closed_tabs = closing.count }
end

-- Looks the worktree up again under its lock, since another call can remove or recreate it.
local function remove(ctx, args)
  local worktree, list = locate(args, ctx)

  if worktree == nil then
    fail(("No worktree has branch `%s`."):format(args.branch))
  end

  local key = worktree_lock(list[1].path, worktree.branch or worktree.path)

  local removed = with_lock(key, WORKTREE_WAIT, function()
    return remove_locked(ctx, args)
  end)

  -- Refused only now, since rex.stop ends the script without letting with_lock release the lock.
  if removed.dirty ~= nil then
    refuse_dirty(removed.dirty)
  end

  return removed
end

local function list_worktrees(ctx, args)
  local cwd = base_cwd(args, ctx)

  local tabs = with_state(function(state)
    return open_tabs(state, viewer())
  end)

  local rows = {}
  local list = worktrees(cwd)

  for _, worktree in ipairs(list) do
    rows[#rows + 1] = {
      path = worktree.path,
      branch = worktree.branch,
      main = worktree.main,
      tabs = tabs[worktree.path],
    }
  end

  return { worktrees = rows }
end

-- The worktree whose tab is the active one.
local function current(ctx)
  local session_id, block_id = context(ctx)
  local window = window_of_block(viewer()(session_id), block_id)
  local entry = window and load_state().windows[window.window_id]

  if entry == nil then
    fail("This tab isn't a worktree tab.")
  end

  return entry
end

-- An action's run function, with worktree.json read afresh.
local function fresh(run)
  return function(ctx, args)
    settings = nil

    return run(ctx, args)
  end
end

rex.action({
  name = "worktree_open",
  title = "Worktrees…",
  category = "Worktrees",
  description = "Pick a worktree of this pane's repository to open, create, or remove. With a branch or path, open that worktree in a tab, making it first when the branch has none.",
  keywords = "git branch checkout",
  args = {
    branch = "string?",
    base = "string?",
    path = "string?",
    cwd = "string?",
    session = "string?",
    label = "string?",
    command = "array?",
    focus = "boolean?",
  },
  run = fresh(open),
})

rex.action({
  name = "worktree_remove",
  title = "Remove Worktree",
  category = "Worktrees",
  description = "Remove a git worktree and close its tabs. Its branch is kept.",
  keywords = "git branch delete",
  args = {
    branch = "string?",
    path = "string?",
    cwd = "string?",
    force = "boolean?",
    keep_caller = "boolean?",
  },
  run = fresh(remove),
})

rex.action({
  name = "worktree_list",
  title = "List Worktrees",
  category = "Worktrees",
  description = "List a repository's git worktrees and the tabs they're open in.",
  args = { cwd = "string?" },
  run = fresh(list_worktrees),
})

rex.action({
  name = "worktree_remove_current",
  title = "Remove This Tab's Worktree",
  category = "Worktrees",
  description = "Remove the worktree of the active tab and close the tab. Refuses uncommitted changes.",
  keywords = "git branch delete",
  run = fresh(function(ctx)
    return remove(ctx, { path = current(ctx).path, keep_caller = false })
  end),
})
